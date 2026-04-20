/**
 * HTTP request handling. Pure router dispatched from Bun.serve fetch handler.
 * Every endpoint validates input and returns a typed JSON envelope.
 */

import type { Server } from "bun";
import type { Db, StatuslineSnapshot } from "./db.ts";
import { registerPending, type WsData } from "./correlate.ts";
import { log } from "./config.ts";
import {
  MAX_BODY_BYTES,
  asNumber,
  asString,
  err,
  freshToken,
  isTooLarge,
  jsonResponse,
  readJson,
  requireJsonContentTypeIfPresent,
  shortId,
  stripControlChars,
} from "./http-utils.ts";
import {
  checkAdminAuth,
  handleAdminAccountHint,
  handleAdminPush,
  handleAdminSession,
} from "./http-admin.ts";
import { handleChannelReply } from "./http-reply.ts";
import {
  handleNotification,
  handlePostToolUse,
  handlePreToolUse,
  handleSessionEnd,
  handleStop,
  handleUserPromptSubmit,
} from "./http-hooks.ts";
import { tryHandleSessions } from "./http-sessions.ts";
import { extractStatuslineBroadcast, getBus } from "./event-bus.ts";
import { toPublicSessionRow } from "./db-queries.ts";
import type { StaticServer } from "./http-static.ts";

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
    cwd: stripControlChars(cwd),
    transcript_path: transcript_path ? stripControlChars(transcript_path) : null,
  });
  getBus().emit({
    type: "session.created",
    session_id,
    session: toPublicSessionRow(row),
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
  const badCt = requireJsonContentTypeIfPresent(req);
  if (badCt) return badCt;
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
    } else if (updated) {
      const bus = getBus();
      bus.emit({
        type: "statusline.updated",
        session_id: updated.session_id,
        statusline: extractStatuslineBroadcast(updated),
      });
      bus.emit({
        type: "session.updated",
        session_id: updated.session_id,
        session: toPublicSessionRow(updated),
      });
    }
  } else {
    log.warn("statusline: no matching session", {
      cwd: parsed.snap.cwd ? stripControlChars(parsed.snap.cwd) : null,
    });
  }
  return jsonResponse({ line: parsed.line, matched });
}

// --- CORS (dev-mode only on GET) ---------------------------------------

/**
 * Whether permissive CORS should be applied on this response. Activated
 * only when `HARBOR_DEV=1` AND the server is bound to loopback. Never
 * applied to POST responses (per P2 spec — writes stay same-origin).
 */
export function corsEnabled(bind: string): boolean {
  if (process.env.HARBOR_DEV !== "1") return false;
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

/**
 * Resolve the dev CORS origin. Prefer `HARBOR_DEV_ORIGIN_PORT` (defaults to
 * Flutter web dev server on 63595); fall back to 8080 when unset.
 * Admin tokens are never advertised in `Access-Control-Allow-Headers` —
 * browser-side Flutter never carries that header.
 */
function devOriginHeaders(): Record<string, string> {
  const rawPort = process.env.HARBOR_DEV_ORIGIN_PORT;
  // If env is set and valid, echo that port; else fall back to 8080.
  const origin =
    rawPort && /^\d+$/.test(rawPort)
      ? `http://localhost:${rawPort}`
      : "http://localhost:8080";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function applyCorsHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(devOriginHeaders())) {
    res.headers.set(k, v);
  }
  return res;
}

/** Export for testing so we don't re-resolve from process.env in tests. */
export { devOriginHeaders };

// --- expose admin auth for ws-subscribe upgrade path -------------------

/**
 * Re-exported wrapper so `ws-subscribe` can reuse the same gate without
 * importing the private `checkAdminAuth` symbol.
 */
export function adminAuthGate(
  req: Request,
  server: Server<WsData> | null,
): Response | null {
  return checkAdminAuth(req, server);
}

// --- Router --------------------------------------------------------------

export interface HandleHttpOptions {
  /** If set, handles SPA / static serving under `/`. */
  staticServer?: StaticServer | null;
  /** If set, the resolved bind host — used for CORS gating. */
  bind?: string | null;
}

export async function handleHttp(
  req: Request,
  db: Db,
  server: Server<WsData> | null = null,
  opts: HandleHttpOptions = {},
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const bind = opts.bind ?? null;
  const cors = bind ? corsEnabled(bind) : false;

  // OPTIONS preflight: only 204 + permissive headers when CORS is enabled.
  if (method === "OPTIONS") {
    if (cors) {
      const res = new Response(null, { status: 204 });
      applyCorsHeaders(res);
      return res;
    }
    return err(405, "method not allowed");
  }

  // Route dispatch --------------------------------------------------------
  const res = await dispatch(req, db, server, method, path, opts);
  // CORS is applied to GETs ONLY (and only when dev+loopback). Never to
  // POST, WS upgrades, or static fallback that happened at this layer.
  if (cors && method === "GET") applyCorsHeaders(res);
  return res;
}

async function dispatch(
  req: Request,
  db: Db,
  server: Server<WsData> | null,
  method: string,
  path: string,
  opts: HandleHttpOptions,
): Promise<Response> {
  if (method === "POST" && path === "/hooks/session-start") {
    return handleSessionStart(req, db);
  }
  if (method === "POST" && path === "/hooks/user-prompt-submit") {
    return handleUserPromptSubmit(req, db);
  }
  if (method === "POST" && path === "/hooks/pre-tool-use") {
    return handlePreToolUse(req, db);
  }
  if (method === "POST" && path === "/hooks/post-tool-use") {
    return handlePostToolUse(req, db);
  }
  if (method === "POST" && path === "/hooks/stop") {
    return handleStop(req, db);
  }
  if (method === "POST" && path === "/hooks/session-end") {
    return handleSessionEnd(req, db);
  }
  if (method === "POST" && path === "/hooks/notification") {
    return handleNotification(req, db);
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
  if (method === "POST" && path === "/admin/account-hint") {
    return handleAdminAccountHint(req, db, server);
  }
  if (method === "GET" && path.startsWith("/admin/session/")) {
    const sid = path.slice("/admin/session/".length);
    if (!sid) return err(400, "missing session id");
    return handleAdminSession(req, db, server, sid);
  }
  if (method === "GET" && path === "/health") {
    return jsonResponse({ ok: true, ts: Date.now() });
  }

  // P2 frontend REST.
  const sessRes = tryHandleSessions(req, db);
  if (sessRes) return sessRes;

  // Static / SPA fallback.
  if (opts.staticServer) {
    const sres = await opts.staticServer.handle(req);
    if (sres) return sres;
  }

  return err(404, "not found");
}
