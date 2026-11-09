import { CdpClient } from './scripts/e2e/comment-notification/cdp.mjs';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'));
const client = await CdpClient.connect(page.webSocketDebuggerUrl);
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? ''));
  return result.value;
};
const out = await evaluate(`(async () => {
  const api = window.electronAPI.teams;
  const teams = await api.list();
  const detail = [];
  for (const t of teams) {
    detail.push({ name: t.name, status: t.status ?? null, projectPath: t.projectPath ?? null, members: (t.members ?? []).length });
  }
  const bindings = await api.listTeamSpecBindings('registry-probe').catch((e) => String(e));
  return { teams: detail, bindings };
})()`);
console.log(JSON.stringify(out, null, 1).slice(0, 2500));
await client.close();
