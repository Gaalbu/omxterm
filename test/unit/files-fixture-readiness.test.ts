// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";

it("rejects unavailable fixture controls instead of reporting an ignored click as admission", async () => {
  const source = await readFile("test/fixtures/files-production.mjs", "utf8");
  const start = source.indexOf("  function click(contents, label)");
  const end = source.indexOf("  const hosted", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  type Contents = { executeJavaScript(script: string): Promise<unknown> };
  const createClick = new Function(
    `return (${source.slice(start, end)})`,
  ) as () => (contents: Contents, label: string) => Promise<unknown>;
  const click = createClick();
  const contents: Contents = {
    executeJavaScript: async (script) => {
      const evaluate = new Function("document", `return (${script})`) as (
        document: Document,
      ) => unknown;
      return evaluate(document);
    },
  };
  const panel = document.createElement("section");
  const button = document.createElement("button");
  const invoked = vi.fn<() => void>();
  button.textContent = "Disable";
  button.onclick = invoked;
  panel.append(button);
  document.body.append(panel);
  try {
    button.disabled = true;
    await expect(click(contents, "Disable")).rejects.toThrow(
      "button unavailable",
    );
    button.disabled = false;
    panel.setAttribute("inert", "");
    await expect(click(contents, "Disable")).rejects.toThrow(
      "button unavailable",
    );
    expect(invoked).not.toHaveBeenCalled();
    panel.removeAttribute("inert");
    await click(contents, "Disable");
    expect(invoked).toHaveBeenCalledOnce();
  } finally {
    panel.remove();
  }
});

it("releases the actual fixture entry module before Electron can satisfy window readiness", async () => {
  const source = await readFile("test/fixtures/files-production.mjs", "utf8");
  // Exercise the real entry coordination after the finite production import,
  // without importing Electron, starting a window or running the scenario.
  const boundary =
    'await import(pathToFileURL(path.join(source, "dist/main/index.js")).href);';
  const pieces = source.split(boundary);
  expect(pieces).toHaveLength(2);
  const entry = "const ready = new Promise(() => {});\n" + pieces[1]!;
  const url =
    "data:text/javascript;base64," + Buffer.from(entry).toString("base64");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      import(/* @vite-ignore */ url).then(() => "entry-released"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("blocked-on-readiness"), 500);
      }),
    ]);
    expect(result).toBe("entry-released");
  } finally {
    clearTimeout(timer);
  }
});
