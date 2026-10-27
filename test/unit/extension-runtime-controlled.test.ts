import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenVersion } from "../../src/installed-packages/installed-packages.js";
import {
  active,
  deferred,
  fixture,
  flush,
  observe,
  pin,
  selection,
} from "../fixtures/extension-runtime-controlled.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("extension runtime admission", () => {
  it("starts lazily and coalesces activation, holding the parent pin until independent-pin acknowledgement and recheck", async () => {
    const f = fixture();
    const checked = deferred<boolean>();
    vi.mocked(f.guard.revalidate).mockReturnValue(checked.promise);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.openVersion).not.toHaveBeenCalled();
    const first = f.runtime.activate(selection.id);
    expect(f.runtime.activate(selection.id)).toBe(first);
    await flush();
    const child = f.children[0]!;
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(child.kinds()).toEqual(["initialize"]);
    expect(f.guard.release).not.toHaveBeenCalled();
    expect(f.guard.revalidate).not.toHaveBeenCalled();
    child.reply("pinned");
    await flush();
    expect(child.kinds()).toEqual(["initialize"]);
    expect(f.guard.release).not.toHaveBeenCalled();
    checked.resolve(true);
    await flush();
    expect(child.kinds()).toEqual(["initialize", "admit"]);
    expect(f.guard.release).toHaveBeenCalled();
    child.reply("active");
    expect((await first).selection).toEqual(selection);
  });

  it.each(["stale", "disabled", "updated"])(
    "does not admit a %s selection after held parent recheck",
    async () => {
      const f = fixture();
      const checked = deferred<boolean>();
      vi.mocked(f.guard.revalidate).mockReturnValue(checked.promise);
      const pending = observe(f.runtime.activate(selection.id));
      await flush();
      const child = f.children[0]!;
      child.reply("pinned");
      await flush();
      checked.resolve(false); // Store owns the reason; runtime consumes its validity receipt.
      await flush();
      expect(await pending).toMatchObject({ code: "unavailable" });
      expect(child.kinds()).not.toContain("admit");
      expect(f.guard.release).toHaveBeenCalled();
    },
  );

  it("cancels before acquisition and releases a late pin without spawning", async () => {
    const f = fixture();
    const acquired = deferred<OpenVersion>();
    f.openVersion.mockReturnValue(acquired.promise);
    const pending = observe(f.runtime.activate(selection.id));
    const retirement = f.runtime.retire(selection.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await retirement).toMatchObject({
      settled: false,
      processStarted: false,
      exitObserved: false,
    });
    expect(await pending).toMatchObject({ code: "unavailable" });
    acquired.resolve(f.guard);
    await flush();
    expect(f.guard.release).toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["call", "reactivate"])(
    "rechecks the exact registry selection on every %s",
    async (operation) => {
      const f = await active();
      f.openVersion.mockRejectedValueOnce(new Error("disabled or replaced"));
      const pending =
        operation === "call"
          ? f.backend.call("payload")
          : f.runtime.activate(selection.id);
      expect(await observe<unknown>(pending)).toMatchObject({
        code: "unavailable",
      });
      expect(f.openVersion).toHaveBeenLastCalledWith(selection.id, selection);
      expect(f.child.kinds()).not.toContain("call");
    },
  );

  it("captures caller values before held admission and rejects oversized values without acquiring or sending", async () => {
    const f = await active();
    const count = f.openVersion.mock.calls.length;
    expect(
      await observe(f.backend.call("x".repeat(1024 * 1024))),
    ).toMatchObject({ code: "protocol" });
    expect(f.openVersion).toHaveBeenCalledTimes(count);
    expect(f.child.kinds()).not.toContain("call");
    const acquired = deferred<OpenVersion>();
    f.openVersion.mockReturnValueOnce(acquired.promise);
    const value = { nested: ["original"] };
    const pending = f.backend.call(value);
    value.nested[0] = "mutated";
    acquired.resolve(pin());
    await flush();
    const call = f.child.sent.find((message) => message.kind === "call")!;
    expect(call.value).toEqual({ nested: ["original"] });
    f.child.reply("result", { request: call.request, ok: true, value: "ok" });
    expect(await pending).toBe("ok");
  });

  it("bounds held admissions at 32 and cancels them without dispatch on stop", async () => {
    const f = await active();
    const acquired = deferred<OpenVersion>();
    f.openVersion.mockReturnValue(acquired.promise);
    const calls = Array.from({ length: 32 }, () =>
      observe(f.backend.call(null)),
    );
    expect(await observe(f.backend.call(null))).toMatchObject({ code: "busy" });
    const retirement = f.backend.retire();
    expect(await Promise.all(calls)).toEqual(
      Array.from({ length: 32 }, (): unknown =>
        expect.objectContaining({ code: "unavailable" }),
      ),
    );
    f.child.exit(0, null);
    f.child.close();
    await flush();
    let settled = false;
    void retirement.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    acquired.resolve(pin());
    await flush();
    expect(f.child.kinds()).not.toContain("call");
    expect(await retirement).toMatchObject({ settled: true });
  });

  it("counts cancelled outstanding requests until actual replies release their slots", async () => {
    const f = await active();
    const controller = new AbortController();
    const calls = Array.from({ length: 32 }, () =>
      observe(f.backend.call(null, controller.signal)),
    );
    await flush();
    controller.abort();
    expect(await Promise.all(calls)).toEqual(
      Array.from({ length: 32 }, (): unknown =>
        expect.objectContaining({ code: "outcome-unknown" }),
      ),
    );
    expect(await observe(f.backend.call(null))).toMatchObject({ code: "busy" });
    const sent = f.child.sent.filter((message) => message.kind === "call");
    expect(sent).toHaveLength(32);
    f.child.reply("result", {
      request: sent[0]!.request,
      ok: true,
      value: null,
    });
    const next = f.backend.call("next");
    await flush();
    const last = f.child.sent.at(-1)!;
    expect(last.kind).toBe("call");
    f.child.reply("result", { request: last.request, ok: true, value: "done" });
    expect(await next).toBe("done");
  });

  it("cancels a held call admission without later dispatch", async () => {
    const f = await active();
    const acquired = deferred<OpenVersion>();
    f.openVersion.mockReturnValueOnce(acquired.promise);
    const controller = new AbortController();
    const pending = observe(f.backend.call(null, controller.signal));
    controller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" });
    acquired.resolve(pin());
    await flush();
    expect(f.child.kinds()).not.toContain("call");
  });
});

