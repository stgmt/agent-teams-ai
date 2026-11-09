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

for (let i = 0; i < 60; i += 1) {
  if (await evaluate('Boolean(window.electronAPI?.teams)')) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const out = await evaluate(`(async () => {
  const api = window.electronAPI.teams;
  const credential = await api.getSpecRegistryCredentialStatus?.().catch((e) => String(e));
  const teams = await api.getTeams?.().catch((e) => String(e));
  return {
    apiNames: Object.keys(api).sort(),
    credential,
    teams: Array.isArray(teams) ? teams.map((t) => t.name) : teams,
    bodySnippet: document.body.innerText.slice(0, 600),
  };
})()`);

console.log(JSON.stringify(out, null, 1));
await client.close();
