/**
 * Shared HTTP helpers used by the route handlers in `http.ts` and the
 * split reply-path module in `http-reply.ts`. Keep this file focused on
 * primitives only — no route-specific logic.
 */

import { randomBytes } from "node:crypto";
import { log } from "./config.ts";

export interface JsonErr {
  ok: false;
  error: string;
}

/** Max body size for any JSON POST (applies to hooks + statusline + admin). */
export const MAX_BODY_BYTES = 65_536;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function err(status: number, message: string): Response {
  const body: JsonErr = { ok: false, error: message };
  return jsonResponse(body, status);
}

/** 204 No Content — fire-and-forget acks for hooks. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Strip C0 + C1 control characters plus DEL from free-form user text
 * before persisting to `content` columns or writing to log lines. JSON
 * blobs that are kept verbatim in `*_json` columns are intentionally NOT
 * passed through this — callers should only run it on extracted text
 * fields (including `tool_name`, `permission_mode`, and `cwd`).
 *
 * Ranges covered:
 *   - \x00-\x08, \x0B, \x0C, \x0E-\x1F: C0 control range minus \t \n \r
 *   - \x7F                           : DEL
 *   - \x80-\x9F                      : C1 control range
 */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHAR_REGEX, "");
}

/** Nullable variant — passes `null` / `undefined` through unchanged. */
export function stripControlCharsOrNull<T extends string | null | undefined>(
  v: T,
): T {
  if (typeof v !== "string") return v;
  return stripControlChars(v) as T;
}

/**
 * `JSON.stringify` wrapper that tolerates circular references, BigInt, and
 * other values that would throw. On failure, logs a warning and returns
 * `fallback`. Used for hook payload persistence where unparseable input
 * must not 500 the fire-and-forget request path.
 */
export function safeStringify(value: unknown, fallback = "{}"): string {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== "string") return fallback;
    return s;
  } catch (e) {
    log.warn("safeStringify: failed, using fallback", {
      err: e instanceof Error ? e.message : String(e),
    });
    return fallback;
  }
}

/**
 * Read + JSON-parse a request body with a strict size cap. Returns
 * `{ __tooLarge: true }` if the payload exceeds the cap, `null` on parse
 * failure, or the parsed value on success.
 *
 * Implementation notes:
 *   - Fast-path reject if `Content-Length` is present and exceeds cap.
 *   - Otherwise stream the body via `req.body.getReader()`, accumulating
 *     chunks while tracking running byteLength. Abort as soon as the
 *     running total exceeds `MAX_BODY_BYTES + 1` chunk worth (the chunk
 *     being read when the threshold is crossed). This prevents a client
 *     from sending a chunked body without Content-Length and forcing us
 *     to buffer unbounded bytes.
 *   - Only after full receive do we decode UTF-8 and `JSON.parse`.
 *   - Falls back to `await req.arrayBuffer()` when `req.body` is null
 *     (e.g. empty body, or runtimes without Web Streams exposure).
 */
export async function readJson(
  req: Request,
): Promise<unknown | null | { __tooLarge: true }> {
  const cl = req.headers.get("content-length");
  if (cl) {
    const n = Number.parseInt(cl, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return { __tooLarge: true };
    }
  }

  let bytes: Uint8Array;
  const body = req.body;
  if (body) {
    try {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          // Release the reader before returning. Any bytes already read
          // are discarded; we never buffered past MAX_BODY_BYTES + one
          // chunk.
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors — we're aborting anyway.
          }
          return { __tooLarge: true };
        }
        chunks.push(value);
      }
      bytes = concatChunks(chunks, total);
    } catch {
      return null;
    }
  } else {
    // No stream available — fall back to arrayBuffer. This path still
    // uses byteLength (not UTF-16 code units) so multi-byte UTF-8 payloads
    // are counted correctly.
    try {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_BODY_BYTES) return { __tooLarge: true };
      bytes = new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  if (bytes.byteLength === 0) return null;

  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function isTooLarge(v: unknown): v is { __tooLarge: true } {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).__tooLarge === true
  );
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function freshToken(): string {
  return randomBytes(24).toString("base64url");
}

export function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/**
 * Content-type gate used by endpoints that accept JSON only. Soft form:
 * if the header is absent, accept the request (backwards compatible with
 * callers that don't set content-type). If the header is present and is
 * anything other than `application/json` (optionally with parameters),
 * reject with 400.
 */
export function requireJsonContentTypeIfPresent(
  req: Request,
): Response | null {
  const ct = req.headers.get("content-type");
  if (ct === null || ct === "") return null;
  if (!/^application\/json\b/i.test(ct)) {
    return err(400, "content-type must be application/json");
  }
  return null;
}
