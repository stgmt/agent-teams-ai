# Team Provisioning Feature

The selected implementation replaces `TeamProvisioningService` and its
provisioning hierarchy with explicit composition and one lifecycle state owner.
The current production wiring is still present while this replacement is built;
it is not an alternate execution route in the target design.

## Full replacement in progress (B + C)

The selected target replaces the complete provisioning hierarchy rather than
retaining its algorithms as an alternate execution route. This work is not yet a
finished cutover. The following new components are implemented and tested in
isolation; existing production team services do not use them yet:

- `MemberLifecycleRegistry`: configured membership, desired state, team/member
  resource preparation/release, failures and process observations in one versioned
  snapshot, fenced by app/root/connection/run/member generation. Cleanup failure
  remains visible even during intentional stop; replacement/recovery requires exact
  member release. Team release cannot hide member resource debt. Its aggregate state
  uses current processes only: a previously connected process that exits cannot
  remain ready or return to a pending join. Its `watch` feed publishes that same
  immutable snapshot/version, coalesces synchronous transitions and keeps one latest
  value per consumer. Reads never advance state, slow consumers cannot accumulate
  an unbounded history, and returning the iterator releases the subscription. The
  native composition exposes this feed without registry mutation capabilities;
  actual transport/UI consumers are not switched yet.
- `MemberLifecycleCommands`, `TeamLifecycleCommands` and `TeamOperationQueue`:
  idempotent member/team starts and intentional stops. Configuration loading and
  process termination do not hold the operation gate. Team stop marks every
  member intentionally stopped and revokes lead authority before awaiting exits.
  Manual member restart names the observed run and generation, shares concurrent
  requests and waits for the exact process/resource release before admission. A
  delayed command cannot stop its successor or target the lead; member/team stop,
  removal and connection invalidation revoke replacement. Cancellation physically
  drains the original termination before root/team release. `member_start` cannot
  preempt a pending restart, even after release events arrive before stop settles.
  Skipping a failed startup names the same exact observed generation. It requires
  exit and resource release, keeps the configured member and failure evidence,
  disables recovery for that attempt and excludes it from readiness for this launch.
  A previously connected attempt, live process, cleanup debt or pending restart
  cannot be hidden by skip. Repeated skip is write-free; a later explicit start or
  successor run clears the per-launch marker. Late observations from a released,
  skipped attempt cannot overwrite its evidence.
- `TeamLifecycleCommands.shutdown`: permanently closes application-level start
  admission in that same registry, marks every owned run intentionally stopped and
  revokes its lead credential before awaiting work. Queued launch/member-start cannot
  overtake the barrier. Read-only roster loading can cancel; mutating preparation,
  late spawn, exact handle termination and resource cleanup physically drain. All teams
  are awaited even when one fails; failures retain their owner/evidence and an exact
  shutdown retry releases only remaining resources. Concurrent shutdown requests share
  the operation, while repeated successful shutdown is write-free. Native composition
  exposes this main-process shutdown port for eventual root replacement without
  requiring an already-closed external context to admit another command. Tests use
  controlled races and real temporary Node children, including another owner remaining
  writable; they do not prove descendant/crash containment or connect desktop shutdown.
- `LeadMemberStartAuthority` / `StartBoundMember`: one server-issued credential
  per exact run; the request cannot select another team, provider or OS command.
- `NodeMemberRuntime`: owned child handles, generation-bound input, immediate OS
  exits and separate resource-release observations. Registration/cleanup failures
  remain visible in the authoritative snapshot. Replacement waits for release.
  Native launches have a bounded initial connection deadline; exact readiness
  clears it, explicit lead/member bootstrap failure terminates the owned attempt.
  Explicit stop and observation failure share one handle-bound termination attempt:
  SIGTERM, a bounded grace period, then SIGKILL and a bounded wait for the real OS
  exit. Windows treats both signals as abrupt termination; no graceful Windows
  shutdown is implied. A missed termination deadline reports failure without
  releasing live resources or admitting a replacement; an exact stop can retry.
  Process-exit deadlines never time out or skip pending registration/cleanup.
  Cleanup failures retain the exact attempt's release capability, including setup
  failures before spawn. Concurrent retries share one attempt; only successful
  release is permanent. MCP config removal rejects exhausted retries rather than
  claiming that a credential file was removed. Even a rejected late process handle
  is subscribed through its exact exit/release; those observations cannot change
  the accepted process. A prior runtime failure stays in the snapshot but cannot
  create cleanup debt after exact exit and successful release.
