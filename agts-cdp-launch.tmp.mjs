import { CdpClient } from './scripts/e2e/comment-notification/cdp.mjs';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'));
const client = await CdpClient.connect(page.webSocketDebuggerUrl);
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? ''));
  return result.value;
};
const prompt = [
  'Короткая проверка, ничего не меняй и не запускай тесты.',
  '1) В терминале выполни ровно это: env | grep OMP_SPEC || echo "no OMP_SPEC vars" — покажи сырой вывод.',
  '2) Перечисли, какие инструменты team_spec_* у тебя доступны (только имена).',
  '3) Одной строкой ответь: спека, документы, задачи.',
].join('\n');
const out = await evaluate(`(async () => {
  const request = ${JSON.stringify({ teamName: 'tokenplan-ops', cwd: 'E:/repos/tokenplan', providerId: 'anthropic', model: 'deepseek-v4.1-flash@high', effort: 'high', skipPermissions: true })};
  request.prompt = ${JSON.stringify(prompt)};
  try {
    return { launched: await window.electronAPI.teams.launchTeam(request) };
  } catch (error) {
    return { error: String(error && error.message || error) };
  }
})()`);
console.log(JSON.stringify(out, null, 1));
await client.close();
