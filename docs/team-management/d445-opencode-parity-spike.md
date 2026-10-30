# D-445 OpenCode parity spike (phase 6a)

Status: **NO-GO for the phase 8 cutover until one of the options below is accepted.**
Date: 2026-10-30. Branch: `refactor/team-provisioning-single-owner-20261028`.

## Question

Can the native lifecycle own OpenCode teams with the same single-owner rules it
already applies to Claude/Codex/Gemini, or does OpenCode require a second
authority?

## Evidence

| Fact                                                                  | Evidence                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native launch accepts only `anthropic`, `codex`, `gemini`             | `src/features/team-provisioning/main/infrastructure/nativeRuntimeProvider.ts:4-8`                                                                                                                                  |
| The native planner rejects `opencode` before preparing anything       | `src/features/team-provisioning/main/adapters/output/NativeClaudeLaunchPlanner.ts:127`; tests `test/features/team-provisioning/main/nativeConfiguredProvider.test.ts:234`, `nativeClaudeLaunchPlanner.test.ts:324` |
| Native member liveness is an owned OS process (`pid` + `birthId`)     | `src/features/team-provisioning/contracts/lifecycle.ts:20-23,46`; registry `observeSpawn`/`observeExit`; `MemberLifecycleSnapshot.process`                                                                         |
| Native commands start/stop/restart that process handle                | `src/features/team-provisioning/core/application/commands/MemberLifecycleCommands.ts`; `NodeMemberRuntime` spawns the CLI and returns the pid                                                                      |
| OpenCode is launched through a lane adapter, not a per-member process | `src/main/services/team/runtime/TeamRuntimeAdapter.ts:75-115` (`TeamRuntimeLaunchInput.laneId`), `:164-174` (per-member launch evidence), `:184-204` (`reconcile` with `laneId`)                                   |
| OpenCode stop is lane-scoped and evidence-based                       | `TeamRuntimeAdapter.ts:208-231` (`TeamRuntimeStopInput.laneId`, `TeamRuntimeMemberStopEvidence`)                                                                                                                   |
| The DTO already models lanes/shared hosts, the lifecycle does not     | `src/shared/types/team.ts:1136-1170` (`laneId`, `laneKind`, `runtimeLoadScope: 'shared-host'`)                                                                                                                     |
| The legacy path routes pure OpenCode requests to the adapter          | `src/main/services/team/provisioning/TeamProvisioningRuntimeBootstrapDelivery.ts:16-24`; orchestration `TeamProvisioningCreateLaunchOrchestration.ts:220-222`                                                      |
| OpenCode liveness can come from a shared host pid, not a member pid   | `src/main/services/team/provisioning/TeamProvisioningRuntimeSnapshot.ts` (`metricsPid`, `isSharedOpenCodeHost`)                                                                                                    |

## Gap

The native registry answers "is this member alive?" from `member.process !== null`.
OpenCode answers with adapter evidence: a lane id, a member session, and a shared
host pid that several members may share. A lane can be alive while no member owns
a process, and one process can back several members. Therefore:

1. `MemberLifecycleSnapshot` has no lane identity, no session id and no
   adapter-observation state.
2. `MemberRuntimePort` has no `reconcile`/`answerPermission`/`listPermissions`
   operations.
3. `TeamLifecycleCommands.stop` releases processes and files; it cannot stop a
   lane without an adapter call.
4. `toTeamAgentRuntimeSnapshot` would report `alive:false` for a live OpenCode
   member because `process` is null.
5. Restart/retry semantics differ: an OpenCode lane restart is adapter-driven and
   may preserve the shared host.

## Options

### A. Add lane ownership to the native lifecycle (recommended)

- `MemberLifecycleSnapshot` gains `lane: { laneId, sessionId?, hostPid? } | null`
  and an `observation: 'process' | 'adapter'` source; liveness becomes
  `process !== null || (lane !== null && adapterObservation === 'alive')`.
- `MemberRuntimePort` gains `reconcile(run, laneId)` and lane stop; a reconcile
  event updates the registry exactly like `observeExit` does today.
- `TeamLifecycleCommands.stop` stops lanes through the same exact-run/exact-
  generation fence.
- Projection maps lane fields into `TeamAgentRuntimeEntry` (`laneId`,
  `laneKind`, `runtimeLoadScope: 'shared-host'`).
- Tests: lane alive without a pid, shared host pid across members, lane stop,
  reconcile unavailable, restart semantics, projection parity.