- `NodeTeamDefinitionStore`: canonical team/member intent, explicit unresolved
  drafts, exclusive creation and ownership-checked rollback. The existing draft
  entrypoint now delegates here; no model is asked to create a team.
- `NodeTeamLaunchSettings`: strict complete canonical metadata reads, immutable
  nested MCP policy and cancellation that cannot retain a cancelled capture.
- `NodeTeamWorkspace`: validates shared directories and owns persistent Git worktrees
  for configured named team workspaces and isolated members. Team allocation resolves
  before runtime configuration and provider preparation; the lead/default shared members
  use that directory, isolated members derive from its local HEAD, and an explicit member
  directory is retained. Paths and branches include exact repository/team/name identity,
  so case-distinct and slash/dash names cannot collide through their readable prefix.
  New allocation starts at the selected local commit, without fetching a remote default.
  Reuse preserves the current branch, index, working files and untracked files; retained
  branches reattach without reset. It searches no previous directory layout, copies no
  local settings, and never removes team/member work on process stop. Shared named
  workspaces are revalidated before each member attempt, including the current branch.
  The resolved directory, branch and one explicit team task-ledger directory reach the
  native child. Registration records the worktree with the exact attempt. Managed Git
  commands disable checkout hooks and filesystem-monitor execution for that command
  only, without rewriting repository settings. Parent Git directory/index selection
  cannot redirect allocation into another repository. Cancellation physically drains
  started allocation; a completed worktree remains available to the next request, but
  cancelled/stale captures cannot bind it to a successor. The required workspace-trust
  dependency runs before provider facts/model probes, authentication artifacts or spawn;
  refusal/cancellation reaches the same lifecycle snapshot. It uses direct verified
  Claude profile state and exact Codex runtime settings, never a second model process.
  Filesystem replacement races, checkout filters, failed partial Git allocation and
  actual provider acceptance are not yet covered.
- `NodeNativeTeamConfig` / `NativeTeamConfigStore`: materializes the captured roster
  before provider preparation, preserves history, binds one run claim and uses the
  pinned CLI's `.config.lock` protocol. Foreign/unreleased processes fail closed;
  no PID probing or termination is performed by a configuration write.
- `NativeConfiguredProvider`, `NativeClaudeLaunchPlanner`,
  `NodeNativeLaunchArtifacts`, `NodeNativeMemberRegistration` and
  `NativeRuntimeConnection`: explicit Anthropic/Codex/Gemini preparation through
  the pinned native runtime, lead-only bootstrap, direct configured member
  processes, private attempt files and exact
  child/run/token/hash proof correlation. The proof envelope was rechecked against
  the pinned v0.0.145 producer in `src/hooks/useInboxPoller.ts` and
  `src/utils/swarm/teammateRuntimeEvents.ts` of the runtime source.
- `createNativeProviderPorts`: focused provider environment, identity and runtime
  settings composition without a provisioning host. The selected profile pins home,
  credential paths and the native OAuth state-file namespace before shell discovery,
  provider enrichment, writable preparation and the final child environment. The
  same factory supplies native workspace trust from that frozen profile/environment;
  the lifecycle cannot independently select a different trust file. Claude hooks,
  Codex turn-settled environment, writable preparation and the bound control URL must
  succeed; an uninstrumented launch is not produced. Synthetic provider tests also
  materialize real temporary runtime settings/trust files; they do not invoke a model
  or prove provider acceptance.
