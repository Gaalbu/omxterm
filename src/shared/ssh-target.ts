/** Deliberately small SSH Connect grammar, not an OpenSSH config evaluator. */
export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
}

export const isSshAlias = (value: string): boolean =>
  /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,252}$/.test(value);

function isIpv6(value: string): boolean {
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

export function captureSshTarget(value: unknown): SshTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid SSH target");
  const target = value as Record<string, unknown>;
  if (
    Object.keys(target).some(
      (key) => !["host", "user", "port"].includes(key),
    ) ||
    typeof target.host !== "string" ||
    !(isSshAlias(target.host) || isIpv6(target.host)) ||
    ("user" in target &&
      (typeof target.user !== "string" ||
        !/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/.test(target.user))) ||
    ("port" in target &&
      (!Number.isInteger(target.port) ||
        (target.port as number) < 1 ||
        (target.port as number) > 65535))
  )
    throw new TypeError("Invalid SSH target");
  return {
    host: target.host,
    ...("user" in target ? { user: target.user as string } : {}),
    ...("port" in target ? { port: target.port as number } : {}),
  };
}

export function parseSshTarget(input: string): SshTarget {
  if (input.length > 384) throw new TypeError("Use at most 384 characters");
  const text = input.replace(/^ +| +$/g, "");
  const match =
    /^(?:([A-Za-z0-9_.][A-Za-z0-9_.-]{0,63})@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9_.][A-Za-z0-9_.-]{0,252})(?::([0-9]+))?$/.exec(
      text,
    );
  if (!match)
    throw new TypeError(
      "Use [user@]host[:port]; IPv6 requires brackets, without a zone identifier",
    );
  const raw = match[2]!;
  const host = raw.startsWith("[") ? raw.slice(1, -1) : raw;
  if (raw.startsWith("[") && !isIpv6(host))
    throw new TypeError("Invalid IPv6 address");
  return captureSshTarget({
    host,
    ...(match[1] === undefined ? {} : { user: match[1] }),
    ...(match[3] === undefined ? {} : { port: Number(match[3]) }),
  });
}

export function sshArguments(target: SshTarget): string[] {
  const captured = captureSshTarget(target);
  return [
    ...(captured.user === undefined ? [] : ["-l", captured.user]),
    ...(captured.port === undefined ? [] : ["-p", String(captured.port)]),
    "--",
    captured.host,
  ];
}
