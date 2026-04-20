/**
 * Admin routes + the gating function used by all loopback-or-token
 * protected routes (including `WS /subscribe` in P2.0).
 *
 * Gate: set `HARBOR_ADMIN_TOKEN` in the env to require a matching
 * `X-Harbor-Admin-Token` header (constant-time compare). If unset,
 * only loopback IPs are allowed.
 */

import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import type { Db } from "./db.ts";
import { pushToSession, type WsData } from "./correlate.ts";
import { loadConfig, log } from "./config.ts";
import {
  asString,
  err,
  isTooLarge,
  jsonResponse,
  noContent,
  readJson,
  requireJsonContentTypeIfPresent,
  stripControlChars,
} from "./http-utils.ts";

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("127.")
  );
}

/**
 * Admin routes are gated two ways:
 *  - If `HARBOR_ADMIN_TOKEN` env is set: require header
 *    `X-Harbor-Admin-Token` to match (constant-time compare). 401 on miss.
 *  - If unset: only allow requests whose remote IP is loopback. 403 on miss.
 *
 * Returns `null` when the request is authorized, or a Response to return.
 */
export function checkAdminAuth(
  req: Request,
  server: Server<WsData> | null,
): Response | null {
  const cfg = loadConfig();
  if (cfg.adminToken) {
    const got = req.headers.get("x-harbor-admin-token") ?? "";
    if (!got || !constantTimeEqual(got, cfg.adminToken)) {
      return err(401, "unauthorized");
    }
    return null;
  }
  // No token configured → loopback-only.
  const ip = server ? server.requestIP(req)?.address ?? null : null;
  if (!isLoopbackIp(ip)) {
    return err(403, "forbidden: admin routes restricted to loopback");
  }
  return null;
}

// --- /admin/push-message ------------------------------------------------

export async function handleAdminPush(
  req: Request,
  db: Db,
  server: Server<WsData> | null,
): Promise<Response> {
  const denied = checkAdminAuth(req, server);
  if (denied) return denied;

  const badCt = requireJsonContentTypeIfPresent(req);
  if (badCt) return badCt;
  const body = await readJson(req);
  if (isTooLarge(body)) return err(413, "payload too large");
  if (!body || typeof body !== "object") return err(400, "invalid json");
  const b = body as Record<string, unknown>;
  const session_id = asString(b.session_id);
  const content = asString(b.content);
  const metaRaw = b.meta;
  if (!session_id || !content) {
    return err(400, "missing session_id or content");
  }
  let meta: Record<string, string> | undefined;
  if (metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)) {
    meta = {};
    for (const [k, v] of Object.entries(metaRaw as Record<string, unknown>)) {
      if (typeof v === "string") meta[k] = v;
    }
  }
  const delivered = pushToSession(db, session_id, content, meta);
  return jsonResponse({ ok: true, delivered });
}

// --- /admin/account-hint ------------------------------------------------

/** Max raw byte length for an account_hint string. */
const MAX_ACCOUNT_HINT_CHARS = 512;

export async function handleAdminAccountHint(
  req: Request,
  db: Db,
  server: Server<WsData> | null,
): Promise<Response> {
  const denied = checkAdminAuth(req, server);
  if (denied) return denied;

  const badCt = requireJsonContentTypeIfPresent(req);
  if (badCt) return badCt;
  const body = await readJson(req);
  if (isTooLarge(body)) return err(413, "payload too large");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return err(400, "invalid json");
  }
  const b = body as Record<string, unknown>;
  if (!("account_hint" in b)) {
    return err(400, "missing account_hint");
  }
  const raw = b.account_hint;
  let hint: string | null;
  if (raw === null) {
    hint = null;
  } else if (typeof raw === "string") {
    if (raw.length > MAX_ACCOUNT_HINT_CHARS) {
      return err(400, "account_hint too long");
    }
    const cleaned = stripControlChars(raw).trim();
    hint = cleaned.length > 0 ? cleaned : null;
  } else {
    return err(400, "account_hint must be string or null");
  }
  db.setAccountHint(hint);
  log.info("admin: account_hint updated", { set: hint !== null });
  return noContent();
}

// --- /admin/session/:id (debug) -----------------------------------------

export function handleAdminSession(
  req: Request,
  db: Db,
  server: Server<WsData> | null,
  session_id: string,
): Response {
  const denied = checkAdminAuth(req, server);
  if (denied) return denied;
  const row = db.getSessionById(session_id);
  if (!row) return err(404, "not found");
  return jsonResponse({ ok: true, session: row });
}