describe("extension runtime protocol and deadlines", () => {
  it("bounds simultaneous activation ownership at 32 even before pins arrive", async () => {
    const f = fixture();
    const acquired = deferred<OpenVersion>();
    f.openVersion.mockReturnValue(acquired.promise);
    const pending = Array.from({ length: 32 }, (_, i) =>
      observe(f.runtime.activate(`test.backend-${i}`)),
    );
    expect(await observe(f.runtime.activate("test.overflow"))).toMatchObject({
      code: "busy",
    });
    expect(f.openVersion).toHaveBeenCalledTimes(32);
    const disposal = f.runtime.dispose();
    acquired.resolve(f.guard);
    await flush();
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 32 }, (): unknown =>
        expect.objectContaining({ code: "unavailable" }),
      ),
    );
    expect((await disposal).every((receipt) => receipt.settled)).toBe(true);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("owner abort during held parent recheck cannot admit after a late valid receipt", async () => {
    const f = fixture();
    const checked = deferred<boolean>();
    vi.mocked(f.guard.revalidate).mockReturnValue(checked.promise);
    const pending = observe(f.runtime.activate(selection.id));
    await flush();
    const child = f.children[0]!;
    child.spawn();
    child.reply("pinned");
    await flush();
    f.owner.abort();
    checked.resolve(true);
    await flush();
    expect(await pending).toMatchObject({ code: "unavailable" });
    expect(child.kinds()).not.toContain("admit");
    child.exit(0, null);
    child.close();
    await flush();
    expect(f.guard.release).toHaveBeenCalled();
  });

  it("rejects already cancelled calls before store acquisition", async () => {
    const f = await active();
    const count = f.openVersion.mock.calls.length;
    expect(
      await observe(f.backend.call(null, AbortSignal.abort())),
    ).toMatchObject({ code: "cancelled" });
    expect(f.openVersion).toHaveBeenCalledTimes(count);
    expect(f.child.kinds()).not.toContain("call");
  });

  it.each(["epoch", "gap", "replay", "duplicate"])(
    "revokes on %s replies without treating them as successful work",
    async (fault) => {
      const f = await active();
      const first = observe(f.backend.call(null));
      await flush();
      const call = f.child.sent.at(-1)!;
      if (fault === "duplicate") {
        f.child.reply("result", {
          request: call.request,
          ok: true,
          value: "first",
        });
        expect(await first).toBe("first");
      }
      const second = observe(f.backend.call(null));
      await flush();
      f.child.reply("result", {
        request: call.request,
        ok: true,
        value: "untrusted",
        ...(fault === "epoch" ? { epoch: "b".repeat(36) } : {}),
        ...(fault === "gap" ? { sequence: 99 } : {}),
        ...(fault === "replay" ? { sequence: 2 } : {}),
      });
      await flush();
      expect(await second).toMatchObject({ code: "outcome-unknown" });
      if (fault !== "duplicate")
        expect(await first).toMatchObject({ code: "outcome-unknown" });
      expect(f.child.kinds()).toContain("stop");
      expect(await observe(f.backend.call(null))).toMatchObject({
        code: "unavailable",
      });
    },
  );

  it("bounds startup at ten seconds without fabricating an exit", async () => {
    const f = fixture();
    const pending = observe(f.runtime.activate(selection.id));
    await flush();
    f.children[0]!.spawn();
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.children[0]!.kinds()).not.toContain("stop");
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ code: "activation-failed" });
    const retirement = f.runtime.retire(selection.id);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await retirement).toMatchObject({
      settled: false,
      exitObserved: false,
    });
  });

  it("bounds an unanswered request at ten seconds and cancels main calls on stop", async () => {
    const f = await active();
    const pending = observe(f.backend.call(null));
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ code: "outcome-unknown" });
    expect(f.child.kinds()).toContain("stop");
    expect(f.child.kill).not.toHaveBeenCalled();
  });
});

