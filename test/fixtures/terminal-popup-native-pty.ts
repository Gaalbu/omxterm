import assert from "node:assert/strict";
import type { LaunchRequest } from "../../src/main/launch-request";

const prefix = "__POPUP_INPUT__";
export const POPUP_READY = "__POPUP_READY__";
export function popupLaunchRequest(): LaunchRequest {
  return {
    kind: "explicit-command",
    executable: "/usr/bin/python3",
    arguments: [
      "-u",
      "-c",
      [
        "import os, tty",
        "tty.setraw(0)",
        `os.write(1, ${JSON.stringify(POPUP_READY + "\r\nsynthetic-popup-selection\r\n\u001b[?1004l\u001b[?2004h")}.encode())`,
        "while True:",
        "    data = os.read(0, 4096)",
        "    if not data or b'\\x04' in data: break",
        `    os.write(1, (${JSON.stringify(prefix)} + data.hex() + '\\n').encode())`,
      ].join("\n"),
    ],
  };
}

export function popupPtyObservation() {
  let tail = "";
  let input = "";
  let ready = false;
  return {
    observe(data: string) {
      tail += data;
      if (tail.includes(POPUP_READY)) ready = true;
      assert.ok(
        tail.length <= 65_536,
        "Popup child output exceeded fixture budget",
      );
      let end: number;
      while ((end = tail.indexOf("\n")) !== -1) {
        const line = tail.slice(0, end).replace(/\r$/u, "");
        tail = tail.slice(end + 1);
        const start = line.indexOf(prefix);
        if (start < 0) continue;
        const hex = line.slice(start + prefix.length);
        assert.match(hex, /^(?:[a-f0-9]{2})+$/u);
        input += Buffer.from(hex, "hex").toString("latin1");
        assert.ok(
          input.length <= 16_384,
          "Popup child input exceeded fixture budget",
        );
      }
    },
    ready: () => ready,
    input: () => input,
  };
}
