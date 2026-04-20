/**
 * Runtime configuration + tiny stderr-only logger.
 *
 * CRITICAL: the proxy must NEVER write to stdout — stdout is the MCP
 * transport. All logs go to stderr.
 */

const DEFAULT_HARBOR_URL = "http://localhost:7823";

export interface ProxyConfig {
  readonly harborUrl: string;
}

function normalizeUrl(raw: string): string {
  // Strip trailing slash for consistent concatenation.
  return raw.replace(/\/+$/, "");
}

/**
 * Validate that a HARBOR_URL string parses as http:// or https:// only.
 * Other schemes (ws://, file://, javascript:, etc.) are rejected to avoid
 * foot-guns and SSRF-style surprises at startup.
 */
export function validateHarborUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid HARBOR_URL: not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `invalid HARBOR_URL: scheme must be http:// or https://, got ${parsed.protocol}`,
    );
  }
}

export function loadConfig(): ProxyConfig {
  const raw = process.env.HARBOR_URL?.trim();
  const source = raw && raw.length > 0 ? raw : DEFAULT_HARBOR_URL;
  validateHarborUrl(source);
  const harborUrl = normalizeUrl(source);
  return Object.freeze({ harborUrl });
}

/** Convert an http(s):// base URL to ws(s):// for the /channel endpoint. */
export function toWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith("https://")) return "wss://" + baseUrl.slice("https://".length);
  if (baseUrl.startsWith("http://")) return "ws://" + baseUrl.slice("http://".length);
  // Fall back to ws:// if no scheme.
  return "ws://" + baseUrl;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{\"lvl\":\"error\",\"msg\":\"logger stringify failed\"}";
  }
}

function compose(
  lvl: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): string {
  try {
    const t = Date.now();
    const merged: Record<string, unknown> = { t, lvl, msg };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (k === "t" || k === "lvl" || k === "msg") continue;
        merged[k] = v;
      }
    }
    return safeStringify(merged);
  } catch {
    // Last-ditch fallback: a minimal well-formed JSON line.
    return `{"t":${Date.now()},"lvl":"${lvl}","msg":"logger compose failed"}`;
  }
}

function safeWrite(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // Swallow: writing to stderr must never break the proxy.
  }
}

/** Stderr-only logger. Never touches stdout. */
export const log = {
  info: (msg: string, extra?: Record<string, unknown>) =>
    safeWrite(compose("info", msg, extra)),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    safeWrite(compose("warn", msg, extra)),
  error: (msg: string, extra?: Record<string, unknown>) =>
    safeWrite(compose("error", msg, extra)),
};