- `nativeTeamTaskLedgerProjectDirectory` / `NativeTeamTaskLedgerReader`: launches and
  current-format task-change reads use one application-owned directory under the
  exact selected teams root, shared by lead/members/worktrees. Parent environment
  values cannot redirect it; no project hash or transcript discovery selects the
  journal. The context-bound reader rejects absent runs, stale contexts and results
  crossing run replacement. It calls the reusable reader's current-format method,
  not its older bundle wrapper. Existing application task/log readers are not yet
  switched; offline/historical reads and session/transcript directory resolution
  remain part of the production cutover.
- `NodeTeamLaunchSettings`: requires one absolute teams root for both canonical
  documents. Native composition supplies that same root to runtime config and
  process registration. Private startup messages explicitly use it too; a foreign
  default profile is neither read nor written. Missing selected metadata rejects
  even when the foreign profile has a valid team. Admission validates exact names
  before file reads. A configured named team worktree cannot resolve member launches
  before its application-owned preparation succeeds. The bound workspace is copied,
  frozen and checked against the same capture/revision after allocation; cancellation
  or canonical changes cannot attach a late result. Cross-file atomic revisions and
  filesystem races remain open.
- `SendLeadMessage`: selects the configured current lead, detaches attachment input
  and rechecks its process generation after payload preparation. Native composition
  validates attachment bytes/budgets and reuses provider-native structured encoding.
  Pipe delivery is not model acknowledgement or complete attachment acceptance.
- `createBoundLifecycleQueries`: read-only access to the same snapshot/feed, bound
  to the exact application/root/connection generation. Idle subscriptions do not
  hold a root admission; generation invalidation immediately detaches their source
  and rejects pending reads, even without another process event. No absent run is
  invented from persisted bootstrap history.
- `registerLifecycleSnapshotHttp`: versioned read behind the existing desktop
  Host/Origin guard, requiring the bound context header. Unknown query fields and
  stale contexts reject; reads never repair or launch a runtime.
- `registerLifecycleIpc`, `createTeamLifecycleBridge`, `watchTeamLifecycle`: main-frame,
  current-window and document-owned pull subscriptions. Only plain values and an
  opaque subscription ID cross contextBridge. At most 32 subscriptions per document,
  one pending pull per subscription and one latest source value; navigation,
  renderer loss, explicit return and adapter disposal detach the feed. A concurrent
  pull rejects without closing the original waiter. EventEmitter fixtures verify
  the ownership boundary, not packaged Electron delivery.
- `createBoundLifecycleCommands`: exact context-bound configured launch, stop and
  observed-generation member restart and failed-startup skip.
  The existing lifecycle operation gate selects one app-owned run before canonical
  settings are read; concurrent requests share that run. Repeating launch neither
  re-reads settings nor recovers an exited member. A successor is admitted only after
  exact release. Stop requires the observed run ID, and its identity is checked
  inside the same gate, so a delayed stop cannot terminate the successor. Context
  invalidation cancels a blocked roster read and lets root admission drain.
- `registerLifecycleCommandsHttp`, `registerLifecycleCommandsIpc`,
  `createTeamLifecycleCommandBridge`: the same commands behind the desktop
  Host/Origin guard or current-main-frame IPC. Launch cannot choose a run, provider,
  member or working directory; stop accepts only its run ID. Restart accepts only
  run ID, configured member name and observed generation; skip uses the same exact
  target through `POST /api/team-runtime/:teamName/skip-member` and
  `skipConfiguredMemberForLaunch` on the plain-value bridge. Conflicts return HTTP 409.
  No provider/model/command/directory override is accepted. Neither transport
  returns the lead credential. Native composition uses these commands for its
  canonical settings/configuration path, but the desktop roots are not switched.
- `registerMemberLifecycleHttp`: credential-bound HTTP input, independent of
  caller-provided actor names; context mismatch remains HTTP 409. Guard integration
  is tested. The desktop production root has not registered these new transports.