describe("extension runtime actual retirement receipts", () => {
  it("bounds failed kill with a two-second grace, five-second exit join and two-second close join", async () => {
    const f = await active();
    f.child.kill.mockReturnValue(false);
    const retirement = f.backend.retire();
    let done = false;
    void retirement.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await retirement).toMatchObject({
      settled: false,
      killRequested: true,
      killAccepted: false,
      exitObserved: false,
      streamsClosed: false,
    });
    expect(f.child.disconnect).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  });

  it("disconnect revokes calls but cannot manufacture exit or stream receipts", async () => {
    const f = await active();
    const pending = observe(f.backend.call(null));
    await flush();
    f.child.lost();
    expect(await pending).toMatchObject({ code: "outcome-unknown" });
    const retirement = f.backend.retire();
    await vi.advanceTimersByTimeAsync(9000);
    expect(await retirement).toMatchObject({
      settled: false,
      processStarted: true,
      exitObserved: false,
      streamsClosed: false,
    });
  });

  it("a post-spawn error is not a failed-spawn settlement even after close", async () => {
    const f = await active();
    f.child.error();
    const retirement = f.backend.retire();
    f.child.close();
    await vi.advanceTimersByTimeAsync(9000);
    expect(await retirement).toMatchObject({
      settled: false,
      processStarted: true,
      exitObserved: false,
      streamsClosed: true,
      killRequested: true,
    });
  });

  it("settles failed spawn error plus close without inventing an actual exit", async () => {
    const f = fixture();
    const pending = observe(f.runtime.activate(selection.id));
    await flush();
    const child = f.children[0]!;
    child.error();
    const retirement = f.runtime.retire(selection.id);
    child.close();
    await flush();
    expect(await pending).toMatchObject({ code: "activation-failed" });
    expect(await retirement).toMatchObject({
      settled: true,
      processStarted: false,
      exitObserved: false,
      exitCode: null,
      streamsClosed: true,
      cooperative: false,
      killRequested: false,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not confuse cooperative acknowledgement with actual exit or close", async () => {
    const f = await active();
    const retirement = f.backend.retire();
    let done = false;
    void retirement.then(() => {
      done = true;
    });
    f.child.reply("deactivated");
    await flush();
    expect(done).toBe(false);
    f.child.exit(0, null);
    await flush();
    expect(done).toBe(false);
    f.child.close();
    await flush();
    expect(await retirement).toMatchObject({
      settled: true,
      cooperative: true,
      exitObserved: true,
      streamsClosed: true,
      killRequested: false,
    });
  });

  it("does not label exit zero after escalation as cooperation", async () => {
    const f = await active();
    const retirement = f.backend.retire();
    f.child.reply("deactivated");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    f.child.exit(0, null);
    f.child.close();
    await flush();
    expect(await retirement).toMatchObject({
      settled: true,
      exitCode: 0,
      killRequested: true,
      killAccepted: true,
      cooperative: false,
    });
  });

  it("cancels escalation on actual exit while still joining late stream closure", async () => {
    const f = await active();
    const retirement = f.backend.retire();
    await vi.advanceTimersByTimeAsync(1999);
    f.child.exit(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.child.kill).not.toHaveBeenCalled();
    f.child.close();
    await flush();
    expect(await retirement).toMatchObject({
      settled: true,
      exitObserved: true,
      exitSignal: "SIGTERM",
      streamsClosed: true,
    });
  });

  it.each(["none", "close-only", "exit-only"])(
    "bounds missing lifetime receipts (%s) without repeated kill",
    async (receipt) => {
      const f = await active();
      const retirement = f.backend.retire();
      expect(f.backend.retire()).toBe(retirement);
      if (receipt === "close-only") f.child.close();
      if (receipt === "exit-only") f.child.exit(0, null);
      await vi.advanceTimersByTimeAsync(9000);
      expect(await retirement).toMatchObject({
        settled: false,
        exitObserved: receipt === "exit-only",
        streamsClosed: receipt === "close-only",
        cooperative: false,
        killRequested: receipt !== "exit-only",
      });
      expect(f.child.kill).toHaveBeenCalledTimes(
        receipt === "exit-only" ? 0 : 1,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.child.kill).toHaveBeenCalledTimes(
        receipt === "exit-only" ? 0 : 1,
      );
      expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
        code: "unavailable",
      });
    },
  );

  it("revokes pending main calls on explicit retirement", async () => {
    const f = await active();
    const pending = observe(f.backend.call("work"));
    await flush();
    const retirement = f.backend.retire();
    expect(await pending).toMatchObject({ code: "outcome-unknown" });
    f.child.exit(0, null);
    f.child.close();
    await flush();
    expect(await retirement).toMatchObject({
      settled: true,
      cooperative: false,
    });
  });

  it("admits a fresh epoch only after actual settlement", async () => {
    const f = await active();
    const retirement = f.backend.retire();
    expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
      code: "unavailable",
    });
    f.child.exit(0, null);
    f.child.close();
    await flush();
    await retirement;
    const next = f.runtime.activate(selection.id);
    await flush();
    const child = f.children[1]!;
    child.spawn();
    child.reply("pinned");
    await flush();
    child.reply("active");
    expect((await next).epoch).not.toBe(f.backend.epoch);
    expect(await observe(f.backend.call(null))).toMatchObject({
      code: "unavailable",
    });
  });

  it.each(["abort", "dispose"])(
    "permanently revokes owner authority on %s",
    async (operation) => {
      const f = await active();
      if (operation === "abort") f.owner.abort();
      const disposal = f.runtime.dispose();
      expect(await observe(f.runtime.activate("test.other"))).toMatchObject({
        code: "unavailable",
      });
      expect(await observe(f.backend.call(null))).toMatchObject({
        code: "unavailable",
      });
      f.child.exit(0, null);
      f.child.close();
      await flush();
      expect(await disposal).toEqual([
        expect.objectContaining({ settled: true }),
      ]);
      expect(f.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("never acquires or spawns for an already aborted owner", async () => {
    const f = fixture();
    f.owner.abort();
    expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
      code: "unavailable",
    });
    expect(f.openVersion).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
