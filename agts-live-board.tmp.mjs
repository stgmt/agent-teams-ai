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
  'Живая проверка прозрачности для spec-kit. Ничего не меняй в репозитории, не запускай тесты.',
  '1) Создай на доске одну задачу: тема "Проверка видимости спецификации", исполнитель BALANSER, короткое описание что нужно прочитать спецификацию registry-check-20261107 и вернуть число документов и число задач.',
  '2) Назначь задачу на BALANSER и переведи её в работу положенным инструментом.',
  '3) Отправь BALANSER сообщение с номером задачи и просьбой: прочитать документы своей спецификации через team_spec_* инструменты и записать результат комментарием к задаче.',
  '4) Дождись его ответа и переведи задачу в done.',
  'В конце ответь: id задачи, что сделал BALANSER (числа), какие инструменты он вызвал и статус задачи.',
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
