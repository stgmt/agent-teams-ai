/**
 * Blocking HTTP request against the desktop app's control API.
 *
 * The controller's task store is synchronous (every MCP tool, board refresh and
 * briefing reads it without awaiting), so the registry backend cannot use a
 * promise-returning client. A single dedicated worker thread performs the
 * `fetch` and reports back through a `MessagePort`; the calling thread parks on
 * `Atomics.wait` until that message arrives or the deadline passes.
 *
 * The worker is created lazily, reused for the life of the process, and
 * unref'ed so it never keeps the CLI alive.
 */

const { MessageChannel, Worker, receiveMessageOnPort } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 15_000;
/** Extra room for the worker to finish aborting before the caller stops waiting. */
const WAIT_MARGIN_MS = 250;

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');

const signal = new Int32Array(workerData.signal);
const port = workerData.port;

port.on('message', async (request) => {
  let message;
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    const body = await response.text();
    message = { id: request.id, ok: response.ok, status: response.status, body };
  } catch (error) {
    message = {
      id: request.id,
      transportError:
        error && typeof error.message === 'string' ? error.message : String(error),
    };
  }
  try {
    port.postMessage(message);
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});
`;

let channel = null;

function workerError(message) {
  const error = new Error(message);
  error.code = 'SYNC_CONTROL_REQUEST_FAILED';
  return error;
}

function createChannel() {
  const signalBuffer = new SharedArrayBuffer(4);
  const signal = new Int32Array(signalBuffer);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { signal: signalBuffer, port: port2 },
    transferList: [port2],
  });
  worker.unref();
  const state = { signal, port: port1, worker, nextId: 1 };
  // A dead worker must not poison every later request: drop the channel and let
  // the next call build a fresh one.
  const reset = () => {
    if (channel === state) channel = null;
    try {
      state.port.close();
    } catch {
      // Closing an already-closed port is not an error worth surfacing.
    }
  };
  worker.on('error', reset);
  worker.on('exit', reset);
  return state;
}

function getChannel() {
  if (!channel) channel = createChannel();
  return channel;
}

function drainForId(state, id) {
  let received;
  while ((received = receiveMessageOnPort(state.port))) {
    const message = received.message;
    if (message && message.id === id) return message;
  }
  return null;
}

/**
 * Performs one request and blocks the calling thread until it settles.
 *
 * `request` is injectable so the backend can be tested without a socket; the
 * default transport is the worker bridge above.
 */
function syncControlRequest(request) {
  const timeoutMs =
    Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
      ? Math.floor(request.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const state = getChannel();
  const id = state.nextId;
  state.nextId += 1;

  state.port.postMessage({
    id,
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    timeoutMs,
  });

  const deadline = Date.now() + timeoutMs + WAIT_MARGIN_MS;
  for (;;) {
    // Clear the flag *before* inspecting the port: a response that lands between
    // the drain and the wait must leave the flag set so the wait returns at once
    // instead of parking for the whole deadline.
    Atomics.store(state.signal, 0, 0);
    // A response for an earlier, already-abandoned request may still be queued;
    // only the message carrying our id answers this call.
    const message = drainForId(state, id);
    if (message) {
      if (message.transportError !== undefined) {
        throw workerError(message.transportError);
      }
      return { status: message.status, ok: message.ok === true, body: message.body };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw workerError(`control request to ${request.url} timed out after ${timeoutMs}ms`);
    }
    Atomics.wait(state.signal, 0, 0, remainingMs);
  }
}

/** Test hook: forget the worker so the next call starts from a clean channel. */
function resetSyncControlRequestChannel() {
  if (!channel) return;
  const state = channel;
  channel = null;
  try {
    state.port.close();
  } catch {
    // Best effort teardown only.
  }
  state.worker.terminate().catch(() => undefined);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  resetSyncControlRequestChannel,
  syncControlRequest,
};
