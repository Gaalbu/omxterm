import assert from "node:assert/strict";

export async function until(
  check: () => Promise<boolean> | boolean,
  label: string,
  timeout = 20000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

// Disposable main-process observer only; never a replacement application entry.
export async function inspector(url: string) {
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Inspector connection deadline"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("Inspector connection failed"));
      },
      { once: true },
    );
  });
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      error?: unknown;
      result?: { exceptionDetails?: unknown; result?: { value?: unknown } };
    };
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error || message.result?.exceptionDetails)
      request.reject(
        new Error(
          JSON.stringify(message.error ?? message.result?.exceptionDetails),
        ),
      );
    else request.resolve(message.result?.result?.value);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values())
      request.reject(new Error("Inspector closed during request"));
    pending.clear();
  });
  return {
    evaluate(expression: string, timeout = 90000) {
      const id = ++sequence;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Inspector request deadline"));
        }, timeout);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    },
    close() {
      socket.close();
    },
  };
}
