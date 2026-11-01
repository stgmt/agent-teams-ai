# Фаза 8: порядок выката native-владельца

Дата: 01.11.2026. Продолжение `d445-d448-production-cutover-plan.md`. Здесь —
конкретные шаги от текущего состояния до удаления legacy-владельца процессов,
с входным условием, проверкой и откатом для каждого шага.

Правило всей фазы: шаг считается закрытым только при зелёной проверке,
названной в его разделе. `tsc` и юнит-тесты не заменяют запуск приложения на
шагах 8.3–8.6.

## 8.0. Захват живых сообщений лида — сделано

- `NativeLeadOutputStream` (`src/features/team-provisioning/main/adapters/output/`)
  разбирает stream-json процесса лида и проецирует: текст ассистента (со
  склейкой synthetic-чанков и разрезом сегмента по `tool_use`), `session_id`,
  активные tool call'ы, переход в `idle` по `result/success`.
- `createObservedMemberPlanner` — единая точка наблюдения за stdout: один и тот
  же поток читают approvals, захват лида и журнал; планировщик больше не
  выбирает между ними.
- `NativeTeamMessagingApi.getCurrentLeadSessionId` берёт сессию лейна, а для
  процессного лида — распознанный `session_id`.
- Проверки: 6 модульных (`nativeLeadOutputStream.test.ts`) + 1 на реальном
  дочернем процессе, печатающем stream-json (`nativeLeadOutputStream.process.test.ts`).
- Осталось на 8.4: уведомление renderer/HTTP. Порт `onLeadMessage` в композиции
  уже есть; подключается к `forwardTeamChangeToRendererAndHttp({type:'lead-message'})`
  и `invalidateTeamChangeMessageFeed` при переключении транспорта.

Пробел, который этот шаг сознательно не закрывает: `authRetryInProgress`.
Нативный слой не ловит auth-retry редирект как отдельное состояние; до его
появления оценка перезапуска лида считает `authRetryInProgress === false`.

## 8.1. Оценка перезапуска лида на нативных фактах — сделано

