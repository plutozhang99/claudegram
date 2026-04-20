/**
 * `/channel/reply` handler.
 *
 * Auth model: the caller supplies the session's `channel_token` (learned
 * from the WS `bound` ack). We:
 *   1. Validate meta caps and return 400 on violation BEFORE hitting the DB.
 *   2. Look up the row by token, then do a constant-time byte compare to
 *      collapse all auth-failure branches into a single 401 ("invalid
 *      channel_token") with identical response text.
 */

import { timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import {
  asString,
  err,
  isTooLarge,
  jsonResponse,
  readJson,
  requireJsonContentTypeIfPresent,
} from "./http-utils.ts";
import { getBus } from "./event-bus.ts";
import { getMessageById } from "./db-queries.ts";

/** Max entries / key length / value bytes for reply meta dictionaries. */
const REPLY_META_MAX_ENTRIES = 16;
const REPLY_META_MAX_KEY_LEN = 256;
const REPLY_META_MAX_VALUE_BYTES = 4 * 1024;
/** Dummy buffer used for constant-time token compare when no row matched. */
const DUMMY_TOKEN = Buffer.alloc(32, 0);

/**
 * Validate a reply-path meta dict. Returns the sanitized map, or an error
 * message if any cap is violated.
 */
export function validateReplyMeta(
  raw: unknown,
):
  | { ok: true; meta?: Record<string, string> }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "meta must be an object" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > REPLY_META_MAX_ENTRIES) {
    return { ok: false, error: "meta has too many entries" };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string") continue;
    if (k.length > REPLY_META_MAX_KEY_LEN) {
      return { ok: false, error: "meta key too long" };
    }
    if (Buffer.byteLength(v, "utf8") > REPLY_META_MAX_VALUE_BYTES) {
      return { ok: false, error: "meta value too large" };
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? { ok: true, meta: out } : { ok: true };
}

/**
 * Constant-time token compare. When `expected` is null we still run a
 * timingSafeEqual against a padded dummy buffer so attackers can't
 * distinguish "no row" from "wrong token" by timing. Returns false on
 * mismatch/no-row.
 */
export function tokenMatches(
  submitted: string,
  expected: string | null,
): boolean {
  const a = Buffer.from(submitted, "utf8");
  if (expected === null) {
    const dummy =
      DUMMY_TOKEN.length >= a.length
        ? DUMMY_TOKEN.subarray(0, a.length)
        : Buffer.concat([
            DUMMY_TOKEN,
            Buffer.alloc(a.length - DUMMY_TOKEN.length, 0),
          ]);
    try {
      timingSafeEqual(a, dummy);
    } catch {
      // ignore — length mismatch defends by itself
    }
    return false;
  }
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still consume roughly the same work to avoid a trivial length-leak.
    try {
      const pad = Buffer.alloc(a.length, 0);
      timingSafeEqual(a, pad);
    } catch {
      // ignore
    }
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function handleChannelReply(
  req: Request,
  db: Db,
): Promise<Response> {
  const badCt = requireJsonContentTypeIfPresent(req);
  if (badCt) return badCt;
  const body = await readJson(req);
  if (isTooLarge(body)) return err(413, "payload too large");
  if (!body || typeof body !== "object") return err(400, "invalid json");
  const b = body as Record<string, unknown>;
  const channel_token = asString(b.channel_token);
  const content = asString(b.content);
  const metaRaw = b.meta;
  if (!channel_token || !content) {
    return err(400, "missing channel_token or content");
  }
  // Validate meta BEFORE running the DB lookup so malformed meta is a 400,
  // not a timing side channel on the token.
  const metaResult = validateReplyMeta(metaRaw);
  if (!metaResult.ok) return err(400, metaResult.error);

  const row = db.getSessionByToken(channel_token);
  // Constant-time compare. Collapse all auth-failure branches to one 401
  // with the same message so no branch leaks via timing or message text.
  const matched = tokenMatches(channel_token, row?.channel_token ?? null);
  if (!row || !matched) return err(401, "invalid channel_token");

  const id = db.insertMessage({
    session_id: row.session_id,
    direction: "outbound",
    content,
    meta: metaResult.meta,
    created_at: Date.now(),
  });
  const msgRow = getMessageById(db, id, row.session_id);
  if (msgRow) {
    getBus().emit({
      type: "message.created",
      session_id: row.session_id,
      message: msgRow,
    });
  }
  return jsonResponse({ ok: true, id });
}
