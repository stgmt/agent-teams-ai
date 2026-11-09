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
  const teams = await window.electronAPI.teams.list();
  return teams.map((t) => ({ name: t.teamName, members: t.memberCount, last: t.lastActivity, lead: t.leadSessionId }));
})()`);
console.log(JSON.stringify(out));
await client.close();