`NativeLeadRestartAssessment` (коммит `9e26f1cbf`) отвечает на тех же фактах и
в том же порядке причин, что legacy: живой run → провайдер → занятость
(активность, tool call'ы, approvals) → распознанная сессия. Тесты: 5.
`authRetryInProgress` считается `false` до появления нативного источника.

Вход: нужно 8.0 (иначе нет ни `session_id`, ни активности).

Что уже есть и откуда:

| Факт                  | Источник                                                            |
| --------------------- | ------------------------------------------------------------------- |
| `activity`            | `lifecycle.leadOutput.facts(runId).activity`                         |
| `activeToolCalls`     | там же (`activeToolCalls.length`)                                    |
| `detectedSessionId`   | `lifecycle.leadOutput.detectedSessionId(runId)`                      |
| `pendingApprovals`    | `lifecycle.approvals.list(runId).length`                             |
| живой run             | `lifecycle.runs.isLive(identity)`                                    |
| провайдер прогона     | `lifecycle.settings.findConfiguredMember(identity, leadName)`        |
| `authRetryInProgress` | нет; считается `false` до появления состояния (см. 8.0)              |

Правило (`assessLeadRuntimeRestart`-эквивалент):

1. нет живого run по имени → `relaunch_required`;
2. провайдер не `anthropic`/`codex`/`gemini` → `relaunch_required`;
3. `activity !== 'idle'` или активные tool call'ы или ожидающие approvals →
   `busy` (тот же текст причины, что в legacy, чтобы UI не менялся);
4. нет `detectedSessionId` → `relaunch_required`;
5. иначе `ready` + `runId` как токен допуска.

Проверка: тесты на все четыре исхода плюс один прогон на реальном процессе,
который печатает `result` и перезапускается с `--resume <sessionId>`.

## 8.2. OpenCode: go/no-go (решение владельца)

Блокирует 8.4–8.6. Три варианта:

- **A. Полный перенос** восстановления лейнов (`scan`/`wake`/`busy`) в native:
  5–7 рабочих дней, после этого все команды живут в одном владельце.
- **B. Карантин.** Выкатываем native для Claude/Gemini/Codex-команд; OpenCode-
  команды после переключения отвечают явной ошибкой «не поддерживается до
  переноса лейнов». Ничего не теряем молча, но пользователь OpenCode-команд
  получает отказ.
- **C. Два владельца.** Native для обычных команд, legacy остаётся только для
  OpenCode. Дешевле всего по времени, но сохраняет ровно тот split-brain, ради
  устранения которого делается вся работа: два реестра run'ов и два писателя
  в один inbox.

Рекомендация: **B**, если задача — закрыть перенос в обозримом виде, иначе
**A**; вариант C обесценивает цель фазы.

**Решение владельца (01.11.2026): вариант A — полный перенос восстановления
OpenCode в native до переключения.** Значит 8.4 не начинается, пока лейны не
живут в одном владельце. Оценка +5–7 рабочих дней к плану.

### 8.2A. Срезы полного переноса (по итогам переписи кода)

Перепись (adapter-vs-legacy, 01.11.2026) даёт такие оставшиеся куски, в порядке
риска:

| Срез | Что переносим | Куда | Риск |
| --- | --- | --- | --- |
| A1 | Драйвер журнала доставки: постановка проверки после отправки, повторы, отмена при отсоединении | `NativeOpenCodePromptDeliverySupervisor` — **сделано** | повторная отправка в живой ход |
| A1' | Автоперезапуск лейна после `lost` | **не переносим**: в legacy лестница `OpenCodePrimaryLaneBootstrapSelfHeal` выключена по умолчанию и помечена как нежелательная | — |
| A2 | Скан «простаивающих» доставок (stale pending / continuity) | новый native-адаптер рядом с `NativeOpenCodeLaneRuntime` | двойная отправка подсказок |
| A3 | Журнал доставки и доказательство приёма (idempotency, proof commit) | переносится из `RuntimeDeliveryService`/`RuntimeDeliveryJournal` | потеря доказательства доставки |
| A4 | Watchdog/head-of-line/deferral/self-heal подсказок | тот же адаптер | шум в ленте при ложных срабатываниях |
| A5 | Паритет предиката MCP-потребителей на уровне payload (`mixedSecondaryLanes`, pending admission) | `NativeMcpConsumerQuery` | закрытие моста, пока жив OpenCode-хост |

A5 частично закрыт в этой сессии: пока член ещё `starting`/`connecting`,
наблюдения лейна нет, и мост удерживается. Полный паритет по payload требует
полей, которых в реестре нет, — это A5 целиком.

Порядок: A1 (сделано) → A5 → A2 → A3 → A4.

Что изменилось против первой редакции списка: проверка кода показала, что
legacy **не** перезапускает лейн после потери хоста — лестница
`OpenCodePrimaryLaneBootstrapSelfHeal` отгружается выключенной и снабжена
комментарием, почему включать её не надо. «Пробуждение» в legacy — это повтор
доставки подсказки, а не перезапуск процесса. Поэтому перенос начинается с
драйвера журнала доставки, а автоперезапуск остаётся и дальше действием
пользователя (`restartMember`).

## 8.3. Перестановка `runtimeAdapterRegistry` и reaping

Вход: любой вариант 8.2 (шаг не зависит от решения).

`createOpenCodeRuntimeAdapterRegistry` нельзя поднять выше владельца одной
строкой: по комментарию в `index.ts` сначала должен отработать
`windowsStartupCleanup.preflight()`, иначе первый запуск гоняется со старым
хостом за loopback-порт. Значит переносится весь блок: reaping → registry →
`createDefaultTeamProvisioningService`/native owner.

Проверка: реальный запуск приложения `pnpm dev:mcp` (CDP 9222), в логе видно,
что sweep завершился до первой регистрации адаптеров, и native runtime получил
непустой registry.

Откат: один коммит, `git revert`.

## 8.4. Сборка корня и транспорта

Вход: 8.1, 8.3 и решение по 8.2.

1. `createNativeDesktopTeamRuntime(...)` в `src/main/index.ts` после блока 8.3.
2. `onLeadMessage` → `forwardTeamChangeToRendererAndHttp({type:'lead-message', detail:'lead-text'})`
   + `invalidateTeamChangeMessageFeed` (иначе лента не обновится без перезапроса).
3. Транспорт: `registerLifecycleIpc`, `registerLifecycleCommandsIpc/Http`,
   `registerLifecycleSnapshotHttp`, `registerMemberLifecycleHttp`,
   `registerTeamMemberSettingsIpc`, messaging/toolApproval/approvals — на
   native-поверхность; имена каналов и формы ответов не меняются.
4. preload/renderer: чтение живых сообщений лида идёт из
   `getLiveLeadProcessMessages` без изменений формы.

Проверка: `pnpm dev:mcp`, sandbox-команда: launch → сообщение лида появляется в
ленте, в логе нет обращений к legacy `TeamProvisioningService`.

## 8.5. Привязка кросс-командного API

`createNativeTeamCrossTeamApi` подключается к `CrossTeamService`; проверка —
существующие тесты кросс-команды на native-поверхности плюс один живой обмен в
sandbox.

## 8.6. Удаление legacy и приёмка

Удаляется `TeamProvisioningService` и его иерархия, общие чистые хелперы
(`TeamProvisioningStreamEvents`, `TeamProvisioningLeadProcessMessages`,
`TeamProvisioningProgressBuffers`) остаются, если их читают native-адаптеры.
Приёмка — sandbox-прогон полного сценария: launch, переписка, approvals,
перезапуск участника, остановка команды, повторный launch после остановки.

Критерий готовности фазы: в дереве не остаётся второго реестра run'ов и второго
писателя в inbox; все команды обслуживает один владелец.
