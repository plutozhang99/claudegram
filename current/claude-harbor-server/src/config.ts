/**
 * Runtime configuration, resolved from env once at module load.
 * No secrets; internal-net-only deployment for P0.
 */

const DEFAULT_PORT = 7823;
const DEFAULT_DB_PATH = "./data/harbor.db";
const DEFAULT_CORR_WINDOW_MS = 10_000;

/**
 * 10s correlation window per PLAN §4 (can be overridden via env for tests).
 * Resolved lazily each time so tests can mutate `process.env` between runs.
 */
export function corrWindowMs(): number {
  return parseCorrWindow(process.env.HARBOR_CORR_WINDOW_MS);
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65_535) return DEFAULT_PORT;
  return n;
}

function parseCorrWindow(raw: string | undefined): number {
  if (!raw) return DEFAULT_CORR_WINDOW_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CORR_WINDOW_MS;
  return n;
}

export interface Config {
  readonly port: number;
  readonly dbPath: string;
  readonly corrWindowMs: number;
  readonly adminToken: string | null;
}

export function loadConfig(): Config {
  return Object.freeze({
    port: parsePort(process.env.HARBOR_PORT),
    dbPath: process.env.HARBOR_DB_PATH ?? DEFAULT_DB_PATH,
    corrWindowMs: parseCorrWindow(process.env.HARBOR_CORR_WINDOW_MS),
    adminToken: process.env.HARBOR_ADMIN_TOKEN?.length
      ? process.env.HARBOR_ADMIN_TOKEN
      : null,
  });
}

// Tiny structured logger — avoids raw console.log in production paths.
// Server-owned fields (`t`, `lvl`, `msg`) are written in a fixed position
// at the front of the object AND re-applied after the spread of `extra`,
// so callers cannot override them by passing e.g. `{t: 0}` via `extra`.
function compose(
  lvl: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): string {
  const t = Date.now();
  // Build in two passes so server-owned fields always win even if `extra`
  // (untrusted caller input) tries to clobber them.
  const merged: Record<string, unknown> = { t, lvl, msg };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k === "t" || k === "lvl" || k === "msg") continue;
      merged[k] = v;
    }
  }
  return JSON.stringify(merged);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) =>
    console.log(compose("info", msg, extra)),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    console.warn(compose("warn", msg, extra)),
  error: (msg: string, extra?: Record<string, unknown>) =>
    console.error(compose("error", msg, extra)),
};
