/**
 * Inbound push frame sanitization.
 *
 * Applied to every server-origin push before it reaches the MCP stdout
 * writer. Caps sizes, strips disallowed control characters, and bounds the
 * `meta` dictionary. Defence-in-depth: even a trusted harbor must not be
 * able to wedge CC with pathological payloads.
 */

import { log } from "./config.ts";

export const MAX_CONTENT_LEN = 65_536;
export const MAX_META_ENTRIES = 16;
export const MAX_META_KEY_LEN = 256;
export const MAX_META_VALUE_BYTES = 4 * 1024;

/**
 * Strip ASCII control characters 0x00–0x1F (except \n 0x0A and \t 0x09)
 * and DEL (0x7F). Preserves all higher code points including UTF-8.
 */
export function stripControlChars(input: string): string {
  let out = "";
  let stripped = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0x0a || code === 0x09) {
      out += input[i];
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      stripped += 1;
      continue;
    }
    out += input[i];
  }
  if (stripped > 0) {
    log.warn("sanitize: stripped control chars", { stripped });
  }
  return out;
}

/**
 * Cap content length. Returns the truncated string; logs a warn on truncation.
 */
export function capContent(content: string): string {
  if (content.length <= MAX_CONTENT_LEN) return content;
  log.warn("sanitize: truncating oversized content", {
    original: content.length,
    cap: MAX_CONTENT_LEN,
  });
  return content.slice(0, MAX_CONTENT_LEN);
}

/**
 * Sanitize a meta dict: reject (drop) entries with keys longer than
 * `MAX_META_KEY_LEN`, truncate values longer than `MAX_META_VALUE_BYTES`,
 * and cap the total number of entries at `MAX_META_ENTRIES`.
 * Returns a new object; never mutates input.
 */
export function sanitizeMeta(
  meta: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  let rejectedKeys = 0;
  let truncatedValues = 0;
  let overflowed = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v !== "string") continue;
    if (k.length > MAX_META_KEY_LEN) {
      rejectedKeys += 1;
      continue;
    }
    if (count >= MAX_META_ENTRIES) {
      overflowed += 1;
      continue;
    }
    let value = v;
    // Cap in UTF-8 byte terms via char-length approximation first, then
    // tighten if the encoded size exceeds the cap.
    if (value.length > MAX_META_VALUE_BYTES) {
      value = value.slice(0, MAX_META_VALUE_BYTES);
      truncatedValues += 1;
    }
    let encoded = Buffer.byteLength(value, "utf8");
    while (encoded > MAX_META_VALUE_BYTES && value.length > 0) {
      value = value.slice(0, Math.max(1, Math.floor(value.length * 0.9)));
      encoded = Buffer.byteLength(value, "utf8");
      truncatedValues += 1;
    }
    out[k] = stripControlChars(value);
    count += 1;
  }
  if (rejectedKeys > 0 || truncatedValues > 0 || overflowed > 0) {
    log.warn("sanitize: meta sanitation applied", {
      rejectedKeys,
      truncatedValues,
      overflowed,
    });
  }
  return out;
}

/**
 * Redact a session_id for logging: first 8 chars + `…`.
 * Mirrors the server-side `shortId` convention.
 */
export function shortSessionId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}
