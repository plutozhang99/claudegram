/**
 * Frontend-facing REST endpoints introduced in P2.0:
 *
 *   GET /sessions
 *   GET /sessions/:session_id
 *   GET /sessions/:session_id/messages
 *
 * P2 is still single-user internal-network per PLAN §12, so these routes
 * are intentionally NOT authenticated — the loopback bind is the only
 * access control. Do not widen the bind without adding real auth (P5).
 */

import type { Db, SessionListStatus } from "./db.ts";
import {
  getSessionWithCounts,
  listMessages,
  listSessions,
} from "./db-queries.ts";
import { err, jsonResponse } from "./http-utils.ts";

/** Default / clamp values. */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MSG_LIMIT = 100;
const MAX_MSG_LIMIT = 500;

/** Allowed status filter values (plus the alias `all`). */
const ALLOWED_STATUS: ReadonlySet<string> = new Set([
  "active",
  "idle",
  "ended",
  "unbound",
  "all",
]);

/**
 * Session ids must match the hook contract — a bounded subset of printable
 * ASCII. Same regex as exists in the CC docs for session ids: letters,
 * digits, `.`, `_`, `-`. Length 1..128.
 */
const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_REGEX.test(id);
}

/**
 * Parse a query-string integer within [min, max]. Returns null if the
 * value is present but invalid; returns `fallback` when absent.
 */
function parseBoundedInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === "") return fallback;
  // Reject floats, signs, whitespace — must be a plain non-negative integer.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Like parseBoundedInt but clamps values > max down to max. Values < min
 * still reject (returning null) so callers can 400 on e.g. `limit=0`.
 */
function parseClampedInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min) return null;
  if (n > max) return max;
  return n;
}

// --- GET /sessions -------------------------------------------------------

export function handleListSessions(req: Request, db: Db): Response {
  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status") ?? "all";
  if (!ALLOWED_STATUS.has(statusRaw)) {
    return err(400, "invalid status");
  }
  const status = statusRaw as SessionListStatus;

  const limit = parseClampedInt(
    url.searchParams.get("limit"),
    DEFAULT_LIST_LIMIT,
    1,
    MAX_LIST_LIMIT,
  );
  if (limit === null) return err(400, "invalid limit");

  // Offset: non-negative integer, no cap beyond SQLite's practical limit.
  const offset = parseBoundedInt(
    url.searchParams.get("offset"),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (offset === null) return err(400, "invalid offset");

  const { sessions, total } = listSessions(db, { status, limit, offset });
  return jsonResponse({ sessions, total });
}

// --- GET /sessions/:id ---------------------------------------------------

export function handleGetSession(
  _req: Request,
  db: Db,
  session_id: string,
): Response {
  if (!isValidSessionId(session_id)) {
    return err(400, "invalid session_id");
  }
  const out = getSessionWithCounts(db, session_id);
  if (!out) return err(404, "not found");
  return jsonResponse({ session: out.session, counts: out.counts });
}

// --- GET /sessions/:id/messages -----------------------------------------

export function handleListMessages(
  req: Request,
  db: Db,
  session_id: string,
): Response {
  if (!isValidSessionId(session_id)) {
    return err(400, "invalid session_id");
  }
  // Session-existence gate so frontend gets 404, not an empty page.
  if (!db.getSessionById(session_id)) {
    return err(404, "not found");
  }
  const url = new URL(req.url);
  const limit = parseClampedInt(
    url.searchParams.get("limit"),
    DEFAULT_MSG_LIMIT,
    1,
    MAX_MSG_LIMIT,
  );
  if (limit === null) return err(400, "invalid limit");

  const beforeRaw = url.searchParams.get("before");
  let before: number | null = null;
  if (beforeRaw !== null && beforeRaw !== "") {
    if (!/^\d+$/.test(beforeRaw)) return err(400, "invalid before");
    const n = Number.parseInt(beforeRaw, 10);
    if (!Number.isFinite(n) || n < 0) return err(400, "invalid before");
    before = n;
  }

  const out = listMessages(db, { session_id, before, limit });
  return jsonResponse({
    messages: out.messages,
    next_before: out.next_before,
  });
}

// --- Router helpers ------------------------------------------------------

/**
 * Decide whether a GET path matches one of the /sessions* routes and
 * dispatch. Returns null if no route matches — caller continues.
 */
export function tryHandleSessions(req: Request, db: Db): Response | null {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/sessions") {
    return handleListSessions(req, db);
  }

  // /sessions/:id  and  /sessions/:id/messages
  if (path.startsWith("/sessions/")) {
    const rest = path.slice("/sessions/".length);
    if (rest.length === 0) return null;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(rest);
      } catch {
        return err(400, "invalid path");
      }
      return handleGetSession(req, db, decoded);
    }
    let id: string;
    try {
      id = decodeURIComponent(rest.slice(0, slash));
    } catch {
      return err(400, "invalid path");
    }
    const tail = rest.slice(slash + 1);
    if (tail === "messages") {
      return handleListMessages(req, db, id);
    }
    return null;
  }
  return null;
}

export const __test = {
  parseBoundedInt,
  parseClampedInt,
  isValidSessionId,
};
