/**
 * P1 hook endpoints. Each route persists its payload into `messages`
 * (UserPromptSubmit) or `tool_events` (Pre/PostToolUse, Stop, Notification),
 * or updates the session row (SessionEnd). Hooks are fire-and-forget from
 * CC's perspective so every success returns **204 No Content**.
 *
 * Shared contract (enforced via `validateHookPayload`):
 *   - `Content-Type: application/json`
 *   - Body is a JSON object containing a non-empty string `session_id`
 *   - Body ≤ 64 KiB (enforced by `readJson`)
 *   - Unknown `session_id` → 404 so CC never gets a silent misattribution
 *
 * Raw JSON payloads land in `*_json` columns verbatim. Free-form text
 * fields (currently just `content` for UserPromptSubmit) are passed
 * through `stripControlChars` before persisting.
 */

import { log } from "./config.ts";
import type { Db } from "./db.ts";
import { validateHookPayload } from "./schema.ts";
import { getBus } from "./event-bus.ts";
import { getMessageById } from "./db-queries.ts";
import {
  asString,
  err,
  isTooLarge,
  noContent,
  readJson,
  safeStringify,
  shortId,
  stripControlChars,
} from "./http-utils.ts";

/**
 * Track which once-per-process fallback warnings we've already emitted so
 * we don't flood the log on hot paths.
 */
const FALLBACK_WARN_ONCE = new Set<string>();
function warnFallbackOnce(key: string, extra?: Record<string, unknown>): void {
  if (FALLBACK_WARN_ONCE.has(key)) return;
  FALLBACK_WARN_ONCE.add(key);
  log.warn(`hook: canonical field missing, using fallback (${key})`, extra);
}

/** Test-only: clear the fallback-warn-once memo so tests can reassert it. */
export function __resetHookFallbackWarnOnce(): void {
  FALLBACK_WARN_ONCE.clear();
}

/** Normalize a string-ish field with control-char strip (null-safe). */
function cleanString(v: unknown): string | null {
  const s = asString(v);
  return s === null ? null : stripControlChars(s);
}

/** Parse + validate the body; returns either an early Response or the parsed shape. */
async function parseHookBody(
  req: Request,
): Promise<Response | { session_id: string; raw: Record<string, unknown> }> {
  const body = await readJson(req);
  if (isTooLarge(body)) return err(413, "payload too large");
  const v = validateHookPayload(body);
  if (!v.ok) return err(v.status, v.error);
  return { session_id: v.session_id, raw: v.raw };
}

/** Content-Type gate. Hooks speak JSON only. */
function requireJsonContentType(req: Request): Response | null {
  const ct = req.headers.get("content-type") ?? "";
  // Accept `application/json` with optional parameters (charset=utf-8 etc).
  if (!/^application\/json\b/i.test(ct)) {
    return err(400, "content-type must be application/json");
  }
  return null;
}

/** True if a session row exists. Collapses the unknown-session branch. */
function sessionExists(db: Db, session_id: string): boolean {
  return db.getSessionById(session_id) !== null;
}

// --- /hooks/user-prompt-submit -----------------------------------------

export async function handleUserPromptSubmit(
  req: Request,
  db: Db,
): Promise<Response> {
  const bad = requireJsonContentType(req);
  if (bad) return bad;
  const parsed = await parseHookBody(req);
  if (parsed instanceof Response) return parsed;

  if (!sessionExists(db, parsed.session_id)) {
    return err(404, "unknown session_id");
  }

  // CC's UserPromptSubmit payload carries the user prompt under `prompt`
  // in current docs; older/alternate surfaces have used `message`. We
  // accept either and default to "" so an empty/missing prompt still
  // writes an auditable row. If `prompt` is absent but `message` is
  // present, warn once so we can spot drift in CC's contract.
  const promptField = asString(parsed.raw.prompt);
  const messageField = asString(parsed.raw.message);
  if (promptField === null && messageField !== null) {
    warnFallbackOnce("user-prompt-submit:message");
  }
  const rawText = promptField ?? messageField ?? "";
  const content = stripControlChars(rawText);

  const id = db.insertMessage({
    session_id: parsed.session_id,
    direction: "inbound",
    content,
    metaJson: safeStringify(parsed.raw),
    created_at: Date.now(),
  });

  const row = getMessageById(db, id, parsed.session_id);
  if (row) {
    getBus().emit({
      type: "message.created",
      session_id: parsed.session_id,
      message: row,
    });
  }

  log.info("hook: user-prompt-submit", {
    session_id: shortId(parsed.session_id),
    len: content.length,
  });
  return noContent();
}

// --- /hooks/pre-tool-use -----------------------------------------------

