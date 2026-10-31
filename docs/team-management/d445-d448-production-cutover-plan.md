# D-445 + D-448 production cutover plan

Дата: 30.10.2026. План реализации полной замены production root, без runtime-флага и без запасного старого пути. Рабочая папка: `E:/tmp/pub/merge`. Ветка: `refactor/team-provisioning-single-owner-20261028`. Code HEAD: `36ed96e25` (docs commit on top of `7af4fa83`).

Версия 2: учтены findings ревью плана — ownership map, single writer human history, граница `TeamLaunchStateEvaluator`, credential-only опция, порядок фаз, state/rollback, OpenCode spike.

## 0. Инвариант

Один владелец процессов и один snapshot. Пока идёт разработка, старый и новый контуры не запускаются одновременно на одной команде. Финальный cutover — один интеграционный коммит: callers переключены, старый process-owning код удалён, флага возврата нет.

Разрешённые временные состояния: новые модули существуют и тестируются в sandbox, но production callers ещё не переключены. Запрещённые: runtime-выбор старого/нового пути, второй реестр процессов, facade, делегирующий исполнение старому оркестратору.

Промежуточные коммиты не релизятся и не устанавливаются: installer собирается только после cutover-коммита и приёмки.

## 1. Целевая архитектура

- `src/features/team-provisioning/main/composition/createNativeTeamLifecycle.ts` — единственный владелец configured membership, desired state, owned processes, resources, generation и versioned snapshot.
- `createNativeProviderPorts.ts` — profile/auth/env/provider parity.
- `NodeTeamWorkspace`, `NodeNativeLaunchArtifacts`, `NodeNativeMemberRegistration`, `NodeNativeTeamConfig` — workspace, artifacts, registration, config.
- `HumanRequestLedger` + `DeliverPersistedLeadRequest` — exact human request, очередь, durable reservation.
- `createNativeLeadReporting` — D-448 reporting поверх native lifecycle seams.
- Production root собирает всё это один раз в `src/main/index.ts`; IPC/HTTP/preload/renderer читают только его команды и snapshot.

## 2. Порядок работ

| Фаза | Результат                                                       | Зависит от | Оценка     |
| ---- | --------------------------------------------------------------- | ---------- | ---------- |
| 0    | Инвентарь callers, ownership map, parity checklist              | —          | 0.5–1 день |
| 0.1  | Полный canonical surface (92), target/test, run-registry matrix | 0          | 2–3 дня    |
| 1    | Production composition native lifecycle                         | 0.1        | 2–3 дня    |
| 1b   | DTO/contract mapping без переключения UI                        | 1          | 1–2 дня    |
| 2    | Mapper snapshot + contract tests                                | 1b         | 1–2 дня    |
| 3    | Launch/create/stop/cancel через native owner                    | 1, 2       | 2–3 дня    |
| 3b   | Переключение snapshot/read на native                            | 3          | 1–2 дня    |
| 4    | Member start/restart/skip + authority                           | 3, 3b      | 1–2 дня    |
| 5    | Human request + D-448 reporting                                 | 3, 3b      | 3–4 дня    |
| 6a   | OpenCode spike и go/no-go                                       | 1          | 3–5 дней   |
| 6b   | Остальной parity (settings/logs/diagnostics/approvals)          | 4–5, 6a    | 3–4 дня    |
| 7    | Recovery/shutdown/state migration/rollback                      | 3–6b       | 2–3 дня    |
| 8    | Cutover-коммит и удаление process-owning кода                   | 2–7        | 1–2 дня    |
| 9    | Полная sandbox-приёмка, build, package                          | 8          | 2–3 дня    |
| 10   | Установка релиза и приёмка на ПК                                | 9          | 0.5–1 день |

Итого: 23–37 рабочих дней по суммарной оценке фаз (4.6–7.4 недели), а не 3–5 недель. Главный неизвестный риск — OpenCode/aggregate parity; после spike 6a оценка уточняется. Без OpenCode spike дата cutover не фиксируется.

### 2a. Corrections from independent review (30.10)

