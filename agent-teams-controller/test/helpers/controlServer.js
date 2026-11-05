/**
 * Starts the fake control API from {@link ./controlServerWorker.js} in a worker
 * thread and exposes its origin plus the request log.
 *
 * The worker is mandatory: registry task calls block the calling thread, so a
 * server living on the test's own thread would deadlock instead of answering.
 */

const path = require('path');
const { Worker } = require('worker_threads');

async function startControlServer(options = {}) {
  const worker = new Worker(path.join(__dirname, 'controlServerWorker.js'), {
    workerData: {
      initialTasks: options.initialTasks || [],
      failStatus: options.failStatus || 0,
    },
  });
  const port = await new Promise((resolve, reject) => {
    worker.once('message', (message) => resolve(message.port));
    worker.once('error', reject);
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    worker,
    async requests() {
      const response = await fetch(`${url}/__log`);
      const payload = await response.json();
      return payload.requests;
    },
    async stop() {
      worker.postMessage('close');
      await worker.terminate();
    },
  };
}

module.exports = { startControlServer };
