# D-445 + D-448 production cutover plan

Дата: 30.10.2026. План реализации полной замены production root, без runtime-флага и без запасного старого пути. Рабочая папка: `E:/tmp/pub/merge`. Ветка: `refactor/team-provisioning-single-owner-20261028`. HEAD: `7af4fa8338cf16ba38071ad21acaf65a59f9a00a`.

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

| Фаза | Результат | Зависит от | Оценка |
|---|---|---|---|
| 0 | Инвентарь callers, ownership map, parity checklist | — | 0.5–1 день |
| 1 | Production composition native lifecycle | 0 | 2–3 дня |
| 1b | DTO/contract mapping без переключения UI | 1 | 1–2 дня |
| 2 | Mapper snapshot + contract tests | 1b | 1–2 дня |
| 3 | Launch/create/stop/cancel через native owner | 1, 2 | 2–3 дня |
| 3b | Переключение snapshot/read на native | 3 | 1–2 дня |
| 4 | Member start/restart/skip + authority | 3, 3b | 1–2 дня |
| 5 | Human request + D-448 reporting | 3, 3b | 3–4 дня |
| 6a | OpenCode spike и go/no-go | 1 | 3–5 дней |
| 6b | Остальной parity (settings/logs/diagnostics/approvals) | 4–5, 6a | 3–4 дня |
| 7 | Recovery/shutdown/state migration/rollback | 3–6b | 2–3 дня |
| 8 | Cutover-коммит и удаление process-owning кода | 2–7 | 1–2 дня |
| 9 | Полная sandbox-приёмка, build, package | 8 | 2–3 дня |
| 10 | Установка релиза и приёмка на ПК | 9 | 0.5–1 день |

Итого: 3–5 недель одного инженера. Главный неизвестный риск — OpenCode/aggregate parity; оценка фазы 6a предварительная, после spike уточняется. Без OpenCode spike дата cutover не фиксируется.

## Фаза 0. Инвентарь, ownership map, parity checklist

1. Собрать все использования `TeamProvisioningApis`, `TeamProvisioningService`, `createDefaultTeamProvisioningService`:
   - `src/main/index.ts`, `src/main/http/index.ts`, `src/main/http/teams.ts`, `src/main/ipc/teams.ts`, `src/preload/index.ts`, renderer stores/views.
2. Составить ownership map по каждому публичному методу `TeamProvisioningApis`:

| Поле | Значение |
|---|---|
| API method | например `launchTeam` |
| Process-owning | да / нет |
| Current owner | `TeamProvisioningService` / `TeamDataService` / `TeamLaunchStateEvaluator` / другое |
| Target owner | native lifecycle / существующий сервис / удалить |
| IPC/HTTP/preload/renderer callers | точные пути |
| Test ID | существующий или новый |
| Action | replace / keep / delete |

3. Отдельно классифицировать:
   - `process-owning` — launch/stop/restart/skip/recovery/snapshot liveness;
   - `persisted launch metadata` — `TeamLaunchStateEvaluator` и его потребители;
   - `settings/config` — meta/members/model policy;
   - `observability` — logs/diagnostics/context usage;
   - `human messaging` — history/queue/reporting;
   - `OpenCode` — aggregate primary/secondary/checkin/permissions.
4. Ownership map: `docs/team-management/d445-ownership-map.md`. Каждая строка должна иметь test ID; иначе фаза 0 не закрыта.
4. Выход: checklist без пустых строк; для каждой строки известен целевой модуль и тест.

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

## Фаза 3b. Переключение snapshot/read

1. Переключить IPC/HTTP/preload/renderer на mapper из фазы 2.
2. Убрать расчёт текущей liveness из старого snapshot.
3. `TeamLaunchStateEvaluator` **не удалять целиком**: сохранить persisted launch metadata (`createPersistedLaunchSnapshot`, `normalizePersistedLaunchSnapshot`, `summarizePersistedLaunchMembers`, `snapshotToMemberSpawnStatuses`) для истории/бейджей; удалить только использование для текущей жизни.
4. Тесты UI: exit, restart, skipped, source unavailable.
5. Выход: экран и инструменты читают один native snapshot.

## Фаза 4. Member start/restart/skip

1. `member_start` через `MemberLifecycleCommands.startConfiguredMember` + `LeadMemberStartAuthority`.
2. `restart`/`skip` через exact generation target.
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
   - добавить в `TeamMcpConfigBuilder` отдельную опцию `leadCredential` (или `runtimeScope` без смены tool profile);
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

## Фаза 6b. Остальной parity

Каждый пункт — строка checklist с тестом:

- settings/update состава, member settings, model preflight;
- logs, diagnostics, context usage, task activity repair;
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
4. Root/context change не оставляет второй owner; updater handoff и crash/restart проверены.
5. Тесты:
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
   - `test/main/services/team/TeamProvisioningApis.test.ts`;
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