export async function handlePreToolUse(
  req: Request,
  db: Db,
): Promise<Response> {
  const bad = requireJsonContentType(req);
  if (bad) return bad;
  const parsed = await parseHookBody(req);
  if (parsed instanceof Response) return parsed;

  if (!sessionExists(db, parsed.session_id)) {
    return err(404, "unknown session_id");
  }

  const tool_name = cleanString(parsed.raw.tool_name);
  const tool_input =
    parsed.raw.tool_input !== undefined ? parsed.raw.tool_input : {};
  const permission_mode = cleanString(parsed.raw.permission_mode);

  db.insertToolEvent({
    session_id: parsed.session_id,
    hook_event: "PreToolUse",
    tool_name,
    tool_input_json: safeStringify(tool_input),
    tool_output_json: null,
    permission_mode,
    created_at: Date.now(),
  });

  log.info("hook: pre-tool-use", {
    session_id: shortId(parsed.session_id),
    tool: tool_name,
  });
  return noContent();
}

// --- /hooks/post-tool-use ----------------------------------------------

export async function handlePostToolUse(
  req: Request,
  db: Db,
): Promise<Response> {
  const bad = requireJsonContentType(req);
  if (bad) return bad;
  const parsed = await parseHookBody(req);
  if (parsed instanceof Response) return parsed;

  if (!sessionExists(db, parsed.session_id)) {
    return err(404, "unknown session_id");
  }

  const tool_name = cleanString(parsed.raw.tool_name);
  const tool_input =
    parsed.raw.tool_input !== undefined ? parsed.raw.tool_input : {};
  // CC docs have used both `tool_response` (current) and `tool_output`
  // historically. Accept either. Warn once if only the legacy field is
  // present so we can spot when the payload contract drifts.
  let tool_output: unknown;
  if (parsed.raw.tool_response !== undefined) {
    tool_output = parsed.raw.tool_response;
  } else if (parsed.raw.tool_output !== undefined) {
    warnFallbackOnce("post-tool-use:tool_output");
    tool_output = parsed.raw.tool_output;
  } else {
    tool_output = {};
  }
  const permission_mode = cleanString(parsed.raw.permission_mode);

  db.insertToolEvent({
    session_id: parsed.session_id,
    hook_event: "PostToolUse",
    tool_name,
    tool_input_json: safeStringify(tool_input),
    tool_output_json: safeStringify(tool_output),
    permission_mode,
    created_at: Date.now(),
  });

  log.info("hook: post-tool-use", {
    session_id: shortId(parsed.session_id),
    tool: tool_name,
  });
  return noContent();
}

// --- /hooks/stop -------------------------------------------------------

export async function handleStop(req: Request, db: Db): Promise<Response> {
  const bad = requireJsonContentType(req);
  if (bad) return bad;
  const parsed = await parseHookBody(req);
  if (parsed instanceof Response) return parsed;

  if (!sessionExists(db, parsed.session_id)) {
    return err(404, "unknown session_id");
  }

  db.insertToolEvent({
    session_id: parsed.session_id,
    hook_event: "Stop",
    tool_name: null,
    tool_input_json: safeStringify(parsed.raw),
    tool_output_json: null,
    permission_mode: null,
    created_at: Date.now(),
  });

  log.info("hook: stop", { session_id: shortId(parsed.session_id) });
  return noContent();
}

// --- /hooks/session-end ------------------------------------------------

export async function handleSessionEnd(
  req: Request,
  db: Db,
): Promise<Response> {
  const bad = requireJsonContentType(req);
  if (bad) return bad;
  const parsed = await parseHookBody(req);
  if (parsed instanceof Response) return parsed;

  // CC's SessionEnd payload carries an optional `reason` string ("clear",
  // "logout", "prompt_input_exit", "other"). Strip control chars before
  // persisting; null if absent or non-string.
  const reason = cleanString(parsed.raw.reason);

  const ok = db.markSessionEnded(parsed.session_id, Date.now(), reason);
  if (!ok) return err(404, "unknown session_id");

  getBus().emit({ type: "session.ended", session_id: parsed.session_id });

  log.info("hook: session-end", {
    session_id: shortId(parsed.session_id),
    reason,
  });
  return noContent();
}

// --- /hooks/notification -----------------------------------------------

export async function handleNotification(
  req: Request,
  db: Db,
): Promise<Response> {
  const bad = requireJsonContentType(req);
  if (bad) return bad;
  const parsed = await parseHookBody(req);
  if (parsed instanceof Response) return parsed;

  if (!sessionExists(db, parsed.session_id)) {
    return err(404, "unknown session_id");
  }

  db.insertToolEvent({
    session_id: parsed.session_id,
    hook_event: "Notification",
    tool_name: null,
    tool_input_json: safeStringify(parsed.raw),
    tool_output_json: null,
    permission_mode: null,
    created_at: Date.now(),
  });

  log.info("hook: notification", { session_id: shortId(parsed.session_id) });
  return noContent();
}
