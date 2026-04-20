/**
 * Shared HTTP helpers used by the route handlers in `http.ts` and the
 * split reply-path module in `http-reply.ts`. Keep this file focused on
 * primitives only — no route-specific logic.
 */

import { randomBytes } from "node:crypto";

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

/**
 * Read + JSON-parse a request body with a strict size cap. Returns
 * `{ __tooLarge: true }` if the payload exceeds the cap, `null` on parse
 * failure, or the parsed value on success.
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
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return { __tooLarge: true };
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
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
