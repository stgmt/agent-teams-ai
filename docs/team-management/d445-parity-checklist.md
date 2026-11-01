# D-445 parity checklist (phase 6b/8 gate)

Status: living checklist. `native` = implemented and tested in the feature;
`legacy` = still owned by the old service; `blocked` = needs protocol or product
work before cutover. No row may be silently omitted from the cutover commit.

## Provisioning start/status/run

| API                                                        | Status                           | Evidence                                                                                |
| ---------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `createTeam` / `launchTeam`                                | native                           | `createDesktopTeamRuntime`, `NativeTeamLifecycle`                                       |
| progress stream                                            | native                           | `nativeTeamProgressProjection`                                                          |
| `getProvisioningStatus`                                    | native first + persisted history | `toTeamProvisioningProgress`, `progressHistory`                                         |
| `cancelProvisioning` / `hasProvisioningRun`                | native                           | `DesktopTeamRuntime`, provisioning states                                               |
| `preflight` (`getCliHelpOutput`, `prepareForProvisioning`) | legacy                           | CLI install/prepare path is independent of run ownership; keep as a pure service        |
| `taskActivity.repair...`                                   | adapter ready                    | `NativeTaskActivityRepair`; needs the legacy `repairOnce`/snapshot ports at composition |

## Runtime/member

