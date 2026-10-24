// L3 harness: the renderer of the real app, reached through its Chromium remote-debugging
// endpoint. The settings dialog does not talk to the control API of the app: it calls
// `window.electronAPI.teams.*` (preload bridge -> IPC -> main process). A test that wants the
// same path runs that call inside the renderer page, so the command crosses the real bridge, the
// real IPC handler and the real use case. Only the mouse click on the button is not part of it
// (the dialog itself is covered by its own component tests).

interface CdpReply {
  id: number;
  result?: {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
  };
  error?: { message: string };
}

export interface RendererBridge {
  /** Runs `expression` in the page; a promise it returns is awaited. Rejects with the page's error text. */
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

async function findPageSocket(debugPort: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no page target yet';
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl?: string;
      }[];
      const page = targets.find(
        (target) =>
          target.type === 'page' && !target.url.startsWith('devtools://') && target.webSocketDebuggerUrl
      );
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No renderer page on the debugging port ${debugPort} in ${timeoutMs} ms: ${last}`);
}

export async function connectRenderer(
  debugPort: number,
  timeoutMs = 60_000
): Promise<RendererBridge> {
  const url = await findPageSocket(debugPort, timeoutMs);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`Cannot open ${url}`)), { once: true });
  });

  let nextId = 0;
  const pending = new Map<number, { resolve: (reply: CdpReply) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(String(event.data)) as CdpReply;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    waiter.resolve(reply);
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('The renderer connection closed'));
    pending.clear();
  });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const id = (nextId += 1);
    const reply = await new Promise<CdpReply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        })
      );
    });
    if (reply.error) throw new Error(reply.error.message);
    const details = reply.result?.exceptionDetails;
    if (details) {
      throw new Error(
        details.exception?.description ?? String(details.exception?.value ?? details.text ?? 'page error')
      );
    }
    return reply.result?.result?.value as T;
  };

  return { evaluate, close: () => socket.close() };
}

/** Waits until the page has the preload bridge the settings dialog uses. */
export async function waitForSettingsBridge(bridge: RendererBridge, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await bridge.evaluate<boolean>(
      "typeof window.electronAPI?.teams?.updateMemberSettings === 'function'"
    );
    if (ready) return;
    if (Date.now() >= deadline) throw new Error('window.electronAPI.teams.updateMemberSettings is missing');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
