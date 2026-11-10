import { CdpClient } from './scripts/e2e/comment-notification/cdp.mjs';
const t = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = t.find((x) => x.type === 'page' && x.url.includes('5173'));
const client = await CdpClient.connect(page.webSocketDebuggerUrl);
const evaluate = async (e) => { const r = await client.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
const out = await evaluate(`(async () => {
  const api = window.electronAPI.teams;
  const created = await api.createTask('spec-chain-check', { subject:'Ревью: удаление и возврат', owner:'WRITER', specProject:'stgmt/tokenplan', specSlug:'registry-check-20261107', requirements:['FR-1'] }).then(t=>({id:t.id, owner:t.owner, status:t.status})).catch(e=>String(e.message||e));
  const id = created && created.id;
  const res = { created };
  if (id) {
    res.softDelete = await api.softDeleteTask('spec-chain-check', id).then(()=>'ok').catch(e=>String(e.message||e));
    res.afterDelete = await api.getTask('spec-chain-check', id).then(t=>t.status).catch(e=>String(e.message||e));
    res.restore = await api.restoreTask('spec-chain-check', id).then(()=>'ok').catch(e=>String(e.message||e));
    res.afterRestore = await api.getTask('spec-chain-check', id).then(t=>t.status).catch(e=>String(e.message||e));
  }
  return res;
})()`);
console.log(JSON.stringify(out, null, 1).slice(0,900));
await client.close();
