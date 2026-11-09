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
  'Живая проверка цепочки задач в реестре. Ничего не меняй в коде репозитория и не запускай тесты.',
  '1) Создай ОДНУ задачу в реестре: project "stgmt/tokenplan", spec "registry-check-20261107", requirements ["FR-1"], subject "Проверка видимости спецификации", description "BALANSER читает документы и задачи спецификации и возвращает числа".',
  '2) Назначь исполнителем BALANSER и переведи задачу в работу.',
  '3) Отправь BALANSER сообщение: номер задачи, просьба вызвать team_spec_spec_documents и team_spec_spec_tasks по spec registry-check-20261107 и записать результат комментарием к задаче.',
  '4) Дождись комментария и переведи задачу в done.',
  'В конце ответь коротко: id задачи в реестре, числа от BALANSER, какие инструменты он вызвал, финальный статус.',
].join('\n');

const out = await evaluate(`(async () => {
  const request = ${JSON.stringify({
    teamName: 'tokenplan-ops',
    cwd: 'E:/repos/tokenplan',
    providerId: 'anthropic',
    model: 'deepseek-v4.1-flash@high',
    effort: 'high',
    skipPermissions: true,
  })};
  request.prompt = ${JSON.stringify(prompt)};
  try {
    return { launched: await window.electronAPI.teams.launchTeam(request) };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
})()`);
console.log(JSON.stringify(out, null, 1));
await client.close();
