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
| `sendMessageToTeam`                                   | native (process lead)     | `NativeTeamMessagingApi`; process lead only; lane-lead delivery blocked; attachments fail-closed                         |
| `relayLeadInboxMessages`                              | native (transport proof)  | `NativeLeadInboxRelay`: process lead, batched prompt to stdin, read commit after write                                   |
| lane/OpenCode lead delivery                           | native (lead inbox, text) | system text becomes a lead inbox row delivered by the member relay; attachments and direct prompt delivery stay blocked  |
| `relayOpenCodeMemberInboxMessages`                    | native (delegated ledger) | `NativeTeamMessagingApi` injects the retained OpenCode delivery ledger as a non-owning port; unconfigured => fail closed |
| member inbox relay (internal)                         | native                    | `NativeMemberInboxRelay` batches unread rows into a lead forward prompt; `startRelays` polls both relays                 |
| `getOpenCodeRuntimeDeliveryStatus`                    | native (delegated ledger) | read through the same injected delivery ledger port; fail closed when unconfigured                                       |
| `resolveRuntimeRecipientProviderId` / lead session id | native                    | `NativeTeamMessagingApi` (lane session only)                                                                             |
| live lead messages / push                             | blocked                   | legacy run payloads                                                                                                      |
| cross-team reply metadata / expectations              | blocked                   | legacy conversation correlation                                                                                          |

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
