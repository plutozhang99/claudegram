/**
 * `claude-harbor start [...args]` — discover the real `claude` binary, spawn
 * it inheriting the current stdio, forward SIGINT/SIGTERM, and propagate
 * its exit code.
 *
 * Per CHANNELS-REFERENCE.md §1, channel plugins are activated by passing
 * `--channels plugin:<name>@<marketplace>` to `claude` at RUNTIME. Without
 * this flag the MCP server still connects but notifications are silently
 * dropped. The install script (P0.4) owns writing the plugin into
 * `~/.claude/settings.json` (`allowedChannelPlugins`), but the wrapper is
 * still responsible for turning the flag on each launch.
 *
 * We default to `plugin:claude-harbor@local` (matching the phase-plan
 * kickoff spec) and let the caller override via env:
 *
 *   HARBOR_CHANNEL_SPEC    override the plugin:<name>@<marketplace> value
 *   HARBOR_NO_CHANNEL=1    skip injecting --channels entirely (for tests)
 *
 * If the user has already passed `--channels <anything>` themselves, we
 * respect that and do not inject a duplicate.
 */

import type { Subprocess } from "bun";
import { resolveClaude } from "./which.ts";

export interface StartOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for spawn. */
  readonly spawn?: typeof Bun.spawn;
  /** Test seam for stderr logging. */
  readonly logErr?: (msg: string) => void;
}

export interface StartResult {
  /** Exit code to propagate. */
  readonly code: number;
}

const DEFAULT_CHANNEL_SPEC = "plugin:claude-harbor@local";

/**
 * Accepts `plugin:<name>@<marketplace>` where name and marketplace are
 * restricted to ASCII alphanumerics plus `.`, `_`, `-`. Deliberately narrow
 * — we shell this into `claude` as an argv element, and tightening the
 * grammar here is cheap insurance against surprises from env-supplied
 * values (quoting, whitespace, path traversal-ish characters).
 */
const CHANNEL_SPEC_RE = /^plugin:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

// Map from termination signal name → conventional exit code (128 + signo).
const SIGNAL_EXIT_CODE: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

const DEFAULT_LOG_ERR = (msg: string): void => {
  // All wrapper logs go to stderr. stdout belongs to claude.
  process.stderr.write(`${msg}\n`);
};

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the argv to pass to `claude`. Injects `--channels <spec>` unless:
 *   - HARBOR_NO_CHANNEL=1, or
 *   - the user already passed `--channels` themselves.
 */
export function buildChildArgv(
  userArgv: readonly string[],
  env: NodeJS.ProcessEnv,
): readonly string[] {
  if (env.HARBOR_NO_CHANNEL === "1") return userArgv;
  const alreadyHas = userArgv.some(
    (a) => a === "--channels" || a.startsWith("--channels="),
  );
  if (alreadyHas) return userArgv;
  // `||` (not `??`) is intentional: we want an empty-string / whitespace-only
  // HARBOR_CHANNEL_SPEC to fall back to the default rather than being used
  // as a literal empty spec. `.trim()` returns "" (falsy) in that case.
  const spec = env.HARBOR_CHANNEL_SPEC?.trim() || DEFAULT_CHANNEL_SPEC;
  return ["--channels", spec, ...userArgv];
}

/**
 * Filter undefined values from an env-like object and produce the
 * string-only shape Bun.spawn expects. Avoids a blanket `as` cast.
 */
function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}

/**
 * Run `claude-harbor start`. Returns an exit code; the caller (index.ts) is
 * responsible for calling process.exit so this function stays testable.
 */
export async function runStart(opts: StartOptions): Promise<StartResult> {
  const env = opts.env ?? process.env;
  const logErr = opts.logErr ?? DEFAULT_LOG_ERR;
  const spawn = opts.spawn ?? Bun.spawn;

  // Validate HARBOR_CHANNEL_SPEC before we attempt anything else. A bad
  // override is a user-config error, not a claude-exec failure, so we
  // surface it with a dedicated exit code (2) and a clear message.
  const rawSpec = env.HARBOR_CHANNEL_SPEC?.trim();
  if (
    rawSpec !== undefined &&
    rawSpec.length > 0 &&
    env.HARBOR_NO_CHANNEL !== "1" &&
    !CHANNEL_SPEC_RE.test(rawSpec)
  ) {
    logErr(
      `claude-harbor: invalid HARBOR_CHANNEL_SPEC ${JSON.stringify(rawSpec)}; ` +
        `expected plugin:<name>@<marketplace> (name/marketplace: [A-Za-z0-9._-]+).`,
    );
    return { code: 2 };
  }

  const resolved = resolveClaude(env);
  if (resolved.kind === "bin-missing") {
    logErr(
      `claude-harbor: cannot exec claude: ${resolved.reason} (${resolved.binPath})`,
    );
    return { code: 127 };
  }
  if (resolved.kind === "not-found") {
    logErr(
      "claude-harbor: 'claude' not found on PATH and CLAUDE_BIN is not set.\n" +
        "Install Claude Code from https://code.claude.com or set CLAUDE_BIN=/absolute/path/to/claude.",
    );
    return { code: 127 };
  }

  const childArgv = buildChildArgv(opts.argv, env);

  // Log the effective channel spec at startup (stderr only; stdout belongs
  // to claude). Useful for debugging "why did my notifications disappear?".
  if (env.HARBOR_NO_CHANNEL !== "1") {
    const effectiveSpec =
      (env.HARBOR_CHANNEL_SPEC?.trim() ? env.HARBOR_CHANNEL_SPEC.trim() : undefined) ??
      DEFAULT_CHANNEL_SPEC;
    const userOverride = childArgv.some(
      (a, i) =>
        (a === "--channels" || a.startsWith("--channels=")) &&
        // only count as "user override" if it's NOT the one we just injected
        !(i === 0 && childArgv[0] === "--channels" && childArgv[1] === effectiveSpec),
    );
    if (!userOverride) {
      logErr(`claude-harbor: using channel spec: ${effectiveSpec}`);
    }
  }

  // Register signal forwarders BEFORE spawn so there's no window in which
  // SIGINT/SIGTERM/SIGHUP received between spawn() and listener install
  // would kill the wrapper without reaching the child.
  let child: Subprocess | undefined;
  const forwardSignal = (sig: NodeJS.Signals): void => {
    if (!child) return;
    try {
      child.kill(sig);
    } catch (err) {
      logErr(`claude-harbor: failed to forward ${sig}: ${stringifyErr(err)}`);
    }
  };
  const onSigint = (): void => forwardSignal("SIGINT");
  const onSigterm = (): void => forwardSignal("SIGTERM");
  const onSighup = (): void => forwardSignal("SIGHUP");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  try {
    child = spawn({
      cmd: [resolved.path, ...childArgv],
      stdio: ["inherit", "inherit", "inherit"],
      env: sanitizeEnv(env),
    });

    const code = await child.exited;
    if (typeof code === "number") return { code };
    // Bun returns null for exitCode when the child was terminated by a
    // signal. Map common signals to their conventional 128+signo codes;
    // fall back to 128 for anything we don't recognize. No signal + null
    // exit code is treated as a clean exit (0).
    const sig = child.signalCode;
    if (sig && typeof sig === "string") {
      return { code: SIGNAL_EXIT_CODE[sig] ?? 128 };
    }
    return { code: 0 };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  }
}
