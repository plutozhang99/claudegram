/**
 * Resolve the real `claude` executable.
 *
 * Order:
 *   1. CLAUDE_BIN env var (must be absolute + executable) — else exit 127.
 *   2. `which claude` on PATH.
 *   3. Not found → exit 127 with install hint.
 *
 * This module is pure lookup logic. It does NOT exit the process; it returns
 * a tagged result so the caller (start.ts) controls exit codes + logging.
 */

import { existsSync, statSync, accessSync, realpathSync, constants as fsConstants } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ResolveResult =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "bin-missing"; readonly binPath: string; readonly reason: string }
  | { readonly kind: "not-found" };

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk `PATH` looking for `name`. Returns the first executable match or
 * null. Mirrors POSIX `which(1)` semantics closely enough for our needs.
 *
 * Security notes:
 *   - Relative PATH entries are rejected (CVE-style concern: a local .
 *     entry or user-relative dir could shadow a trusted binary).
 *   - On win32 we additionally probe `name.exe`.
 */
export function whichOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const pathVar = env.PATH ?? "";
  if (pathVar.length === 0) return null;
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const dirs = pathVar.split(sep).filter((d) => d.length > 0);
  const candidates = isWin ? [name, `${name}.exe`] : [name];
  for (const dir of dirs) {
    // Reject relative PATH entries. A user-controlled relative entry could
    // cause us to pick up an attacker-planted binary from cwd or similar.
    if (!isAbsolute(dir)) continue;
    for (const candidateName of candidates) {
      const candidate = join(dir, candidateName);
      if (existsSync(candidate) && isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolve the claude binary using the documented precedence rules. Pure
 * function — accepts env as a parameter for testability.
 *
 * CLAUDE_BIN is canonicalized via `realpathSync` to harden against simple
 * TOCTOU swaps between our existence check and `Bun.spawn`. This assumes
 * the parent directory of the resolved binary is not world-writable (see
 * README for the trust model).
 */
export function resolveClaude(
  env: NodeJS.ProcessEnv = process.env,
): ResolveResult {
  const explicit = env.CLAUDE_BIN?.trim();
  if (explicit && explicit.length > 0) {
    if (!isAbsolute(explicit)) {
      return {
        kind: "bin-missing",
        binPath: explicit,
        reason: "CLAUDE_BIN must be an absolute path",
      };
    }
    if (!existsSync(explicit)) {
      return {
        kind: "bin-missing",
        binPath: explicit,
        reason: "CLAUDE_BIN path does not exist",
      };
    }
    if (!isExecutableFile(explicit)) {
      return {
        kind: "bin-missing",
        binPath: explicit,
        reason: "CLAUDE_BIN path is not an executable file",
      };
    }
    let canonical: string;
    try {
      canonical = realpathSync(explicit);
    } catch {
      return {
        kind: "bin-missing",
        binPath: explicit,
        reason: "CLAUDE_BIN path could not be canonicalized",
      };
    }
    return { kind: "found", path: canonical };
  }

  const onPath = whichOnPath("claude", env);
  if (onPath) return { kind: "found", path: onPath };
  return { kind: "not-found" };
}