| API                                                                                  | Status                     | Evidence                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRuntimeState` / `stopTeam` / `isTeamAlive` / `getAliveTeams` / `getCurrentRunId` | native                     | `DesktopTeamRuntime`                                                                                                                                                            |
| `getMemberSpawnStatuses`                                                             | native                     | `createBoundTeamLiveStatusQueries`                                                                                                                                              |
| `restartMember` / `skipMemberForLaunch`                                              | native (exact generation)  | `NativeTeamMemberLifecycleApi`                                                                                                                                                  |
| `attachLiveRosterMember`                                                             | native (configured member) | re-admits saved settings (only the target member may drift), adds/restores the registry member and config projection; lead rejected; `member_updated` restarts the live runtime |
| `detachLiveRosterMember`                                                             | native (data port)         | stops the member, removes the registry entry and calls `detachMemberData`; shared lanes and lead rejected                                                                       |
| `retryFailedOpenCodeSecondaryLanes`                                                  | native (secondary lanes)   | failed groups restart via `restartLane`; lead lane needs relaunch                                                                                                               |
| `runLiveRosterMutation` / `tryRunLiveRosterMutation`                                 | pass-through               | serialized by the team operation gate; attach/detach/restart are the only live roster mutations                                                                                 |

## Diagnostics/logs/approvals

| API                                      | Status                      | Evidence                                                                                               |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `getTeamAgentRuntimeSnapshot`            | native                      | `NativeTeamDiagnostics` + live status port                                                             |
| `getClaudeLogs`                          | native (in-memory, bounded) | `NativeTeamClaudeLogs` + `NativeTeamLogStore`                                                          |
| logs across app restart                  | native (last run)           | `NativeTeamLogStore` persists the last run to `native-logs.json` and reloads it on read                |
| `getLeadActivityState`                   | native (log tail)           | `NativeTeamDiagnostics` reads the newest stream-json event (active/idle/offline)                       |
| `getLeadContextUsage`                    | native (log tail)           | `NativeTeamDiagnostics` derives usage from the newest `usage` event; unknown models return null tokens |
| `respondToToolApproval` (OpenCode lane)  | native                      | `NativeTeamToolApprovalApi`                                                                            |
| `respondToToolApproval` (Claude process) | native                      | `NativeClaudeToolApprovals` ingests `control_request` and answers via stdin                            |
| `updateToolApprovalSettings`             | native (in-memory)          | `NativeToolApprovalSettings`                                                                           |

## Messaging/relay/cross-team

| API                                                   | Status                    | Evidence                                                                                                                 |
| ----------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `sendMessageToTeam`                                   | native                    | `NativeTeamMessagingApi`; process lead via stdin, lane lead via `LeadLaneInboxDelivery` + OpenCode ledger proof; attachments fail-closed |
| `relayLeadInboxMessages`                              | native (transport proof)  | `NativeLeadInboxRelay`: process lead, batched prompt to stdin, read commit after write                                   |
| lane/OpenCode lead delivery                           | native (ledger proof)     | `LeadLaneInboxDelivery` writes the lead inbox row, then prompts the lead session through the OpenCode ledger (`source:'ui-send'`, `onlyMessageId`) and fails loudly without delivery proof; the member relay cannot wake a lead |
| `relayOpenCodeMemberInboxMessages`                    | native (delegated ledger) | `NativeTeamMessagingApi` injects the retained OpenCode delivery ledger as a non-owning port; unconfigured => fail closed |
| member inbox relay (internal)                         | native                    | `NativeMemberInboxRelay` batches unread rows into a lead forward prompt; `startRelays` polls both relays                 |
| `getOpenCodeRuntimeDeliveryStatus`                    | native (delegated ledger) | read through the same injected delivery ledger port; fail closed when unconfigured                                       |
| `resolveRuntimeRecipientProviderId` / lead session id | native                    | `NativeTeamMessagingApi` (lane session only)                                                                             |
| live lead messages / push                             | partial; production capture remains legacy | `NativeLeadLiveMessageStore` is lifecycle-owned and cleared on run release; native stream capture/production composition is not wired yet |
| cross-team reply metadata / expectations              | native (binding is phase 8) | `NativeCrossTeamReplyLedger` owns the expectations and delivery proofs shared with `NativeLeadInboxRelay`; `NativeCrossTeamMessagingApi` (+`createNativeTeamCrossTeamApi`) resolves metadata, relays, and proves runtime delivery |
| `notifyLanguageChange`                                | native adapter, binding is phase 8 | `NativeLanguageChangeNotifier` takes the alive set from the native registry, reads config through the non-owning reader, sends through `NativeTeamMessagingApi`, and writes the language with a CAS update under the pinned `.config.lock`; the per-team policy stays the shared pure function |
| `hasLiveOpenCodeMcpConsumers`                          | native adapter, binding is phase 8 | `NativeMcpConsumerQuery` derives it from the registry: an OpenCode member is lane-backed (`member.lane !== null`; only `NativeOpenCodeLaneRuntime` produces lane observations), and a run in `preparing`/`starting` counts as a consumer, matching the legacy over-approximation for pending admissions |

Cross-team limitations kept explicit:

- Recipient identity is resolved from the native registry only; there is no
  second metadata store to reconcile against, and a removed member is
  tombstoned so a detached inbox cannot be relayed.
- Provider identity is read from launch settings before routing, so an
  unreadable provider fails closed instead of relaying an OpenCode member
  through the Claude lead path.
- Lead-recovery probes (`hasSuccessfulLeadRecoveryMessage`,
  `isLeadRecoveryMessage`) answer `false`: recovery nudges are still created by
  the legacy recovery path, so the native route omits `lastDelivery` rather than
  claiming recovery proof it cannot produce.

Known human-path gaps in the native messaging surface (phase 8/9 work, not
cross-team):

- `NativeTeamMessagingApi.sendMessageToTeam` accepts `userRequestMessageId` and
  drops it. Legacy registered the id so the lead's reply is linked to the user's
  message; native cannot yet, because reply linking needs native lead-output
  capture, which is still legacy (same gap as the live lead message row).
- `sendMessageToTeam` is also the human lead-message channel
  (`src/main/ipc/teams.ts` prefixes `Message from user:`). For an OpenCode lead
  it reaches `LeadLaneInboxDelivery`, so the lead sees that prefix plus a
  `source:'user_sent'` row. The phase 8 wiring should route human lead messages
  through the lane path analogous to the member path instead.
- A system notice relayed to a lane lead is written with `from:'user'`. App-owned
  notices elsewhere use `from:'system'` + `source:'system_notification'`
  (`TeamTaskStallNotifier`); `sendMessageToTeam` carries no origin, so the two
  shapes cannot be told apart yet.

## Data/settings

| API                                                                 | Status               | Evidence                                                        |
| ------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------- |
| team data (`listTeams`, `getTeamData`, saved request, draft rename) | legacy, independent  | `TeamDataService`; no run ownership                             |
| member settings update/relaunch                                     | feature slice exists | `createTeamMemberSettingsFeature` + native run identity fence   |
| tool approval settings                                              | native (in-memory)   | `NativeToolApprovalSettings`; persistence is a separate concern |

## Cutover sequence (phase 8)

1. Port the blocked messaging/approval/lead-payload rows or explicitly keep them
   behind a retained service **without** run ownership. A retained service that
   still owns runs recreates the split-brain D-445 forbids.
2. Compose `createNativeDesktopTeamRuntime` in `src/main/index.ts` with the real
   settings/provider/workspace/inbox/control/briefing/registry deps and startup
   recovery; assemble `TeamIpcHandlerApis` via `createNativeTeamProvisioningApis`
   and `TeamHttpHandlerApis` via `createNativeTeamHttpApis`.
3. Switch IPC/HTTP/preload/renderer to the native snapshot and human request
   ledger; remove `sendDirectToLead` from the human path.
4. Delete the legacy process-owning launch/stop/recovery code and the legacy
   OpenCode route; keep pure data/settings/preflight helpers per the ownership map.
5. Run the phase 9 acceptance matrix per provider in a sandbox project.
