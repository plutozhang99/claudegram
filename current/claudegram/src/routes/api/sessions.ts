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
  deps: ApiSessionsDeps,
): Promise<Response> | Response {
  if (req.method === 'GET') {
    return handleGet(req, deps);
  }

  return jsonResponse(405, METHOD_NOT_ALLOWED);
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

    // Close any live WS for this session (best-effort).
    // The session-socket's close handler will fire and call dispose; nothing to do here.
    // We do this by unregistering — but we don't have the WS to close it gracefully.
    // The registry's unregister removes the entry; the WS stays open until the client disconnects.
    // For now: just unregister so future sends fail fast.
    if (deps.sessionRegistry.has(id)) {
      deps.sessionRegistry.unregister(id);
    }

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