До phase 1 обязательны следующие уточнения; иначе cutover создаст split-brain или потеряет возможности.

1. **Run registry.** Native launch не регистрирует run в `service.runs`, который читают approvals, task activity, live lead messages, inbox relay и spawn status. До phase 3 нужен native run-registry port или явно разрешённый read-only bridge с тестами.
2. **`snapshotToMemberSpawnStatuses`.** Это live-проекция с 12+ call sites, а не historical badge. Нужен отдельный live status port; persisted `confirmed_alive` — только history. Переписать каждый call site.
3. **`sendMessageToTeam`.** Это lead stdin, используемый и human UI, и системными уведомлениями (AutoResume, language change, task/member notifications). Делить по caller: human reply → D-448 pipeline; system notification → отдельный путь. Тест: system send не создаёт human request.
4. **Human contract.** `PersistedLeadRequest` text-only; attachments/actionMode/taskRefs/slash не сохраняются. Либо расширить контракт, либо оставить legacy для non-text; mapping `LeadRequestDeliveryReceipt` → `SendMessageResult` в phase 1b.
5. **Attach/detach.** Native-команды нет; phase 4 не может оставить legacy, если phase 8 удаляет весь process-owning код. Добавить native attach/detach или отдельный parity gate.
6. **Native ports.** Нет cancel/progress/status query; `stopTeam(teamName)` без runId; `restartMember/skip` без generation. Добавить контракты и тесты stale/queued.
7. **Lead session ID.** Native config удаляет `config.leadSessionId`; logs/transcript/context usage/message feed его используют. Сохранять session ID или определить replacement.
8. **`historicalBootstrapConfirmed`.** Используется member-work-sync для OpenCode `registered_only/stale_metadata`; правило «никогда для liveness» неверно. Нужно per-consumer правило и тесты.
9. **Composition cycle.** Native lifecycle требует `owner`, но сервис создаётся до `externalAgentConnection`; connection делает rebind generation. Нужен lazy owner provider/two-phase composition и recompose при смене root/context.
10. **Writers.** `TeamSentMessagesStore.appendMessage` используется OpenCode delivery, не `ipc/teams.ts`; human writer — `sendDirectToLead` через controller. Гейт ставить по `source:'user_sent'`, не по имени метода.
11. **Gates.** Заменить расплывчатые проверки на механические: нет process-owning класса/пути, нет `createDefaultTeamProvisioningService`, нет human `user_sent` writer вне `NodeLeadRequestHistory`, нет `confirmed_alive` в live status.
12. **Evidence level.** Real-CLI приёмка и fake-provider приёмка — разные уровни; fake provider не закрывает CLI-гейт. Бюджет на модельные прогоны согласовать отдельно.
13. **State/rollback.** Репетиция new→old→new и откат installer до phase 8; зафиксировать, что старый билд делает с `appManagedRun`.

## Фаза 0.1. Закрытие полного inventory

1. Использовать generated inventory `docs/team-management/d445-ownership-map.generated.md` (92 членов canonical surface, caller counts).
2. Заполнить target/test для оставшихся `manual review` строк; критичные process-owning строки закрыть до phase 1.
3. Зафиксировать матрицу потребителей `service.runs` и `snapshotToMemberSpawnStatuses`.
4. Выход: каждая строка имеет target/test или `block` с причиной; phase 0.1 не начинается phase 3.

## Фаза 0. Инвентарь, ownership map, parity checklist

1. Собрать все использования `TeamProvisioningApis`, `TeamProvisioningService`, `createDefaultTeamProvisioningService`:
   - `src/main/index.ts`, `src/main/http/index.ts`, `src/main/http/teams.ts`, `src/main/ipc/teams.ts`, `src/preload/index.ts`, renderer stores/views.
2. Составить ownership map по каждому публичному методу `TeamProvisioningApis`:

| Поле                              | Значение                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| API method                        | например `launchTeam`                                                               |
| Process-owning                    | да / нет                                                                            |
| Current owner                     | `TeamProvisioningService` / `TeamDataService` / `TeamLaunchStateEvaluator` / другое |
| Target owner                      | native lifecycle / существующий сервис / удалить                                    |
| IPC/HTTP/preload/renderer callers | точные пути                                                                         |
| Test ID                           | существующий или новый                                                              |
| Action                            | replace / keep / delete                                                             |