`createMemberLifecycle` composes the commands; `createNativeTeamLifecycle`
composes native configuration, preparation, process admission and text input without
exposing its internal registry/team mutation entrypoints or the lead credential in
its public launch receipt. Cancellation waits for mutating preparation and releases
the claim before a replacement is admitted. Registration/exit cleanup covers the
lead and teammates with the same config lock and exact attempt identity.
`resolveLeadCredential(credential)` is a synchronous, main-process composition port
for consumers such as lead reporting. It resolves the existing scoped MCP capability,
checks the current connection context/run and running intent, and returns the frozen
run identity without creating credentials, mutating the snapshot or holding a root
lease. Stop revokes that same capability; a successor cannot inherit it. No authority
mutation API is exported. `queries.snapshot` still accepts `{ expectedContext, teamName }`;
callers requiring an exact run must also compare the returned identity. Task changes
use `{ expectedContext, teamName, taskId, projectPath?, includeDetails }`.

The native planner denies built-in `SendMessage` for the lead before launch, so a lead
must publish through the application-owned MCP path. Member-to-member native messaging
is not disabled. Provider arguments cannot override the tool policy. These argument and
composition checks do not prove actual CLI enforcement. The main-process
`createNativeLeadReporting` composition now connects reporting to exact persisted
human requests and durable reply closure; the desktop root and compaction inputs
still require the coherent production cutover.

`DeliverPersistedLeadRequest` registers the original request before report admission:
admission itself may durably publish a bounded source limitation. That completion
returns `delivered` without sending a duplicate stdin turn. Otherwise the exact saved
text, app-issued request ID and reporting instruction reach the existing owned-process
input port. Pipe completion returns only `sent`; it never closes a human request or
admits its successor. A failed uncertain write is not automatically resent. Concurrent
retries share the same operation, and ownership is checked after asynchronous reads,
admission and input completion.

`NodeLeadRequestHistory` owns persistence and exact reads in the selected canonical
`teams/<team>/sentMessages.json`: exact ID, configured lead recipient, `from: user`,
`source: user_sent`, and exact run. `submitHumanRequest(run, requestMessageId, text)`
saves the original under the existing canonical file-lock protocol before reporting
admission or stdin can observe it. Exact retries do not append another row; an ID
collision with changed text, another run or a non-original record rejects without
rewriting the history. Concurrent appends retain previous rows, corrupt history is
not treated as empty, and size limits reject rather than truncate prior messages.
Ownership is rechecked immediately before atomic commit. The adapter does not search
other profiles or inbox copies. Malformed, oversized, ambiguous, redirected,
hard-linked, service, relay, group and slash-command records reject.
Attachment-bearing requests currently reject explicitly rather than silently losing
their files. The composition reuses existing credential, lifecycle-query and
task-change ports; no second process or credential owner is created.

Only the app publisher's exact durable delivery callback closes a live request.
A fresh or evicted completed entry can be restored from a matching app-owned explicit
reply in the canonical user inbox without repeating admission or stdin. Completed cache
entries can be retired after 200 retained requests; 200 is not a lifetime conversation
limit. Admission retries with pending publisher notification still go through reporting
closure, not through the persisted-reply shortcut. Real temporary history/controller/
inbox tests cover this composition, not the production queue or native model runtime.
`NodeLeadInputDeliveryStore` reserves the original human turn before report admission,
then persists its exact input intent before stdin under the existing canonical file-lock
protocol. Distinct requests are serialized under one admission lock; a new composition
cannot admit a different saved question until the original has its exact durable reply.
A failed provisional reservation does not leave an in-memory request blocking a later
valid retry. The reserved state itself cannot be marked sent without an input claim.
One operation can claim it; another composition
sees `unconfirmed` and cannot resend. A completed write is persisted as `sent`, still
not a reply. The metadata binds the full run/request identity and original-text digest;
it stores no duplicate human text, rejects changed or corrupt evidence, and never
discards an uncertain operation to try again. Fresh-composition tests confirm no second
write for sent or uncertain input, plus eventual closure by the exact durable reply.
These tests recreate adapters over real temporary files; they do not crash Electron,
prove power-loss durability or recover an owned OS process. The native lifecycle does
not currently resume an old app instance's run.