Cost: one phase of registry/commands work plus an adapter port; no legacy route.
Risk: the liveness model becomes two-sourced, so every command must name the
observation source; a stale reconcile can report a dead lane alive (needs the
same version/generation fence as processes).

### B. Keep a permanent legacy owner for OpenCode teams

- Native lifecycle owns Claude/Codex/Gemini teams; the legacy provisioning
  service owns OpenCode teams.
- Cutover switches only non-OpenCode launches and rejects OpenCode with an
  explicit "not migrated" error.

Cost: small now, permanent split authority; two run registries, two stop paths,
two progress owners. It contradicts D-445's single-owner requirement and keeps
the 92-member legacy surface alive for one provider.

### C. Drop OpenCode team launch

Not acceptable: `opencode` is a shipped provider and the adapter path is actively
used.

## Progress

- 6a.1 (landed): `MemberLaneObservation` in the lifecycle contract, registry
  `observeLane`/`observeLaneLost`, lane-aware liveness in `aliveTeamNames`/
  `aliveRunId`/`teamLifecycleState`, and projection to `laneId`,
  `runtimeLoadScope:'shared-host'`, `pidSource:'opencode_bridge'`,
  `permission_blocked`/`runtime_pending_permission`, `runtime_pending_bootstrap`.
  A lane member is never reported with a member pid and is not restartable yet.
- 6a.2 (partial): `MemberRuntimePort` distinguishes `process`/`lane` providers and
  gains `startLane`; `MemberLifecycleCommands` starts, observes (`laneObserved`),
  loses, writes to and stops an adapter lane through the same exact-token fence
  as a process. A provider that answers `lane` without an implementation fails
  the attempt explicitly instead of spawning a process.
- 6a.2 finding: the real adapter is **lane-scoped, not member-scoped**. In
  `pure_opencode` mode one primary lane hosts the whole roster
  (`planTeamRuntimeLanes.ts:231`), and only distinct-model/root members get
  `secondary:opencode:<name>` lanes (`:219-223`). A per-member `startLane` can
  drive a secondary lane, but the aggregate primary lane must be launched once
  with all of its members and then bind per-member evidence to tokens.
- 6a.2 review fixes (landed): a fully live lane roster now reaches
  `state:'ready'` (`memberIsLive` in readiness); member/team release requires
  `lane === null`; `beginStart` on a live lane answers `already-running`; lane
  `released` is authoritative and clears a lane that never reported `laneLost`;
  failed lanes project as `error`, not `waiting`; a live lane blocks team
  replacement and recovery/skip require lane release.
- 6a.3 (landed): team-level lane groups. `TeamLifecycleCommands` accepts a
  `laneGroups` planner, validates lane membership (configured, no duplicates) and
  launches each group once through `MemberRuntimePort.startLaneGroup`; process
  members still start individually. `MemberLifecycleCommands` binds per-member
  observations/events, routes input through the group, stops the group once, and
  rejects a single-member restart of a shared lane until lane restart is designed.
- 6a.3 review fixes (landed): duplicate lane ids and a changed lane plan on
  retry are rejected; a missing per-member observation fails the whole group; a
  resolved group stop is authoritative even without a release event; a partial
  observation failure rolls back applied lanes or leaves the release debt
  visible.
- 6a.4 (landed): `NativeOpenCodeLaneRuntime` over `TeamLaunchRuntimeAdapter`.
  Maps settings/tokens to `TeamRuntimeLaunchInput`, maps per-member evidence to
  `MemberLaneObservation` (session, shared host pid, bootstrap, permission block,
  hard failure), launches one lane per group, reconciles on an interval, stops
  the lane, and rejects stdin input because OpenCode delivery belongs to the
  inbox relay. Missing evidence stops the lane before failing the launch.
- Remaining before A is complete: compose the lane runtime into the production
  lifecycle (provider routing + adapter registry), permission answer/list,
  lane restart semantics, and recovery after app restart. The legacy OpenCode
  route is not deleted until these land.

## Recommendation

Take **A** and treat it as the phase 6a gate. Do not switch the production root
before lane ownership lands: a cutover that silently reports OpenCode members as
offline is worse than the current state.

Minimum acceptance for A:

- a live OpenCode member is `alive:true` with `livenessKind:'runtime_process'`
  and `laneId`, without inventing a member pid;
- a stopped lane is `alive:false` and restartable only through the adapter;
- shared-host members do not multiply the host pid into per-member pids;
- stop/restart/cancel still name the exact run and generation;
- the legacy OpenCode route is deleted in the same cutover, not kept as a
  fallback.