3. Отдельно классифицировать:
   - `process-owning` — launch/stop/restart/skip/recovery/snapshot liveness;
   - `persisted launch metadata` — `TeamLaunchStateEvaluator` и его потребители;
   - `settings/config` — meta/members/model policy;
   - `observability` — logs/diagnostics/context usage;
   - `human messaging` — history/queue/reporting;
   - `OpenCode` — aggregate primary/secondary/checkin/permissions.
4. Ownership map: `docs/team-management/d445-ownership-map.md`. Каждая строка должна иметь test ID; иначе фаза 0 не закрыта.
5. Выход: checklist без пустых строк; для каждой строки известен целевой модуль и тест.

## Фаза 1. Production composition

Создать `src/main/team-runtime/createDesktopTeamLifecycle.ts` (имя уточнить по месту), который собирает:

- `owner` / `AppConnectionContext` из `createDesktopExternalAgentConnection`;
- `NodeTeamLaunchSettings` с `TeamMetaStore`, `TeamMembersMetaStore`, `teamsRoot`;
- `createNativeProviderPorts` с profile/env/identity/workSync из существующих runtime-сервисов;
- `NodeTeamWorkspace` (named checkout + member worktrees);
- `NodeNativeLaunchArtifacts`, `NodeNativeMemberRegistration`, `NodeNativeTeamConfig`;
- `NodeMemberRuntime` + `NativeClaudeLaunchPlanner`;
- `TeamMcpConfigBuilder` как `mcp` порт;
- `teamInboxWriter` как `inbox` порт;
- `controlUrl` из HTTP/control server;
- `briefing` из prompt builders;
- `invalidate`, `contextInvalidationSignal`, `withExpectedContext` из connection feature.

Проверки:

- composition smoke на временном профиле и fake provider;
- production-like composition test с реальными temp profile paths, env/workSync и fake executable (без реального CLI);
- запуск и stop сохранённой sandbox-команды без реального CLI;
- snapshot содержит весь configured roster и точные generation/operationId;
- shutdown освобождает resources и не оставляет процессов.

Выход: native lifecycle создаётся в production-коде, но callers ещё не переключены.

## Фаза 1b. DTO/contract mapping

1. Составить таблицу `TeamLifecycleSnapshot` → существующие read-DTO:
   - `TeamRuntimeState`;
   - `TeamAgentRuntimeSnapshot`;
   - `MemberSpawnStatusesSnapshot` / member status rows;
   - `TeamViewSnapshot` / `TeamSummary` (только поля состояния).
2. Для каждого поля указать: native source / derived / `null` / удалить.
3. `historicalBootstrapConfirmed` остаётся только как persisted launch metadata и **не** участвует в текущей liveness.
4. Проверить renderer types, stores, views и тесты; зафиксировать, какие поля UI перестанут получать.
5. Выход: mapper-контракт и список UI-правок без переключения чтения.

### Phase 1b decisions (after independent review)

- Liveness = `member.process !== null`; phase names are not liveness. `starting` without a process is not alive; `stopping`/`failed` with an owned process is alive.
- `restartable`: configured teammate (`role === 'member'`) — true; lead — false. It means the native restart command is admissible, not "currently stopped".
- `status`/`launchState`: ready → online/confirmed_alive; starting/connecting → spawning/runtime_pending_bootstrap; failed → error/failed_to_start; stopping → waiting; stopped/exited → offline/skipped with `launchState:'starting'` placeholder. `hasUnresolvedMemberSpawnStatus` ignores offline/skipped/error, so the placeholder does not poll forever.
- `error`/`hardFailure` only for `phase === 'failed'`; retained cancellation errors on skipped/stopped members are suppressed. `unresponsive` is online with `runtimeDiagnostic:'connection lost'` and warning severity.
- `expectedMembers` excludes the lead; runtime entries include the lead.
- `TeamViewSnapshot`/`TeamSummary` state mapping and non-derivable runtime fields (`pidSource`, `runtimeModel`, `cwd`, `laneId`, `providerId`) are deferred to phase 3b; team-level `error`/`release-failed` needs a team diagnostic and is recorded as a phase 1b gap.

