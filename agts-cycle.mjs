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
  'Сквозная проверка цикла. Действуй по шагам, в коде репозитория ничего не меняй.',
  'Шаг 1. Вызови team_spec_spec_catalog (view "specs"), team_spec_spec_documents {action:"list"} и team_spec_spec_tasks для привязанной спеки. Запиши числа.',
  'Шаг 2. Создай новую спеку: team_spec_spec_patch, intent "createSpec", spec "chain-check-20261110", title "Chain check". Затем добавь требование: intent "amendRequirement", requirement "FR-1", body — один абзац, объясняющий механизм проверки цикла.',
  'Шаг 3. Проверь валидность: team_spec_spec_inspect { check: "validation", spec: "chain-check-20261110" }. Если невалидна — исправь одним патчем.',
  'Шаг 4. Создай задачу в реестре: intent "confirmTaskCreation", entity "TASK-1", spec "chain-check-20261110", subject "Прочитать новую спеку", requirements ["FR-1"], description "WRITER читает документы и возвращает число документов", owner "WRITER".',
  'Шаг 5. Напиши WRITER сообщение с id задачи и просьбой вызвать team_spec_spec_documents {action:"list", spec:"chain-check-20261110"} и записать результат комментарием к задаче.',
  'Шаг 6. Дождись комментария, переведи задачу в done (intent "updateTask", status "done").',
  'Ответь по пунктам: числа старой спеки; что создал; результат валидации; id задачи и статус; ответ WRITER; инструменты WRITER.',
].join('\n');

const out = await evaluate(`(async () => {
  const api = window.electronAPI.teams;
  const linked = await api.linkTeamSpec('spec-chain-check', { project: 'stgmt/tokenplan', spec: 'registry-check-20261107' }).catch((e) => String(e));
  let launched;
  try {
    launched = await api.launchTeam({
      teamName: 'spec-chain-check',
      cwd: 'E:/repos/tokenplan',
      providerId: 'anthropic',
      model: 'deepseek-v4.1-flash@high',
      effort: 'high',
      skipPermissions: true,
      prompt: ${JSON.stringify(prompt)},
    });
  } catch (error) {
    launched = String((error && error.message) || error);
  }
  return { linked, launched };
})()`);
console.log(JSON.stringify(out, null, 1));
await client.close();
