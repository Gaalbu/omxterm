// Ghostty already owns CPR coordinates, including Unicode, pending wrap and
// origin margins. Never answer them from the JavaScript/render cursor hint.
export const cprCorrections = [
  {
    original: `  if (seq === "\\x1B[6n") {
    const { row, col } = handlers.getCursorPosition();
    handlers.sendReply(\`\\x1B[\${row};\${col}R\`);
    return true;
  }
`,
    corrected: "",
  },
  {
    original: "  filter(output) {",
    corrected: "  filter(output, onCoreOutput) {",
  },
  {
    original: "    filterOutput: (output) => filter.filter(output),",
    corrected:
      "    filterOutput: (output, onCoreOutput) => filter.filter(output, onCoreOutput),",
  },
  {
    original: `      const seq = data.slice(i, j + 1);
      this.altScreen = deriveAltScreen(seq, this.altScreen);`,
    corrected: `      const seq = data.slice(i, j + 1);
      if (seq === "\\x1B[6n" && onCoreOutput) {
        // Commit the filtered prefix INCLUDING this parsed query synchronously.
        // Its core reply must drain before later filter-owned replies. The
        // returned suffix excludes this prefix; one-argument callers pass CPR on.
        onCoreOutput(result + seq);
        result = "";
        i = j + 1;
        continue;
      }
      this.altScreen = deriveAltScreen(seq, this.altScreen);`,
  },
  {
    original: "            const sanitized = inputHandler.filterOutput(text);",
    corrected:
      '            const sanitized = inputHandler.filterOutput(text, (part) => sendInput(part, "pty"));',
  },
];