## Фаза 2. Mapper и contract tests

1. Реализовать mapper `TeamLifecycleSnapshot` → read-DTO (без переключения callers).
2. Правила:
   - `phase` и `process` берутся только из native snapshot;
   - `everConnected` — только native fact;
   - run/generation mismatch не меняет текущий snapshot;
   - persisted launch metadata не воскрешает участника;
   - `snapshotToMemberSpawnStatuses` не используется для текущего member status: он выводит `online` из persisted `confirmed_alive`.
3. Тесты:
   - join → exit → snapshot не живой;
   - старый bootstrap не воскрешает участника;
   - новый run не наследует состояние старого;
   - reading не пишет побочно.
4. Выход: mapper зелёный; production callers ещё на старом snapshot.

## Фаза 3. Launch/create/stop/cancel

1. Новый production-класс `DesktopTeamRuntime` реализует lifecycle-часть `TeamProvisioningApis`:
   - `createTeam`: canonical draft через `NodeTeamDefinitionStore`, затем native `commands.launch`;
   - `launchTeam`: native `commands.launch` по сохранённому определению;
   - `stopTeam`: native `commands.stop` с exact runId;
   - `cancelProvisioning`: отмена native launch по context/generation;
   - progress: из native registry/watch → `TeamProvisioningProgress`.
2. Переключить `teamApis.provisioningStart`, `provisioningStatus`, `runtime` в `src/main/http/index.ts`/`src/main/index.ts`.
3. Удалить старые `TeamProvisioningCreateTeamFlow`, `TeamProvisioningLaunchTeamFlow`, `requestAdmissionBoundary` из production-пути.
4. Тесты:
   - двойной launch возвращает тот же receipt;
   - cancel во время подготовки не запускает процесс;
   - stop точного run; stale stop отклонён;
   - context replacement отменяет старый run;
   - progress не дублируется.

Выход: launch/stop/cancel принадлежат native owner.

### Phase 3a decisions (after independent review)

- `TeamRunRegistryRead` — identity/liveness порт, не run-payload store. `pendingApprovals`, `claudeLogLines`, `detectedSessionId`, `run.child`, reply hints остаются у потребителей до отдельного порта (phase 6b); реестр не должен стать вторым.
- `hasRun` = зарегистрированная identity, включая остановленную историю для status reads. `isLive` = running, ресурсы не `released`/`release-failed`; именно он заменяет legacy `runs.has(runId)` в task activity. Retirement не нужен: новый run той же команды заменяет запись, память ограничена числом команд.
- Фасад `runs` — composition-internal без context fencing. IPC/HTTP читают только `LifecycleQueries`, где каждый метод (включая `aliveTeamNames`/`aliveRunId`) проходит `withExpectedContext`.
- Progress выводится из snapshot (`toTeamProvisioningProgress`) и не хранится: `preparing→configuring`, `starting→spawning`, `ready`, `degraded→ready+warnings`, `failed`/`release-failed`, `stopping`/`stopped→disconnected user_stop`. После вытеснения run из реестра status читается из persisted history; native-запись progress — gap фазы 7.
- Cancel = stop точного run; runId появляется в первом progress-событии из `watch`, поэтому отмена во время подготовки не требует отдельного prepare-контракта.
- Известные ограничения: crash без exit-события остаётся live до reconcile/stop; OpenCode secondary-lane liveness — gate фазы 6a; `aliveTeamNames` не означает «процессов нет» после `removeMember`.

### Phase 3 implementation status

