#!/usr/bin/env bun
/**
 * claude-harbor-statusline — binary CC invokes for its status bar.
 *
 * Reads stdin (CC statusline JSON), POSTs it to `${HARBOR_URL}/statusline`,
 * and prints the server-returned `line` to stdout (what CC renders).
 *
 * On any failure — network, timeout, malformed stdin, non-200 — prints a
 * degraded default `claude-harbor: offline` and exits 0. CC MUST keep
 * rendering a statusline even if the remote is down.
 *
 * Timeout: 500 ms (statusline fires every ~300 ms; blocking here stalls
 * CC's UI).
 */

import { readStdinAll } from "./stdin.ts";
import { postStatusline } from "./post.ts";

const DEFAULT_HARBOR_URL = "http://localhost:7823";
const DEFAULT_TIMEOUT_MS = 500;
const MAX_STDIN_BYTES = 128 * 1024; // statusline payloads are small
/** stdin deadline — statusline UI cannot stall on a dangling pipe. */
const DEFAULT_STDIN_TIMEOUT_MS = 300;
/** Hard cap on what we print to stdout for CC to render. */
const MAX_LINE_CHARS = 512;
const OFFLINE_LINE = "claude-harbor: offline";

/**
 * Remove ASCII control characters from the server-provided line before
 * printing. `\n` is preserved so multi-line statuslines stay legible;
 * everything else in 0x00-0x1F plus DEL (0x7F) is stripped. We also
 * truncate aggressively so a misbehaving server can't flood the
 * terminal. Defensive: the server is in our trust domain today, but
 * this binary runs as a CC child process and inherits its stdout.
 */
function sanitizeLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = line.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "");
  if (stripped.length <= MAX_LINE_CHARS) return stripped;
  return stripped.slice(0, MAX_LINE_CHARS);
}

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinSource?: AsyncIterable<Uint8Array>;
  readonly fetchImpl?: typeof fetch;
  readonly stdout?: (msg: string) => void;
  readonly logErr?: (msg: string) => void;
  readonly timeoutMs?: number;
  readonly stdinTimeoutMs?: number;
}

const DEFAULT_STDOUT = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};
const DEFAULT_LOG_ERR = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

/**
 * Resolve the harbor base URL from env. Validates the scheme is http(s)
 * and strips any userinfo. Any failure falls back to DEFAULT_HARBOR_URL
 * — statusline must still render.
 */
function baseUrl(
  env: NodeJS.ProcessEnv,
  logErr: (msg: string) => void,
): string {
  const raw = env.HARBOR_URL?.trim();
  if (!raw) return DEFAULT_HARBOR_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    logErr(
      `claude-harbor-statusline: HARBOR_URL is not a valid URL; falling back to ${DEFAULT_HARBOR_URL}`,
    );
    return DEFAULT_HARBOR_URL;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    logErr(
      `claude-harbor-statusline: HARBOR_URL scheme '${parsed.protocol}' not allowed; falling back to ${DEFAULT_HARBOR_URL}`,
    );
    return DEFAULT_HARBOR_URL;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    logErr(
      `claude-harbor-statusline: HARBOR_URL contained credentials in userinfo; stripping before use`,
    );
    parsed.username = "";
    parsed.password = "";
  }
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Run one statusline invocation. Always resolves with exit code 0.
 * Prints exactly one line to stdout.
 */
export async function run(opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? DEFAULT_STDOUT;
  const logErr = opts.logErr ?? DEFAULT_LOG_ERR;

  const stdinResult = await readStdinAll({
    maxBytes: MAX_STDIN_BYTES,
    source: opts.stdinSource,
    timeoutMs: opts.stdinTimeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS,
  });
  if (stdinResult.kind !== "ok") {
    logErr(`claude-harbor-statusline: stdin ${stdinResult.kind}`);
    stdout(OFFLINE_LINE);
    return 0;
  }

  const trimmed = stdinResult.text.trim();
  if (trimmed.length === 0) {
    // CC fires statusline with an empty body very early in some cases.
    // Emit offline and move on.
    stdout(OFFLINE_LINE);
    return 0;
  }
  try {
    JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`claude-harbor-statusline: invalid JSON: ${message}`);
    stdout(OFFLINE_LINE);
    return 0;
  }

  const url = `${baseUrl(env, logErr)}/statusline`;
  const result = await postStatusline({
    url,
    body: trimmed,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });

  if (result.kind === "ok") {
    // Explicitly map null / empty line to OFFLINE_LINE — the server
    // indicates "no statusline this tick" by omitting `line`, and CC
    // still needs a single non-empty line to render.
    const raw = result.line;
    if (raw === null || raw === "") {
      stdout(OFFLINE_LINE);
      return 0;
    }
    stdout(sanitizeLine(raw));
    return 0;
  }
  // Any other outcome → log, print offline.
  logErr(`claude-harbor-statusline: ${result.kind}` +
    ("status" in result ? ` ${result.status}` : "") +
    ("message" in result ? ` (${result.message})` : ""));
  stdout(OFFLINE_LINE);
  return 0;
}

if (import.meta.main) {
  const code = await run();
  process.exit(code);
}
