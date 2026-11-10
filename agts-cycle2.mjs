import { CdpClient } from './scripts/e2e/comment-notification/cdp.mjs';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'));
const client = await CdpClient.connect(page.webSocketDebuggerUrl);
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
};
const prompt = [
  'Сквозная проверка цикла. Код репозитория не меняй.',
  '1) Прочитай привязанную спеку: team_spec_spec_documents {action:"list"} и team_spec_spec_tasks для registry-check-20261107. Запиши числа.',
  '2) Создай спеку: team_spec_spec_patch intent "createSpec", project "stgmt/tokenplan", spec "chain-check-20261110", title "Chain check". Затем добавь требование intent "amendRequirement", requirement "FR-1", body — абзац, объясняющий механизм проверки цикла.',
  '3) Проверь валидность: team_spec_spec_inspect { check: "validation", spec: "chain-check-20261110" }.',
  '4) Создай задачу: intent "confirmTaskCreation", entity "TASK-1", project "stgmt/tokenplan", spec "chain-check-20261110", subject "Прочитать спеку", requirements ["FR-1"], description "WRITER читает документы и возвращает число", owner "WRITER".',
  '5) Напиши WRITER сообщение с id задачи и просьбой вызвать team_spec_spec_documents {action:"list", spec:"chain-check-20261110"} и записать результат комментарием к задаче.',
  '6) Дождись комментария и переведи задачу в done (intent "updateTask", status "done").',
  'Ответь: числа старой спеки; результат валидации; id задачи и статус; ответ WRITER.',
].join('\n');
const out = await evaluate(`(async () => {
  const api = window.electronAPI.teams;
  await api.stop('spec-chain-check').catch(() => null);
  await new Promise((r) => setTimeout(r, 3000));
  try {
    return { launched: await api.launchTeam({ teamName: 'spec-chain-check', cwd: 'E:/repos/tokenplan', providerId: 'anthropic', model: 'deepseek-v4.1-flash@high', effort: 'high', skipPermissions: true, prompt: ${JSON.stringify(prompt)} }) };
  } catch (error) { return { error: String((error && error.message) || error) }; }
})()`);
console.log(JSON.stringify(out, null, 1));
await client.close();