- `createDesktopTeamRuntime` реализует lifecycle-часть `TeamProvisioningApis`: `createTeam`/`launchTeam` (сначала канонический definition, затем native launch), `cancelProvisioning` по runId, `hasProvisioningRun`, `getRuntimeState`, `stopTeam`, `isTeamAlive`, `getAliveTeams`, `getCurrentRunId`, `findByRunId`.
- Launch progress идёт из `watch` по admitted run; уже запущенная команда возвращает `already_running`/`already_launching`, не создавая новый run. History-снапшот из подписки не replay-ится, но admitted run эмитится и после admission; terminal/failed закрывает feed.
- `launchTeam` сохраняет provider/model/effort/prompt/cwd/flags/worktree/extraCliArgs в `team.meta.json` через `NodeTeamDefinitionStore.updateLaunchSettings`; живой run definition не перезаписывает. Смена provider сбрасывает backend, model/effort/fastMode и `launchIdentity`; явная смена model/effort сбрасывает `launchIdentity`.
- `createTeam` на существующем metadata-only draft переиспользует ростер (`TeamDefinitionExistsError`) и обновляет только launch-поля.
- Failed/release-failed run останавливается точным runId перед relaunch; `stopTeam` повторяет failed release; `cancelProvisioning` принимает только `preparing`/`starting`; `hasProvisioningRun` — только эти состояния.
- `getRuntimeState` заполняет `progress` из snapshot; для stopped run `runId`/`progress` — null; пустой registry читает persisted bootstrap через опциональный порт.
- `TeamLifecycleSnapshot.startedAt` фиксируется при admission и не меняется при configureTeam того же run.
- Production IPC/HTTP всё ещё на старом root: переключение — фаза 8.

## Фаза 3b. Переключение snapshot/read

1. Переключить IPC/HTTP/preload/renderer на mapper из фазы 2.
2. Убрать расчёт текущей liveness из старого snapshot.
3. `TeamLaunchStateEvaluator` **не удалять целиком**: сохранить persisted launch metadata (`createPersistedLaunchSnapshot`, `normalizePersistedLaunchSnapshot`, `summarizePersistedLaunchMembers`, `snapshotToMemberSpawnStatuses`) для истории/бейджей; удалить только использование для текущей жизни.
4. Тесты UI: exit, restart, skipped, source unavailable.
5. Выход: экран и инструменты читают один native snapshot.

### Phase 3b status

- `createBoundTeamLiveStatusQueries` даёт context-fenced `memberSpawnStatuses` и `runtimeSnapshot` из одного native snapshot; неизвестная команда отвечает пустой live-проекцией, а не выдуманным ростером.
- Переключение IPC/HTTP/preload/renderer на эти чтения возможно только вместе с native production composition (фаза 8): пока старый root владеет snapshot, параллельное чтение было бы вторым authority.
- `TeamLaunchStateEvaluator`/`snapshotToMemberSpawnStatuses` остаются для persisted history/бейджей; текущая liveness в них больше не должна использоваться.

## Фаза 4. Member start/restart/skip

1. `member_start` через `MemberLifecycleCommands.start` + `LeadMemberStartAuthority`.
2. `restart`/`skip` через exact generation target (`commands.restart`, `commands.skip`).
3. HTTP `/api/team-runtime/member-start`, IPC/preload/UI.
4. MCP lead profile + tool `member_start`; credential привязан к run.
5. `attachLiveRosterMember`/`detachLiveRosterMember`: native-команды нет. Либо добавить attach/detach в native lifecycle, либо оставить legacy member settings до parity. Не выдавать legacy за native.
6. Тесты:
   - только configured member;
   - lead/чужая команда/удалённый/неизвестный отклонены;
   - running не перезапускается;
   - stop/context replacement отзывают полномочие;
   - прямой handler проверяет authority, не только prompt.

Выход: Тимлид поднимает только существующих подчинённых.

## Фаза 5. Human request + D-448 reporting

1. `createNativeLeadReporting` собирается с native lifecycle:
   - `resolveLeadCredential`;
   - `queries.snapshot`;
   - `taskChanges.read`;
   - `sendLeadMessage`.
