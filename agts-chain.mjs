import { CdpClient } from './scripts/e2e/comment-notification/cdp.mjs';

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'));
const client = await CdpClient.connect(page.webSocketDebuggerUrl);
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(`${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
  }
  return result.value;
};

const prompt = [
  'Сквозная проверка цикла задач и спек. Действуй по шагам и ничего не меняй в коде репозитория.',
  'Шаг 1. Прочитай привязанную спеку: вызови team_spec_spec_catalog (view "specs"), team_spec_spec_documents {action:"list"} и team_spec_spec_tasks. Запиши числа (документы, задачи) — они понадобятся в отчёте.',
  'Шаг 2. Создай НОВУЮ спеку циклом: team_spec_spec_patch с intent "createSpec", spec "chain-check-20261110", title "Chain check". Затем добавь в неё требование через intent "amendRequirement" (requirement "FR-1", body с одним абзацем о проверке цикла) и дизайн через intent "patch" с документом "DESIGN.md" (одна секция, 3 строки, без воды).',
  'Шаг 3. Проверь валидность новой спеки: team_spec_spec_inspect { check: "validation", spec: "chain-check-20261110" }. Если невалидна — прочитай ошибки и исправь одним патчем.',
  'Шаг 4. Создай в реестре ОДНУ задачу: intent "confirmTaskCreation", entity "TASK-1", spec "chain-check-20261110", subject "Прочитать новую спеку", requirements ["FR-1"], description "WRITER читает документы и возвращает число документов", owner "WRITER".',
  'Шаг 5. Отправь WRITER сообщение с id задачи и просьбой: вызвать team_spec_spec_documents {action:"list", spec:"chain-check-20261110"}, вернуть число документов и записать результат комментарием к задаче.',
  'Шаг 6. Дождись его комментария, переведи задачу в done (intent "updateTask", status "done"), и вызови team_spec_spec_inspect { check: "validation" } по новой спеке ещё раз.',
  'В конце ответь ровно по пунктам: (1) числа прежней спеки, (2) какие интенты и документы создал, (3) результат валидации до и после, (4) id задачи и её финальный статус, (5) что ответил WRITER (число документов и текст комментария), (6) какие инструменты вызывал WRITER.',
].join('\n');

const request = {
  teamName: 'spec-chain-check',
  displayName: 'spec-chain-check',
  description: 'Two-member team proving the registry task and spec loop',
  cwd: 'E:/repos/tokenplan',
  specProject: 'stgmt/tokenplan',
  specSlug: 'registry-check-20261107',
  providerId: 'anthropic',
  model: 'deepseek-v4.1-flash@high',
  effort: 'high',
  skipPermissions: true,
  members: [
    { name: 'WRITER', role: 'builder', workflow: 'Исполняешь задачи по спецификациям; отвечаешь коротко и по делу.' },
    { name: 'REVIEWER', role: 'reviewer', workflow: 'Проверяешь результаты на соответствие спецификации; замечания только по существу.' },
  ],
  prompt,
};

const out = await evaluate(`(async () => {
  try {
    return { created: await window.electronAPI.teams.createTeam(${JSON.stringify(request)}) };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
})()`);
console.log(JSON.stringify(out, null, 1));
await client.close();
