# D-445 ownership map (phase 0)

Срез: 30.10.2026, `E:/tmp/pub/merge`, HEAD `7af4fa8338cf16ba38071ad21acaf65a59f9a00a`. Таблица по production-вызовам. Цель — отделить process-owning код от чистых чтений/настроек до cutover.

## 1. Точки входа

| Точка | Файл | Что делает |
|---|---|---|
| Создание сервиса | `src/main/index.ts:1951` | `createDefaultTeamProvisioningService(...)` |
| IPC bind | `src/main/index.ts:1971` | `bindTeamIpcHandlerApis(teamProvisioningService)` |
| HTTP bind | `src/main/index.ts:2830` | `bindTeamHttpHandlerApis(teamProvisioningService)` |
| HTTP routes | `src/main/http/index.ts:93` | `registerTeamRoutes` при `teamApis`/`teamDataApi` |
| Preload | `src/preload/index.ts:1001` | `createTeam`, `launchTeam`, `stopTeam` |
| Human message | `src/main/ipc/teams.ts:2935` | stdin send, затем `sendDirectToLead` (`:2956`) |
| Snapshot UI | `teamProvisioningService.getTeamAgentRuntimeSnapshot` | `src/main/index.ts:1957`, `:2020`, `:2454` |

## 2. Process-owning API

| API | Текущий владелец | Целевой владелец | Действие |
|---|---|---|---|
| `createTeam` | `TeamProvisioningService` | `NodeTeamDefinitionStore` + native `commands.launch` | replace |
| `launchTeam` | `TeamProvisioningService` | native `commands.launch` | replace |
| `cancelProvisioning` | `TeamProvisioningService` | native context cancel/stop | replace |
| `hasProvisioningRun` | `TeamProvisioningService` | native registry/watch | replace |
| `getRuntimeState` | `TeamProvisioningService` | native snapshot mapper | replace |
| `stopTeam` | `TeamProvisioningService` | native `commands.stop` | replace |
| `isTeamAlive` / `getAliveTeams` | `TeamProvisioningService` | native snapshot mapper | replace |
| `getCurrentRunId` | `TeamProvisioningService` | native snapshot mapper | replace |
| `getMemberSpawnStatuses` | `TeamProvisioningService` | native snapshot mapper | replace |
| `getTeamAgentRuntimeSnapshot` | `TeamProvisioningService` | native snapshot mapper | replace |
| `restartMember` | `TeamProvisioningService` | native `restartConfiguredMember` | replace |
| `skipMemberForLaunch` | `TeamProvisioningService` | native `skipConfiguredMember` | replace |
| `attachLiveRosterMember` / `detachLiveRosterMember` | legacy member settings adapter | **нет native-команды**; либо добавить attach/detach в native lifecycle, либо оставить legacy settings до parity | block until parity |
| `sendMessageToTeam` (lead human reply) | `TeamProvisioningService` | native `sendLeadMessage` + D-448 human pipeline | replace only this path |
| `sendMessageToTeam` (member/relay/work-sync/auto-resume) | `TeamProvisioningService` | отдельный native messaging port или legacy до parity | split, do not replace with sendLeadMessage |
| `deliverOpenCodeLaunchPromptToLead` | `TeamProvisioningService` | native/provider adapter | replace or block |
| `assessLeadRuntimeRestart` / `restartLeadRuntime` | `TeamProvisioningService` | native member restart + settings parity | replace only after provider/model parity |
| `relayInboxFileToLiveRecipient` | `TeamProvisioningService` | keep only if pure relay; иначе native relay | keep/replace after audit |

### 2a. Lifecycle reads (не mutation)

| API | Текущий владелец | Действие |
|---|---|---|
| `getRuntimeState` | runtime projection | read from native mapper |
| `getMemberSpawnStatuses` | launch state projection | read from native mapper; **не** `snapshotToMemberSpawnStatuses` для текущей жизни |
| `getTeamAgentRuntimeSnapshot` | runtime snapshot projection | read from native mapper |
| `hasActiveTeamRuntimes` | `TeamProvisioningService` | native mapper |
| `getAliveTeamNames` | run tracking | native mapper |
| `getCurrentRunId` | run tracking | native identity |
| `getAliveTeams` | run tracking | native mapper |

