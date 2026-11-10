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
  'Сквозная проверка. Код не меняй.',
  '1) team_spec_spec_tasks по spec chain-check-20261110 — назови задачу и её статус.',
  '2) team_task_list по команде spec-chain-check — покажи, что видишь задачу TASK-1.',
  '3) Напиши WRITER: вызвать team_spec_spec_documents {action:"list", spec:"chain-check-20261110"} и записать число документов комментарием к задаче TASK-1.',
  '4) Дождись комментария, переведи TASK-1 в done (intent "updateTask", status "done") и проверь team_spec_spec_tasks с statuses ["done"].',
  'Ответь: задача, комментарий WRITER, финальный статус.',
].join('\n');
const out = await evaluate(`(async () => {
  const api = window.electronAPI.teams;
  await api.stop('spec-chain-check').catch(() => null);
  await new Promise((r) => setTimeout(r, 3000));
  try { return { launched: await api.launchTeam({ teamName: 'spec-chain-check', cwd: 'E:/repos/tokenplan', providerId: 'anthropic', model: 'deepseek-v4.1-flash@high', effort: 'high', skipPermissions: true, prompt: ${JSON.stringify(prompt)} }) }; }
  catch (error) { return { error: String((error && error.message) || error) }; }
})()`);
console.log(JSON.stringify(out));
await client.close();