`createBoundHumanRequestSubmission` admits this operation through the existing
application/root/connection context fence. It accepts only the exact observed run,
request ID and original text; provider/model/directory, service-origin flags,
attachments and lead credentials cannot alter this text-only admission boundary.
It detaches the input before awaiting admission and keeps the root fence until the
physical persistence/input operation settles, including after context invalidation.
An invalidated completion returns `APP_CONTEXT_MISMATCH`, not a stale success.
`registerHumanRequestSubmissionIpc` and `createLeadHumanRequestBridge` carry only
plain request/receipt values from the current main renderer and main frame. Destroyed,
replaced or disposed senders reject before admission. No human-origin submission HTTP
route or lead MCP capability is added: connection identity alone is not authority for
a model to invent a human question. IPC fixtures verify this boundary, not actual
Electron isolation. A cross-layer test executes the real canonical history and
reporting/controller/inbox through that bridge, including exact retry, reply and
successor ordering, with controlled lifecycle input.

The main-process composition now supplies persist-before-admission submission;
`deliverPersistedHumanRequest` remains the exact saved-record delivery operation.
The ordinary desktop entrypoint has not switched to this composition. Complete
attachments, compaction refresh and production queue/root wiring remain unfinished.
Restoring delivery metadata is not permission to replay it into a successor run.

Desktop launch production wiring, complete attachment admission and inbox relay,
provider/workspace parity, transport/UI projections and deletion of the replaced
hierarchy remain pending. Only canonical draft creation has switched so far.
Native process birth IDs are currently in-memory ownership tokens, not
OS-verifiable persisted crash-recovery evidence.
Synthetic proof and Node-process tests are not actual CLI/provider acceptance.
The separate early desktop entrypoint already places application ownership before
eager application imports; packaged Electron/singleton acceptance is tracked
separately from the provisioning cutover.

## Run registry read port

`TeamRunRegistryRead` (exposed as `NativeTeamLifecycle.runs`) answers run
identity and liveness only:

| Method                 | Answer                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| `find(teamName)`       | registered run snapshot, including a stopped run kept as history               |
| `findByRunId(runId)`   | registered run by id; used by cancel and status                                |
| `hasRun(run)`          | full identity match (app, root, connection, team, run)                         |
| `isLive(run)`          | registered and still owning the run: running, not released, not release-failed |
| `aliveTeamNames()`     | teams with at least one configured member owning a process                     |
| `aliveRunId(teamName)` | current run id only while such a process exists                                |

Non-goals, on purpose:

- no run payloads (`pendingApprovals`, `claudeLogLines`, `detectedSessionId`,
  relay `child`, reply hints); those consumers keep their own run-scoped state
  until a dedicated port exists, so the registry cannot become a second one;
- no mutation or retirement: a stopped run stays registered as history, and a new
  run for the same team replaces the entry, so memory stays bounded by team count;
- no context fencing: the facade is composition-internal. IPC/HTTP consumers use
  `LifecycleQueries`, whose every method is fenced by the expected
  `AppConnectionContext`.

Liveness is current-process evidence only (`process !== null`, configured
membership). A crash that produces no exit event leaves the run live until a
reconcile/stop path observes it; OpenCode secondary-lane liveness is a separate
phase 6 gate.

`toTeamProvisioningProgress` derives `TeamProvisioningProgress` from the same
snapshot for the launch progress stream and status reads. It stores nothing, so a
run that left the registry has no progress until native progress persistence
lands in the recovery phase.

`createDesktopTeamRuntime` is the lifecycle-facing production adapter built on
this snapshot: create/launch persist the canonical definition first, progress
streams from the run feed, stop/cancel name the exact run, and runtime reads use
the registry. It is composed and tested but not yet wired into IPC/HTTP; the
transport cutover is phase 8.

## Existing production slices awaiting replacement

The sections below describe the still-connected implementation, not patterns for
extending the selected replacement. The target must remove these replaced routes;
it must not retain them as alternate execution paths.