2. Credential:
   - добавить в `TeamMcpConfigBuilder` отдельную опцию `leadCredential` (или `runtimeScope` без смены tool profile; `runtimeScope` уже существует, но сейчас меняет профиль);
   - не использовать глобальный env для member-профилей;
   - проверить, что lead tool profile не теряет нужные инструменты: `AGENT_TEAMS_OPERATIONAL_LEAD_TOOL_NAMES` сейчас не содержит runtime/team-launch/process; либо добавить с authority, либо доказать, что новый Тимлид их не вызывает.
3. `registerLeadReportingHttp` на control server; один экземпляр reporting на приложение.
4. Human history — **один writer**:
   - `NodeLeadRequestHistory.persist` — единственная запись `user_sent` для human-path;
   - убрать `sendDirectToLead`/`appendSentMessage` и `TeamSentMessagesStore.appendMessage` из human-path `src/main/ipc/teams.ts`;
   - `sendMessageToTeam` разделить: lead human reply → native `sendLeadMessage`; member/relay/work-sync/auto-resume → отдельный путь, не `sendLeadMessage`;
   - тест: ровно одна строка на request ID, повтор не добавляет вторую, same-ID/different-text не перезаписывает.
5. `submitHumanRequest` → `DeliverPersistedLeadRequest` → очередь:
   - `queued` receipt в preload/renderer отображается как «в очереди», не как sent/error;
   - второй вопрос не заменяет первый;
   - watchdog и exact closure.
6. Prompt/hydration:
   - `buildLeadReportRequestInstruction` и `buildLeadReportContextRefresh` в lead-контексте;
   - старые readiness-инструкции удалить из lead-пути.
7. Native SendMessage Тимлида запрещён planner-политикой; единственный publisher — `NodeLeadReportDelivery`.
   - обязательный sandbox CLI-тест: native SendMessage не публикует, app publisher единственный;
   - если CLI игнорирует `disallowedTools`, cutover блокируется.
8. Тесты:
   - persist-before-send;
   - queued второй вопрос;
   - watchdog;
   - отчёт со всем roster, evidence-метками, source limitations;
   - нет второго ответа;
   - compaction не создаёт новый запрос.

Выход: владелец задаёт вопрос и получает содержательный отчёт из установленного приложения.

## Фаза 6a. OpenCode spike и go/no-go

1. Проверить, умеет ли `createNativeProviderPorts`/planner запускать OpenCode runtime (aggregate primary, secondary lanes, checkin, permissions, persistence).
2. Если нет — оценить стоимость parity; до решения cutover для OpenCode-команд блокирован.
3. Не оставлять старый OpenCode runtime как fallback.
4. Выход: go/no-go и уточнённая оценка. Без этого фаза 8 не начинается.

**Результат (30.10): NO-GO.** Native planner принимает только anthropic/codex/gemini
(`nativeRuntimeProvider.ts:4-8`), а OpenCode живёт как lane-adapter с reconcile, без
per-member pid. Полный разбор и варианты — `docs/team-management/d445-opencode-parity-spike.md`.
Рекомендация: lane ownership в native registry (вариант A), затем cutover. До этого
production root не переключать.

6a.1 уже в коде: `MemberLaneObservation`, `observeLane`/`observeLaneLost`, lane-liveness
в registry и проекция в `laneId`/`shared-host`/`permission_blocked`. 6a.2 partial:
`MemberRuntimePort.kind`/`startLane`, команды стартуют/наблюдают/останавливают lane.
6a.3: team-level lane groups (`laneGroups` planner → `startLaneGroup` один вызов на lane,
валидация состава, input/stop через группу, single-member restart общего lane отклонён).
Сделано: concrete `startLaneGroup` над `TeamLaunchRuntimeAdapter`, permission answer/list,
lane restart, recovery после рестарта приложения (`recoverOrphanedRuns`).

## Фаза 6b. Остальной parity

Полный статус по каждому API: `docs/team-management/d445-parity-checklist.md`.

Каждый пункт — строка checklist с тестом:

- settings/update состава, member settings, model preflight;
- logs, diagnostics, context usage, task activity repair;

