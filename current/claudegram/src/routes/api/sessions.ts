import { z } from 'zod';
import type { RouterCtx } from '../../http.js';
import { jsonResponse } from '../../http.js';
import type { SessionRegistry } from '../../ws/session-registry.js';
import type { ApiSessionsResponse, ApiError } from './types.js';

const METHOD_NOT_ALLOWED: ApiError = { ok: false, error: 'method not allowed' };
const NOT_FOUND: ApiError = { ok: false, error: 'not found' };

const patchSessionSchema = z.object({
  name: z.string().min(1).max(200),
});

export interface ApiSessionsDeps extends Pick<RouterCtx, 'sessRepo' | 'logger'> {
  readonly sessionRegistry: SessionRegistry;
}

export function handleApiSessions(
  req: Request,
  deps: ApiSessionsDeps & Pick<RouterCtx, 'msgRepo' | 'hub'>,
): Promise<Response> | Response {
  if (req.method === 'GET') {
    return handleGet(req, deps);
  }
  if (req.method === 'DELETE') {
    return handleBulkDelete(req, deps);
  }

  return jsonResponse(405, METHOD_NOT_ALLOWED);
}

/**
 * Bulk-delete sessions. Currently supports `?offline=true` which removes every
 * session that is not currently registered in the in-memory sessionRegistry.
 * Lets users clean up historical ghost sessions (e.g. from older fakechat
 * builds that didn't gate on channels) in one call instead of clicking × per row.
 */
function handleBulkDelete(
  req: Request,
  deps: ApiSessionsDeps & Pick<RouterCtx, 'msgRepo' | 'hub'>,
): Response {
  const url = new URL(req.url);
  const offlineOnly = url.searchParams.get('offline') === 'true';
  if (!offlineOnly) {
    return jsonResponse(400, {
      ok: false,
      error: 'DELETE /api/sessions requires ?offline=true (scoped bulk delete)',
    } satisfies ApiError);
  }

  try {
    const rows = deps.sessRepo.findAll();
    const deleted: string[] = [];
    for (const s of rows) {
      if (deps.sessionRegistry.has(s.id)) continue; // skip online sessions
      try {
        deps.msgRepo.deleteBySession(s.id);
        const ok = deps.sessRepo.delete(s.id);
        if (!ok) continue; // racy delete — already gone
      } catch (err) {
        deps.logger.warn('sessions_bulk_delete_row_failed', {
          session_id: s.id,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      deleted.push(s.id);
      try {
        deps.hub.broadcast({ type: 'session_deleted', session_id: s.id });
      } catch (broadcastErr) {
        deps.logger.warn('sessions_bulk_delete_broadcast_failed', {
          session_id: s.id,
          err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
        });
      }
    }
    deps.logger.info('sessions_bulk_delete_offline', { count: deleted.length });
    return jsonResponse(200, { ok: true, deleted });
  } catch (err) {
    deps.logger.error('sessions_bulk_delete_failed', { err: String(err) });
    return jsonResponse(500, { ok: false, error: 'internal error' } satisfies ApiError);
  }
}

function handleGet(
  _req: Request,
  deps: ApiSessionsDeps,
): Promise<Response> | Response {
  try {
    const rows = deps.sessRepo.findAll();
    // Annotate each row with live connection state from the registry.
    const sessions = rows.map((s) => ({
      ...s,
      connected: deps.sessionRegistry.has(s.id),
    }));
    const body: ApiSessionsResponse = { ok: true, sessions };
    return jsonResponse(200, body);
  } catch (err: unknown) {
    deps.logger.error('sessions_list_failed', { err: String(err) });
    return jsonResponse(500, { ok: false, error: 'internal error' });
  }
}

export async function handleApiSessionPatch(
  req: Request,
  id: string,
  deps: ApiSessionsDeps & Pick<RouterCtx, 'hub'>,
): Promise<Response> {
  if (req.method !== 'PATCH') {
    return jsonResponse(405, METHOD_NOT_ALLOWED);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid JSON body' } satisfies ApiError);
  }

  const parsed = patchSessionSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400, {
      ok: false,
      error: 'validation failed',
      issues: parsed.error.issues,
    } satisfies ApiError);
  }

  const { name } = parsed.data;

  try {
    const existing = deps.sessRepo.findById(id);
    if (existing === null) {
      return jsonResponse(404, NOT_FOUND);
    }

    deps.sessRepo.rename(id, name);

    const updated = deps.sessRepo.findById(id);
    if (updated === null) {
      // Should not happen after successful rename, but guard defensively.
      return jsonResponse(500, { ok: false, error: 'internal error' } satisfies ApiError);
    }

    const session = { ...updated, connected: deps.sessionRegistry.has(id) };

    try {
      deps.hub.broadcast({ type: 'session_update', session });
    } catch (broadcastErr: unknown) {
      deps.logger.warn('session_rename_broadcast_failed', {
        session_id: id,
        err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
      });
    }

    return jsonResponse(200, { ok: true, session });
  } catch (err: unknown) {
    deps.logger.error('session_rename_failed', { session_id: id, err: String(err) });
    return jsonResponse(500, { ok: false, error: 'internal error' } satisfies ApiError);
  }
}

export async function handleApiSessionDelete(
  req: Request,
  id: string,
  deps: ApiSessionsDeps & Pick<RouterCtx, 'msgRepo' | 'hub'>,
): Promise<Response> {
  if (req.method !== 'DELETE') {
    return jsonResponse(405, METHOD_NOT_ALLOWED);
  }

  try {
    // Check it exists first.
    const existing = deps.sessRepo.findById(id);
    if (existing === null) {
      return jsonResponse(404, NOT_FOUND);
    }

    // Close and unregister any live WS for this session. closeBySession removes
    // from the map before calling ws.close() so the subsequent close-event
    // disposable path is a no-op (idempotent).
    deps.sessionRegistry.closeBySession(id, 1000, 'session_deleted');

    // Delete messages first (FK constraint: messages.session_id → sessions.id).
    deps.msgRepo.deleteBySession(id);
    const deleted = deps.sessRepo.delete(id);
    if (!deleted) {
      // Race condition: another request deleted it between findById and delete.
      return jsonResponse(404, NOT_FOUND);
    }

    // Broadcast deletion to all connected PWAs.
    try {
      deps.hub.broadcast({ type: 'session_deleted', session_id: id });
    } catch (broadcastErr: unknown) {
      deps.logger.warn('session_delete_broadcast_failed', {
        session_id: id,
        err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
      });
    }

    return jsonResponse(200, { ok: true });
  } catch (err: unknown) {
    deps.logger.error('session_delete_failed', { session_id: id, err: String(err) });
    return jsonResponse(500, { ok: false, error: 'internal error' });
  }
}
