#!/usr/bin/env bun
/**
 * claude-harbor-hook — tiny binary CC spawns per hook event.
 *
 * Invocation (wired up by the installer in ~/.claude/settings.json):
 *   claude-harbor-hook <EventName>    # e.g. SessionStart
 *
 * Reads stdin (UTF-8, JSON), validates it parses, and POSTs the raw body
 * to `${HARBOR_URL}/hooks/<kebab-case-event>` with a 2s hard deadline.
 *
 * Exit policy: always exit 0 so CC never treats us as a hook failure.
 * All diagnostics go to stderr. stdout is reserved (hooks may have it
 * consumed by CC for post-hook output hooks — empty is safe).
 */

import { EVENT_PATHS, isHookEvent, type HookEvent } from "./events.ts";
import { postJson } from "./post.ts";
import { readStdinAll } from "./stdin.ts";

const DEFAULT_HARBOR_URL = "http://localhost:7823";
const DEFAULT_TIMEOUT_MS = 2000;
/** 1 MiB — matches the proxy's stdin cap. Hook payloads are far smaller. */
const MAX_STDIN_BYTES = 1024 * 1024;
/**
 * Hard deadline on stdin read. If CC hands us a dangling pipe we must
 * not stall — 1.5 s is well under the 2 s hook budget.
 */
const DEFAULT_STDIN_TIMEOUT_MS = 1500;

export interface RunOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Test seams. */
  readonly fetchImpl?: typeof fetch;
  readonly stdinSource?: AsyncIterable<Uint8Array>;
  readonly logErr?: (msg: string) => void;
  readonly timeoutMs?: number;
  readonly stdinTimeoutMs?: number;
}

const DEFAULT_LOG_ERR = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

/**
 * Resolve the harbor base URL from env. Validates the scheme is http(s)
 * and strips any userinfo (`user:pass@`) before use. On any failure we
 * log a warning and fall back to `DEFAULT_HARBOR_URL` — hooks must never
 * fail because of bad operator config.
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
      `claude-harbor-hook: HARBOR_URL is not a valid URL; falling back to ${DEFAULT_HARBOR_URL}`,
    );
    return DEFAULT_HARBOR_URL;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    logErr(
      `claude-harbor-hook: HARBOR_URL scheme '${parsed.protocol}' not allowed; falling back to ${DEFAULT_HARBOR_URL}`,
    );
    return DEFAULT_HARBOR_URL;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    logErr(
      `claude-harbor-hook: HARBOR_URL contained credentials in userinfo; stripping before use`,
    );
    parsed.username = "";
    parsed.password = "";
  }
  // Strip trailing slash so our `${base}/hooks/...` doesn't produce `//`.
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Run one hook invocation. Always resolves to exit code 0 — see module
 * docstring. Returning a number instead of calling process.exit() keeps
 * this testable.
 */
export async function run(opts: RunOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const logErr = opts.logErr ?? DEFAULT_LOG_ERR;
  const [eventArg] = opts.argv;

  if (!eventArg) {
    logErr("claude-harbor-hook: missing event-name argument; exiting 0");
    return 0;
  }
  if (!isHookEvent(eventArg)) {
    logErr(
      `claude-harbor-hook: unknown event '${eventArg}'; exiting 0 (check installer)`,
    );
    return 0;
  }
  const event: HookEvent = eventArg;
  const path = EVENT_PATHS[event];

  const stdinResult = await readStdinAll({
    maxBytes: MAX_STDIN_BYTES,
    source: opts.stdinSource,
    timeoutMs: opts.stdinTimeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS,
  });
  if (stdinResult.kind !== "ok") {
    logErr(
      `claude-harbor-hook: stdin read failed (${stdinResult.kind}); exiting 0`,
    );
    return 0;
  }

  // Validate JSON parses. Empty / whitespace-only body is skipped silently
  // (CC occasionally fires hooks with an empty payload during session
  // shutdown).
  const trimmed = stdinResult.text.trim();
  if (trimmed.length === 0) {
    logErr(`claude-harbor-hook: empty stdin for ${event}; exiting 0`);
    return 0;
  }
  try {
    JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr(
      `claude-harbor-hook: invalid JSON for ${event}: ${message}; exiting 0`,
    );
    return 0;
  }

  const url = `${baseUrl(env, logErr)}/hooks/${path}`;
  // Best-effort fire-and-await; any failure is logged by postJson.
  await postJson({
    url,
    body: trimmed,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
    logErr,
  });
  // Any non-OK / timeout / error is best-effort; we already logged via
  // postJson. Exit 0.
  return 0;
}

if (import.meta.main) {
  const code = await run({ argv: process.argv.slice(2) });
  process.exit(code);
}