Native logs: `NativeTeamLogStore` (bounded 2000 lines, newest-first через
`sliceClaudeLogs`) + захват planner output; `NativeTeamClaudeLogs` отдаёт
`getClaudeLogs`. Diagnostics: `NativeTeamDiagnostics` отдаёт runtime snapshot;
lead activity/context usage пока fail-closed. Member lifecycle:
`NativeTeamMemberLifecycleApi` (statuses/restart/skip); attach/detach fail-closed, OpenCode
secondary retry native (`retryFailedLanes` → `restartLane` для групп с failed-членами,
lead lane требует relaunch). Approvals: `NativeTeamToolApprovalApi` отвечает на
lane-запросы по exact run; Claude process approvals теперь native
(`NativeClaudeToolApprovals`: `control_request` ingestion + `control_response` в
stdin); запись settings пока fail-closed. Task activity repair: `NativeTaskActivityRepair` уже
связывает legacy repair с native registry (`aliveRunId`/`findByRunId`/`isLive`):
живой run пропускает repair, остановленный — чинится один раз. Lead relay:
`NativeLeadInboxRelay` читает inbox лида, батчит actionable-строки, отправляет один
prompt в stdin и коммитит read только после успешной записи при живом run; reply
projection остаётся в lead reporting, live-activity push пока fail-closed.
Остальные пункты 6b ещё не портированы.

- approvals/tool settings;
- attachments, action mode, slash/relay/cross-team correlation;
- task provenance и change ledger;
- named/member workspace, trust/profile, filters/TOCTOU, partial Git allocation;
- provider parity: Anthropic, Codex, Gemini, OpenCode (по результату 6a);
- recovery: crash, stop, skipped member, pending replacement.

Выход: parity checklist зелёный в sandbox для каждого поддерживаемого provider.

## Фаза 7. Recovery/shutdown/state migration

1. Native recovery поднимает только owned runs, intentional stop не восстанавливает.
2. Shutdown закрывает admission, отзывает authority, ждёт физического stop/cleanup.
3. State compatibility:
   - `NodeNativeTeamConfig` пишет `appManagedRun` в `config.json`;
   - старый билд не знает это поле;
   - добавить cleanup осиротевших `appManagedRun`/runtime dirs и тест «новая запись → старый билд → повторный native launch»;
   - `sentMessages.json` и input reservation не должны дублироваться/теряться.

Реализовано: `NodeNativeTeamConfig.recoverOrphanedClaim(teamName, isRunAlive)`
снимает `appManagedRun` только когда run не жив в текущем процессе; живой claim
сохраняется, повторный вызов идемпотентен. `NativeTeamLifecycle.recoverOrphanedRuns`
вызывает его для переданных команд, используя `registry.hasRun && registry.isLive`
как критерий жизни. Startup recovery вызывает это до нового launch. Тесты —
`nativeTeamConfigRecovery.test.ts`. 4. Root/context change не оставляет второй owner; updater handoff и crash/restart проверены. 5. Тесты:

- exit/release во время pending stop;
- late spawn после shutdown;
- повторный stop освобождает долг;
- второй экземпляр приложения не создаёт owner (уже проверено на упакованном билде; helper-процессы не считаются экземплярами);
- rollback на предыдущий installer после cleanup.

## Фаза 8. Cutover-коммит

Один интеграционный коммит:

1. `src/main/index.ts`: убрать `createDefaultTeamProvisioningService`, собрать native owner.
2. `src/main/http/index.ts`: team routes на native owner + reporting.
3. `src/preload/index.ts`: новые bridge/каналы, старые удалить.
4. `src/main/ipc/teams.ts`: human messaging persist-before-send, один writer.
5. Renderer: snapshot store/views на новые DTO; убрать старые readiness-поля.
6. Удалить только process-owning код:
   - process-owning части `TeamProvisioningService` и старых mixins/facades (класс — вершина цепочки фасадов, не удалять целиком);
   - `TeamProvisioningCreateTeamFlow`/`LaunchTeamFlow`/старый recovery;
   - использование `TeamLaunchStateEvaluator`/`snapshotToMemberSpawnStatuses` для текущей liveness;
   - старые тесты, проверяющие удалённый процессный путь.
