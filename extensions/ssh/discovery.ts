import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { isSshAlias } from "../../src/shared/ssh-target.js";

const reasonNames = [
  "syntax",
  "conditional",
  "unsupported",
  "cycle",
  "unreadable",
  "non-regular",
  "depth-limit",
  "file-limit",
  "byte-limit",
  "line-limit",
  "glob-limit",
  "alias-limit",
] as const;
type Reason = (typeof reasonNames)[number];
export interface AliasIndex {
  aliases: string[];
  incomplete: boolean;
  reasons: Partial<Record<Reason, number>>;
}

// This tokenizer is independently implemented for the specified static subset.
// Backslashes are intentionally unsupported rather than silently reinterpreted.
function directive(line: string): string[] | undefined {
  const header = /^\s*([A-Za-z][A-Za-z0-9]*)(?:[ \t]*=[ \t]*|[ \t]+|$)/.exec(
    line,
  );
  if (!header) return /^[ \t]*(?:#.*)?$/.test(line) ? [] : undefined;
  const body = line.slice(header[0].length);
  if (body.startsWith("=")) return undefined;
  const tokens: string[] = [header[1]!];
  let token = "";
  let quoted = false;
  let started = false;
  for (const char of body) {
    if (char === "\\") return undefined;
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && char === "#") break;
    else if (!quoted && (char === " " || char === "\t")) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }
  if (quoted || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) return undefined;
  if (started) tokens.push(token);
  return tokens;
}

/** Read-only, incomplete static index. No subprocesses or effective config. */
export async function discoverAliases(
  home: string,
  signal: AbortSignal,
): Promise<AliasIndex> {
  const result: AliasIndex = { aliases: [], incomplete: false, reasons: {} };
  const aliases = new Set<string>();
  const stack = new Set<string>();
  const base = path.join(home, ".ssh");
  let unconditional = true;
  let visits = 0;
  let bytes = 0;
  let entries = 0;
  let stopped = false;
  const note = (reason: Reason) => {
    result.incomplete = true;
    result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
  };
  const active = () => !stopped && !signal.aborted;

  async function expand(pattern: string): Promise<string[]> {
    if (
      /[\[\]{}%$\\]/.test(pattern) ||
      pattern.includes("**") ||
      (pattern.startsWith("~") && !pattern.startsWith("~/"))
    ) {
      note("unsupported");
      return [];
    }
    const absolute = pattern.startsWith("~/")
      ? path.join(home, pattern.slice(2))
      : path.resolve(base, pattern);
    let candidates = [path.parse(absolute).root];
    for (const part of absolute
      .slice(path.parse(absolute).root.length)
      .split(path.sep)) {
      if (!active()) return [];
      if (!/[?*]/.test(part)) {
        candidates = candidates.map((parent) => path.join(parent, part));
        continue;
      }
      const regex = new RegExp(
        `^${part
          .replace(/[.+^$()|]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
      );
      const next: string[] = [];
      for (const parent of candidates) {
        if (!active()) break;
        try {
          const directory = await opendir(parent);
          for await (const entry of directory) {
            if (!active()) break;
            if (++entries > 4096) {
              note("glob-limit");
              stopped = true;
              break;
            }
            if (regex.test(entry.name))
              next.push(path.join(parent, entry.name));
          }
        } catch {
          note("unreadable");
        }
      }
      candidates = next.sort();
    }
    return candidates;
  }

  async function visit(
    filename: string,
    depth: number,
    root = false,
  ): Promise<void> {
    if (!active()) return;
    if (depth > 16) {
      note("depth-limit");
      return;
    }
    if (++visits > 64) {
      note("file-limit");
      stopped = true;
      return;
    }
    let canonical: string;
    try {
      canonical = await realpath(filename);
    } catch (error) {
      if (!(root && (error as NodeJS.ErrnoException).code === "ENOENT"))
        note("unreadable");
      return;
    }
    if (stack.has(canonical)) {
      note("cycle");
      return;
    }
    stack.add(canonical);
    try {
      const file = await open(
        filename,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      let text: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) {
          note("non-regular");
          return;
        }
        const allowance = Math.min(256 * 1024, 1024 * 1024 - bytes);
        if (stat.size > allowance) {
          note("byte-limit");
          return;
        }
        // One extra byte detects growth without allocating or reading unboundedly.
        const buffer = Buffer.alloc(allowance + 1);
        let length = 0;
        while (active() && length < buffer.length) {
          const read = await file.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        bytes += length;
        if (length > allowance) {
          note("byte-limit");
          return;
        }
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        );
      } finally {
        await file.close();
      }
      for (const line of text.split(/\r?\n/)) {
        if (!active()) break;
        if (line.length > 4096) {
          note("line-limit");
          unconditional = false;
          continue;
        }
        const parts = directive(line);
        if (!parts) {
          note("syntax");
          unconditional = false;
          continue;
        }
        if (parts.length === 0) continue;
        const keyword = parts.shift()!.toLowerCase();
        if (keyword === "host" || keyword === "match") {
          unconditional =
            parts.length === 1 &&
            parts[0]!.toLowerCase() === (keyword === "host" ? "*" : "all");
          if (keyword === "host")
            for (const alias of parts) {
              if (!isSshAlias(alias)) {
                note("unsupported");
                continue;
              }
              if (aliases.has(alias)) continue;
              if (aliases.size === 256) {
                note("alias-limit");
                stopped = true;
                break;
              }
              aliases.add(alias);
              result.aliases.push(alias);
            }
        } else if (keyword === "include") {
          if (!unconditional) {
            note("conditional");
            continue;
          }
          if (!parts.length) note("syntax");
          for (const pattern of parts) {
            if (!active()) break;
            // Inline children deliberately share and may change condition state.
            for (const included of await expand(pattern))
              await visit(included, depth + 1);
          }
        }
      }
    } catch {
      note("unreadable");
    } finally {
      stack.delete(canonical);
    }
  }
  await visit(path.join(base, "config"), 0, true);
  return result;
}
