/**
 * Filesystem helpers for the installer.
 *
 * - Atomic writes (temp file in the same directory + rename).
 * - Safe-read of settings.json: malformed JSON yields a typed error the
 *   caller can present to the user without touching the file.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/** Max accepted size of `settings.json`. Anything bigger is surely not a
 *  CC config file and we refuse to parse it (DoS + memory). */
export const MAX_SETTINGS_BYTES = 1024 * 1024; // 1 MiB

export type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "malformed"; readonly message: string };

export function readJsonFile(path: string): ReadJsonResult {
  if (!existsSync(path)) return { kind: "missing" };
  // Size guard before we slurp: a malicious / runaway settings.json
  // should not balloon installer memory.
  try {
    const st = statSync(path);
    if (st.size > MAX_SETTINGS_BYTES) {
      return { kind: "too-large", bytes: st.size };
    }
  } catch {
    // If stat fails the readFileSync below will surface the real error.
  }
  const raw = readFileSync(path, "utf8");
  // Treat empty / whitespace-only files as an empty object — CC occasionally
  // touches settings.json but never writes to it.
  if (raw.trim().length === 0) return { kind: "ok", value: {} };
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch (err) {
    return {
      kind: "malformed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Atomic write: open a temp file in the same directory with `wx` (O_EXCL)
 * + mode 0600, write, rename. Same-directory is load-bearing (cross-device
 * rename would fail). O_EXCL defends against an attacker who pre-creates
 * a symlink at our predicted tmp path.
 *
 * Temp suffix uses `crypto.randomBytes` rather than `Math.random()` so
 * concurrent installer processes (and an attacker observing PIDs / times)
 * cannot predict the path. On the rare EEXIST we regenerate and retry
 * up to 3 times.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const base = basename(path);
  const maxAttempts = 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const tmp = join(dir, `.${base}.tmp-${randomSuffix()}`);
    let fd: number;
    try {
      fd = openSync(tmp, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        lastErr = err;
        continue;
      }
      throw err;
    }
    try {
      writeSync(fd, contents);
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort
      }
      throw err;
    }
    try {
      closeSync(fd);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort
      }
      throw err;
    }
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // fall through; the rename error is what matters
      }
      throw err;
    }
  }
  throw new Error(
    `writeFileAtomic: failed to open unique temp file after ${maxAttempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function randomSuffix(): string {
  // 16 bytes = 32 hex chars. Unpredictable, collision-free in practice.
  return randomBytes(16).toString("hex");
}

/** Short random suffix (4 hex chars) for user-visible filenames
 *  (e.g. `settings.json.bak-<iso>-<4hex>`). Collision resistance need
 *  only be enough to avoid clobbering within the same install. */
export function shortRandomSuffix(): string {
  return randomBytes(2).toString("hex");
}

/**
 * Resolve the Claude home directory. Precedence:
 *   1. Explicit `home` argument (installer `--home` flag / test override)
 *   2. `$CLAUDE_HOME` env var
 *   3. `~/.claude`
 */
export function resolveClaudeHome(
  home: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const explicit = home?.trim();
  if (explicit) return resolve(explicit);
  const envHome = env.CLAUDE_HOME?.trim();
  if (envHome) return resolve(envHome);
  return resolve(homedir(), ".claude");
}

export function settingsPath(claudeHome: string): string {
  return join(claudeHome, "settings.json");
}

export function sidecarPath(claudeHome: string): string {
  return join(claudeHome, "claude-harbor-installed.json");
}

/**
 * Create an empty settings.json (atomic) if it doesn't exist. Returns
 * true if we created it, false otherwise.
 */
export function ensureSettingsFile(claudeHome: string): boolean {
  mkdirSync(claudeHome, { recursive: true });
  const p = settingsPath(claudeHome);
  if (existsSync(p)) return false;
  // Use O_EXCL to avoid clobbering under a race.
  try {
    const fd = openSync(p, "wx", 0o600);
    closeSync(fd);
    writeJsonAtomic(p, {});
    return true;
  } catch (err) {
    // If the file now exists (lost the race), treat it as "already exists".
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** ISO-ish timestamp safe for use inside a filename. */
export function backupSuffix(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