7. Не удалять `TeamLaunchStateEvaluator` целиком и не удалять чистые settings/diagnostics/logs функции без ownership map.
8. Проверка:
   - `rg "createDefaultTeamProvisioningService"` = 0;
   - нет process-owning `TeamProvisioningService`/host; pure facade может остаться;
   - `rg "sendDirectToLead"` в human-path = 0;
   - `TeamSentMessagesStore.appendMessage`/controller `appendSentMessage` не пишут human request;
   - `historicalBootstrapConfirmed` и `snapshotToMemberSpawnStatuses` не участвуют в текущей liveness;
   - нет runtime-флага.

Выход: один owner, один snapshot, старого process-owning пути нет.

## Фаза 9. Приёмка

1. Scoped tests по каждой фазе + полный `test/features/team-provisioning` и `test/features/lead-reporting`.
2. Contract tests:
   - `test/main/services/team/contracts/__tests__/TeamProvisioningApis.test.ts`;
   - `TeamDataService`/renderer snapshot tests;
   - `test/main/appInstanceGate.test.ts`, `desktopBootstrapBoundary.test.ts`, `windowsAppMutex.test.ts`.
3. `pnpm typecheck` (8 конфигураций) или прямой native tsc.
4. Guards: source size, architecture, `git diff --check`.
5. ESLint/Prettier только по изменённым файлам.
6. Sandbox Electron:
   - `pnpm dev:mcp`;
   - создать sandbox-команду;
   - launch, stop, member_start, human question, report;
   - проверить экран, что exit не показывается живым;
   - не использовать реальные проекты/команду.
7. Sandbox real CLI для каждого provider; fake auth, temp profile; бюджет на модельные прогоны согласовать отдельно. Если бюджета нет — fake provider, а модельная приёмка помечается UNVERIFIED.
8. Build: `pnpm build` с 8GB heap; package со staged runtime.
9. Независимое ревью cutover-коммита; повторное ревью после любых новых коммитов.

## Фаза 10. Релиз

1. `stage-runtime`, `stage-terminal-platform-runtime`, packaging.
2. Установщик + per-user install, shortcut.
3. Single-instance уже реализован и проверен; повторить на новом билде.
4. Приёмка сначала на изолированном профиле; установка в профиль владельца — только после отдельного подтверждения, без запуска живой команды.
5. Rollback — предыдущий installer после cleanup `appManagedRun`/runtime dirs; не старый код в новой сборке.

## Критерии готовности D-448 в приложении

- Владелец пишет «что нового?».
- IPC сохраняет exact request до stdin.
- Lead получает inspection со всем roster.
- `message_send` с report проходит app-owned publisher.
- В inbox владельца один отчёт с machine headline, evidence-метками и source limitations.
- Нет второго ответа, native SendMessage не публикует.
- Повтор/рестарт/watchdog не создают дубль.
- Установленное приложение проходит этот сценарий в sandbox.

## Риски и меры

- **OpenCode parity** — блокирующий; отдельный spike/go-no-go, без старого runtime fallback.
- **Two human writers** — только `NodeLeadRequestHistory`; `sendDirectToLead` убрать из human-path.
- **`TeamLaunchStateEvaluator`** — не удалять целиком; отделить persisted metadata от текущей liveness.
- **Credential/tool profile** — отдельная credential-only опция; parity-аудит lead allowlist.
- **Snapshot mapping** — `historicalBootstrapConfirmed` не использовать для liveness.
- **State/rollback** — cleanup `appManagedRun`, тест new→old→new.
- **Native SendMessage** — проверить на реальном CLI; иначе publisher можно обойти.
- **Shared dirty tree** — не делать reset/clean/blanket staging; cutover-коммит scoped.
- **Windows native build** — Spectre/node-pty/mutex; не ослаблять требования в релизе.
- **Live team** — только sandbox/test projects, dev:mcp CDP.

## Первый рабочий шаг

Фаза 0: ownership map и parity checklist. Затем фаза 1: `createDesktopTeamLifecycle` с реальными портами и production-like composition test. До зелёной фазы 3 production callers не переключать.