## 3. OpenCode (blocked until spike)

| API | Текущий владелец | Действие |
|---|---|---|
| `relayOpenCodeMemberInboxMessages` | OpenCode aggregate facade | keep until native parity; cutover blocked for OpenCode |
| `getOpenCodeRuntimeDeliveryStatus` | OpenCode runtime control | keep until parity |
| `retryFailedOpenCodeSecondaryLanes` | OpenCode aggregate | keep until parity |
| `scanOpenCodePromptDeliveryWatchdog` | OpenCode aggregate | keep until parity |
| `scheduleOpenCodeMemberInboxDeliveryWake` | OpenCode aggregate | keep until parity |
| `getOpenCodeMemberDeliveryBusyStatus` | OpenCode aggregate | keep until parity |
| `hasLiveOpenCodeMcpConsumers` | OpenCode aggregate | keep until parity |
| `relayLeadInboxMessages` | general lead relay | keep; not OpenCode-only |

Правило: OpenCode не остаётся fallback после cutover; либо native parity, либо cutover блокируется для OpenCode-команд.

## 4. Pure/config/diagnostics (не владеют процессами)

| API | Владелец | Действие |
|---|---|---|
| `listTeams`, `getTeamData`, `getSavedRequest` | `TeamDataService`/provisioning facade | keep |
| `createTeamConfig`, `renameDraftTeam` | provisioning facade | keep, проверить, что не спавнит |
| `prepareForProvisioning`, `getCliHelpOutput` | provisioning preflight | keep |
| `getClaudeLogs` | logs service | keep |
| `getLeadActivityState`, `getLeadContextUsage` | diagnostics | keep, но источник run — native |
| `respondToToolApproval`, `updateToolApprovalSettings` | tool approval | keep |
| `repairStaleTaskActivityIntervalsBeforeSnapshot` | task activity | keep |
| `getMemberSpawnStatusesReadOnly`, `getTeamAgentRuntimeSnapshotReadOnly` | diagnostics | replace snapshot half, keep write-free policy |

## 5. Setters/wiring (перенести на native owner)

| Setter | Куда |
|---|---|
| `setTeamChangeEmitter` | native registry watch → тот же emitter |
| `setLaunchAdmissionGuard` | native launch admission |
| `setRuntimeRecoveryFailureObserver` | native recovery |
| `setWorkspaceTrustCoordinator` | native provider/workspace |
| `setRuntimeAdapterRegistry` | native/OpenCode adapter |
| `setCrossTeamSender` | cross-team service |
| `setMainWindow` | UI events |
| `setToolApprovalEventEmitter` | tool approval |
| `setControlApiBaseUrlResolver` | native control URL |
| `setMemberRuntimeAdvisoryInvalidator` | native registry |
| `setTaskGroupChatCatalog` | **`TeamDataService`**, не provisioning; оставить |

## 6. Human path (D-448)

| Шаг | Сейчас | Цель |
|---|---|---|
| Сохранение вопроса | `sendDirectToLead` после stdin (`TeamDataService.ts:3263`) + `TeamSentMessagesStore.appendMessage`/controller `appendSentMessage` | `NodeLeadRequestHistory.persist` до admission/stdin, единственный writer |
| Admission | старый tracker | `DeliverPersistedLeadRequest` → `LeadRequestReporting` |
| stdin | `sendMessageToTeam` | native `sendLeadMessage` только для lead human path |
| Ответ | трекер/`sendDirectToLead` | `NodeLeadReportDelivery`, exact closure |
| Очередь | `queued` receipt | preload/renderer показывает queued |

## 7. Удаление после cutover

`TeamProvisioningService` — не один класс, а вершина цепочки фасадов (`TeamProvisioningService.ts:59` extends `TeamProvisioningOpenCodeAggregatePrimaryFacade`). Удалять её целиком нельзя, пока не разложена цепочка:

