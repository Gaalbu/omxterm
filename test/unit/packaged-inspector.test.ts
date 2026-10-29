import { afterEach, expect, it, vi } from "vitest";
import { inspector, until } from "../fixtures/packaged-inspector.js";

class Socket extends EventTarget {
  static latest: Socket;
  sent: { id: number; method: string; params: unknown }[] = [];
  constructor() {
    super();
    Socket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as (typeof this.sent)[number]);
  }
  reply(value: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
}
const url = "ws://127.0.0.1:12345/abcdef-1234";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("accepts only the exact loopback inspector URL shape", async () => {
  for (const invalid of [
    "ws://localhost:12345/abcdef",
    "ws://0.0.0.0:12345/abcdef",
    "wss://127.0.0.1:12345/abcdef",
    "ws://127.0.0.1:12345/abcdef?secret=1",
  ])
    await expect(inspector(invalid)).rejects.toThrow();
});
it("matches replies by id and preserves evaluation exceptions", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const client = await inspector(url);
  const first = client.evaluate("first()");
  const second = client.evaluate("second()");
  const failure = expect(second).rejects.toThrow("fixture-error");
  expect(Socket.latest.sent[0]).toEqual({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: "first()", awaitPromise: true, returnByValue: true },
  });
  Socket.latest.reply({ id: 2, result: { exceptionDetails: "fixture-error" } });
  Socket.latest.reply({ id: 999, result: { result: { value: "unowned" } } });
  Socket.latest.reply({
    id: 1,
    result: { result: { value: { packaged: true } } },
  });
  await expect(first).resolves.toEqual({ packaged: true });
  await failure;
  client.close();
});
it("fails outstanding requests on close and deadline, not false success", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const client = await inspector(url);
  const first = client.evaluate("pending()");
  const rejected = expect(first).rejects.toThrow(
    "Inspector closed during request",
  );
  client.close();
  await rejected;
  const next = await inspector(url);
  vi.useFakeTimers();
  const expired = expect(next.evaluate("hung()", 20)).rejects.toThrow(
    "Inspector request deadline",
  );
  await vi.advanceTimersByTimeAsync(20);
  await expired;
  next.close();
});
it("bounds condition observation without changing failed predicates", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const failure = expect(
    until(
      () => {
        calls++;
        return false;
      },
      "no receipt",
      50,
    ),
  ).rejects.toThrow("Timed out: no receipt");
  await vi.advanceTimersByTimeAsync(50);
  await failure;
  expect(calls).toBe(2);
  await expect(until(() => true, "ready")).resolves.toBeUndefined();
});
