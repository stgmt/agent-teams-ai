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
  const api = window.electronAPI;
  const config = await api.config?.get?.().catch(() => null) ?? await api.getConfig?.().catch(() => null);
  const raw = JSON.stringify(config ?? {});
  return {
    apiTopKeys: Object.keys(api),
    hasTerra: raw.includes('terra'),
    hasDeepseek: raw.includes('deepseek'),
    providerConnections: config?.providerConnections ?? null,
    runtime: config?.runtime ?? null,
    modelish: Object.fromEntries(Object.entries(config ?? {}).filter(([k]) => /model|provider/i.test(k))),
  };
})()`);
console.log(JSON.stringify(out, null, 1).slice(0, 2500));
await client.close();
