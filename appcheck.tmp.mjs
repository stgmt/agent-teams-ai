import { CdpClient } from './scripts/e2e/comment-notification/cdp.mjs';
const t = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = t.find((x) => x.type === 'page' && x.url.includes('5173'));
const client = await CdpClient.connect(page.webSocketDebuggerUrl);
const evaluate = async (e) => { const r = await client.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
const prompt = [
  'Проверка внутреннего пути приложения (не прокси реестра).',
  '1) task_set_owner: teamName "spec-chain-check", taskId "registry-check-20261107:TASK-4", owner "WRITER".',
  '2) task_add_comment: teamName "spec-chain-check", taskId "registry-check-20261107:TASK-4", from "user", text "Проверка внутреннего пути приложения".',
  '3) task_get по этому же id — покажи owner и комментарии.',
  'Ответь: что вернули шаги 1 и 2 (или текст ошибки), и итоговый owner задачи.',
].join('\n');
const out = await evaluate(`(async () => { const api = window.electronAPI.teams; await api.stop('spec-chain-check').catch(() => null); await new Promise(r => setTimeout(r, 3000)); try { return { launched: await api.launchTeam({ teamName: 'spec-chain-check', cwd: 'E:/repos/tokenplan', providerId: 'anthropic', model: 'deepseek-v4.1-flash@high', effort: 'high', skipPermissions: true, prompt: ${JSON.stringify(prompt)} }) }; } catch (e) { return { error: String(e && e.message || e) }; } })()`);
console.log(JSON.stringify(out)); await client.close();
