/**
 * HTTP request handling. Pure router dispatched from Bun.serve fetch handler.
 * Every endpoint validates input and returns a typed JSON envelope.
 */

import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import type { Db, StatuslineSnapshot } from "./db.ts";
import { registerPending, pushToSession, type WsData } from "./correlate.ts";
import { log, loadConfig } from "./config.ts";
import {
  MAX_BODY_BYTES,
  asNumber,
  asString,
  err,
  freshToken,
  isTooLarge,
  jsonResponse,
  readJson,
  shortId,
} from "./http-utils.ts";
import { handleChannelReply } from "./http-reply.ts";

export { MAX_BODY_BYTES };

/** Max size of stringified limits JSON persisted per session row. */
const MAX_LIMITS_BYTES = 8_192;

// --- /hooks/session-start -----------------------------------------------

async function handleSessionStart(req: Request, db: Db): Promise<Response> {
  const body = await readJson(req);
  if (isTooLarge(body)) return err(413, "payload too large");
  if (!body || typeof body !== "object") return err(400, "invalid json");
  const b = body as Record<string, unknown>;
  const session_id = asString(b.session_id);
  const cwd = asString(b.cwd);
  const pid = asNumber(b.pid);
  const transcript_path = asString(b.transcript_path) ?? null;
  const ts = asNumber(b.ts) ?? Date.now();
  if (!session_id || !cwd || pid === null) {
    return err(400, "missing required fields: session_id, cwd, pid");
  }
  const existing = db.getSessionById(session_id);
  if (existing) {
    // Idempotency: require cwd + pid to match before leaking the channel
    // token. Mismatch → 409 with no token.
    if (existing.cwd !== cwd || existing.pid !== pid) {
      log.warn("session-start: duplicate session_id with mismatched cwd/pid", {
        session_id: shortId(session_id),
      });
      return err(409, "session_id already registered with different cwd/pid");
    }
    return jsonResponse({ channel_token: existing.channel_token });
  }
  const token = freshToken();
  const row = db.createSession({
    session_id,
    channel_token: token,
    cwd,
    pid,
    started_at: ts,
  });
  registerPending({
    session_id,
    cwd,
    pid,
    channel_token: token,
    registered_at: ts,
  });
  log.info("session-start", {
    session_id: shortId(session_id),
    pid,
    cwd,
    transcript_path,
  });
  return jsonResponse({ channel_token: row.channel_token });
}

// --- /statusline --------------------------------------------------------

function extractStatusline(b: Record<string, unknown>): {
  snap: StatuslineSnapshot;
  line: string;
  session_id: string | null;
} {
  // CC statusline JSON shape per CHANNELS-REFERENCE + CC statusline docs.
  const model = (b.model ?? {}) as Record<string, unknown>;
  const ctx = (b.context_window ?? {}) as Record<string, unknown>;
  const limits = (b.rate_limits ?? {}) as Record<string, unknown>;
  const cost = (b.cost ?? {}) as Record<string, unknown>;
  const workspace = (b.workspace ?? {}) as Record<string, unknown>;

  const model_id = asString(model.id);
  const model_display = asString(model.display_name);
  const ctx_pct = asNumber(ctx.used_percentage);
  const ctx_window_size = asNumber(ctx.context_window_size);
  const cost_usd = asNumber(cost.total_cost_usd);
  const version = asString(b.version);
  const permission_mode = asString(b.permission_mode);
  const cwd = asString(b.cwd);
  const project_dir = asString(workspace.project_dir);
  const session_id = asString(b.session_id);

  let limits_json = JSON.stringify(limits);
  if (limits_json.length > MAX_LIMITS_BYTES) {
    log.warn("statusline: limits_json exceeds cap, truncating", {
      session_id: session_id ? shortId(session_id) : null,
      size: limits_json.length,
    });
    limits_json = "{}";
  }

  const snap: StatuslineSnapshot = {
    model_id,
    model_display,
    ctx_pct,
    ctx_window_size,
    limits_json,
    cost_usd,
    version,
    permission_mode,
    cwd,
    project_dir,
  };

  const name = model_display ?? model_id ?? "claude";
  const ctxText = ctx_pct !== null ? `${Math.round(ctx_pct)}%` : "—";
  const costText = cost_usd !== null ? `$${cost_usd.toFixed(2)}` : "$—";
  const line = `${name} · ${ctxText} · ${costText}`;

  return { snap, line, session_id };
}

async function handleStatusline(req: Request, db: Db): Promise<Response> {
  const body = await readJson(req);
  if (isTooLarge(body)) return err(413, "payload too large");
  if (!body || typeof body !== "object") return err(400, "invalid json");
  const parsed = extractStatusline(body as Record<string, unknown>);
  const ts = Date.now();

  // Prefer explicit session_id; fall back to cwd match.
  let sessionId: string | null = parsed.session_id;
  if (!sessionId && parsed.snap.cwd) {
    const row = db.findRecentSession({ cwd: parsed.snap.cwd });
    sessionId = row?.session_id ?? null;
  }

  let matched = false;
  if (sessionId) {
    const updated = db.updateStatuslineSnapshot(sessionId, parsed.snap, ts);
    matched = updated !== null;
    if (!matched) {
      log.warn("statusline: session_id not found", {
        session_id: shortId(sessionId),
      });
    }
  } else {
    log.warn("statusline: no matching session", { cwd: parsed.snap.cwd });
  }
  return jsonResponse({ line: parsed.line, matched });
}

// --- admin gating -------------------------------------------------------

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
function checkAdminAuth(req: Request, server: Server<WsData> | null): Response | null {
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

async function handleAdminPush(
  req: Request,
  db: Db,
  server: Server<WsData> | null,
): Promise<Response> {
  const denied = checkAdminAuth(req, server);
  if (denied) return denied;

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

// --- /admin/session/:id (debug) -----------------------------------------

function handleAdminSession(
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

// --- Router --------------------------------------------------------------

export async function handleHttp(
  req: Request,
  db: Db,
  server: Server<WsData> | null = null,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "POST" && path === "/hooks/session-start") {
    return handleSessionStart(req, db);
  }
  if (method === "POST" && path === "/statusline") {
    return handleStatusline(req, db);
  }
  if (method === "POST" && path === "/channel/reply") {
    return handleChannelReply(req, db);
  }
  if (method === "POST" && path === "/admin/push-message") {
    return handleAdminPush(req, db, server);
  }
  if (method === "GET" && path.startsWith("/admin/session/")) {
    const sid = path.slice("/admin/session/".length);
    if (!sid) return err(400, "missing session id");
    return handleAdminSession(req, db, server, sid);
  }
  if (method === "GET" && path === "/health") {
    return jsonResponse({ ok: true, ts: Date.now() });
  }
  return err(404, "not found");
}