| Слой | Владеет процессами? | Что делать |
|---|---|---|
| `TeamProvisioningService` lifecycle methods | да | заменить native owner |
| `TeamProvisioningOpenCodeAggregatePrimaryFacade` | да/частично | оставить до OpenCode parity |
| settings/config/rename | нет | оставить |
| diagnostics/logs/approvals | нет | оставить |
| recovery/runtime snapshot liveness | да | удалить после native snapshot |

Удалять только process-owning:
- process-owning части `TeamProvisioningService` и старых mixins/facades;
- `TeamProvisioningCreateTeamFlow`, `TeamProvisioningLaunchTeamFlow`, `requestAdmissionBoundary`;
- старый recovery/runtime snapshot liveness;
- старые тесты процессного пути.

Не удалять целиком:
- `TeamLaunchStateEvaluator` — persisted launch metadata;
- `TeamDataService` pure reads/settings;
- logs/diagnostics/approvals;
- OpenCode aggregate до parity.

### 7a. `TeamLaunchStateEvaluator` field split

`snapshotToMemberSpawnStatuses` (`TeamLaunchStateEvaluator.ts:838`) выводит `online` из persisted `launchState === 'confirmed_alive'` — это исторический bootstrap, а не текущая жизнь. Его нельзя использовать для текущего member status.

| Функция/поле | Потребитель | Использование | Цель |
|---|---|---|---|
| `createPersistedLaunchSnapshot` | config/transcript/bootstrap | historical metadata | keep |
| `normalizePersistedLaunchSnapshot` | `TeamConfigReader` | historical metadata | keep |
| `summarizePersistedLaunchMembers` | launch pending message | historical summary | keep |
| `snapshotToMemberSpawnStatuses` | member status/OpenCode launch | **смешивает persisted и live** | не использовать для текущего UI; native mapper |
| `deriveTeamLaunchAggregateState` | launch summary | historical aggregate | keep only for history |

## 8. Гейты cutover

- `rg "createDefaultTeamProvisioningService"` = 0.
- Нет process-owning `TeamProvisioningService`/host; pure facade может остаться.
- `rg "sendDirectToLead"` в human-path = 0.
- `historicalBootstrapConfirmed` и `snapshotToMemberSpawnStatuses` не участвуют в текущей liveness.
- `TeamSentMessagesStore.appendMessage`/controller `appendSentMessage` не пишут human request.
- OpenCode spike = go.
- Sandbox Electron + real CLI acceptance.

`TeamLaunchStateEvaluator` не удалять целиком; удалить только использование для текущей liveness.

## 9. Test IDs

| Область | Набор |
|---|---|
| Registry/launch/stop/restart/skip | `test/features/team-provisioning/core/memberLifecycleRegistry.test.ts`, `startConfiguredMember.test.ts`, `restartConfiguredMember.test.ts`, `skipConfiguredMember.test.ts`, `teamLifecycleCommands.test.ts` |
| Native composition | `test/features/team-provisioning/main/nativeTeamLifecycleComposition.test.ts`, `nativeLifecycleShutdown.test.ts`, `nativeTerminationLifecycle.test.ts` |
| Snapshot/read | `test/features/team-provisioning/main/nativeRuntimeConnection.test.ts`, `nodeMemberRuntime.test.ts`, renderer snapshot tests |
| Human history/queue | `test/features/team-provisioning/core/deliverPersistedLeadRequest.test.ts`, `main/leadRequestHistory.test.ts`, `main/leadInputDeliveryStore.test.ts`, `main/boundHumanRequestSubmission.test.ts`, `main/humanRequestSubmissionIpc.test.ts` |
| Reporting | `test/features/lead-reporting/*` (sourceDeadline, requestAdmission, controller.integration, reporting.regressions) |
| API contract | `test/main/services/team/contracts/__tests__/TeamProvisioningApis.test.ts` |
| Instance gate | `test/main/appInstanceGate.test.ts`, `desktopBootstrapBoundary.test.ts`, `windowsAppMutex.test.ts` |
| MCP boundary | `mcp-server/test/leadReportingTools.test.ts`, `memberStartTool.test.ts` |

Каждая строка ownership map должна ссылаться на один из этих наборов или на новый тест, добавленный в той же фазе.