### Status query

`getProvisioningStatus` is the first complete walking slice:

```text
IPC / HTTP
  -> TeamProvisioningService compatibility facade
  -> TeamProvisioningStatusApi
  -> GetProvisioningStatusUseCase
  -> ProvisioningStatusReaderPort
  -> LegacyProvisioningStatusReaderAdapter
  -> existing progress state owner
```

The use case owns the `Unknown runId` application rule. The adapter only maps the
narrow reader port to the current state owner and receives explicit dependencies;
it never receives the whole provisioning service.

## Extending the replacement

1. Define or reuse a stable contract under `contracts/`.
2. Add a use case and only the ports it consumes under `core/application/`.
3. Implement process, provider, filesystem or transport adapters under `main/`.
4. Construct the capability explicitly under `main/composition/`.
5. Replace its production callers and delete superseded orchestration/state rules.
6. Add focused use-case, adapter, composition and public-parity tests.

Do not add empty folders, whole-service casts, facade inheritance or a second
execution route. General feature boundaries are defined in
`docs/FEATURE_ARCHITECTURE_STANDARD.md`.

The renderer entrypoint also exposes `MemberSettingsRelaunchDraft` and its draft
projection/validation helpers. Member settings pass configured intent and the
original target fingerprint through `TeamMemberSettingsDialogBridge` to the
existing launch dialog. These helpers do not persist settings; submission uses
the existing replace-members/launch sequence, with fresh roster checks before
replacement (and before stopping a live team).

For a settings-originated relaunch, the optional `memberSettingsRelaunch` field on
`ReplaceMembersRequest` carries the target and roster fingerprints into the
existing IPC mutation gate. `persistNodeMemberSettingsRelaunch` validates this
intent and composes the existing member repository and team metadata store.
The config lock covers conflict checks, configured member writes and rollback;
lead model/effort also update saved launch defaults and launch identity. This
bounded path keeps the roster identity unchanged; add/remove members separately.
Ordinary replace-members requests retain their existing behavior. HTTP mode
already rejects replace-members and gains no new support in this repair.

The settings editor captures the opaque `getSavedRequest().savedSettingsFingerprint`
when it opens. The relaunch intent carries that token unchanged, alongside member
fingerprints. Persistence compares saved model, effort, provider, launch identity
and inherited launch defaults before writes, then rechecks defaults inside the
lead metadata update. Missing tokens fail closed. The mutation boundary also
checks the existing `hasProvisioningRun` query, because a configuring successor
has not yet become an alive team.

Settings roster projection uses the same canonical legacy-lead classification as
member settings. Canonical metadata launch discovery also excludes those leads.
Native launch setup carries `configuredMemberSpecs` separately through run and
spawn orchestration to `persistDeterministicLaunchMetadata`. The synthetic request
and effective specs still construct runtime behavior; the writer uses configured
model/effort/provider/backend/fast-mode fields while retaining effective workspace
materialization and existing tombstone handling. Metadata discovery carries backend
and fast-mode selections so explicit siblings survive the same round trip.

After completion, `config.json` retains effective provider/model/effort for runtime
consumers. `TeamMemberResolver.configuredRuntimeSettings` and
`LegacyMemberSettingsRepositoryAdapter` instead read provider/model/effort/backend/
fast-mode from the matching canonical `members.meta.json` row. An absent field on
that row means inheritance; it must not fall back to effective config. For legacy
members with no matching metadata row, config remains the configured source
(including its legacy `provider` alias). Metadata for another member does not
change that compatibility policy. The resolver keeps configured backend selections
separate from effective backend resolution.

`MemberSettingsRelaunchFiles.test.ts` executes completion's real
`applyEffectiveLaunchStateToConfig`, reopens files with fresh stores and the actual
member resolver/editor projection, and resubmits settings with a changed lead
default through persistence and launch setup again. It checks both effective
runtime values and durable absence of cleared/inherited overrides alongside an
explicit mixed-provider/backend/fast-mode sibling.
