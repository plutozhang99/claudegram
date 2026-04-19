/**
 * POST /internal/statusline
 *
 * Receives the raw stdin JSON that Claude Code pipes into its configured
 * statusline script. We extract model + context-window% + rate-limit%
 * and broadcast a `statusline` frame to all connected PWAs so the
 * compose-row can render live usage bars for the active session.
 *
 * Matching strategy: we look up the claudegram session_id by `cwd`
 * (Claude Code session UUIDs are in a different namespace than fakechat
 * ULIDs; cwd is the only field both sides agree on).
 *
 * This endpoint is loopback-only — the statusline script runs on the same
 * host as claudegram, so binding to 127.0.0.1 is sufficient authorisation.
 * Requests from non-loopback clients are rejected with 403.
 */

import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { Hub, StatuslineSnapshot } from '../ws/hub.js';
import type { CwdRegistry } from '../ws/cwd-registry.js';
import { jsonResponse } from '../http.js';

// The Claude Code statusline stdin JSON is officially undocumented and may
// grow fields over time. We parse defensively: every field we care about is
// optional, so new Claude Code versions can add fields without breaking us.
const statuslineInputSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  workspace: z
    .object({
      current_dir: z.string().optional(),
      project_dir: z.string().optional(),
    })
    .optional(),
  model: z
    .object({
      display_name: z.string().optional(),
      id: z.string().optional(),
    })
    .optional(),
  context_window: z
    .object({
      used_percentage: z.number().optional(),
    })
    .optional(),
  rate_limits: z
    .object({
      five_hour: z.object({ used_percentage: z.number().optional() }).optional(),
      seven_day: z
        .object({
          used_percentage: z.number().optional(),
          reset_at: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface StatuslineDeps {
  readonly hub: Hub;
  readonly cwdRegistry: CwdRegistry;
  readonly logger: Logger;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopbackRequest(req: Request): boolean {
  // Bun populates req.url with the requested URL; when served on loopback
  // the host is typically '127.0.0.1:<port>' or 'localhost:<port>'.
  try {
    const url = new URL(req.url);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export async function handleStatuslinePost(
  req: Request,
  deps: StatuslineDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method not allowed' });
  }

  if (!isLoopbackRequest(req)) {
    deps.logger.warn('statusline_non_loopback_rejected');
    return jsonResponse(403, { ok: false, error: 'loopback only' });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid json' });
  }

  const parsed = statuslineInputSchema.safeParse(raw);
  if (!parsed.success) {
    deps.logger.debug('statusline_invalid_shape', { err: parsed.error.message });
    return jsonResponse(400, { ok: false, error: 'invalid shape' });
  }

  const input = parsed.data;
  const cwd =
    input.cwd ?? input.workspace?.current_dir ?? input.workspace?.project_dir;

  if (cwd === undefined || cwd.length === 0) {
    return jsonResponse(400, { ok: false, error: 'cwd required' });
  }

  const session_id = deps.cwdRegistry.lookup(cwd);
  if (session_id === undefined) {
    // Unknown cwd — no fakechat registered for this directory yet. Logged at
    // info level (not debug) so operators can see when statusline POSTs are
    // arriving but no matching session exists — a strong hint that either
    // fakechat hasn't registered yet or the cwd advertised by Claude Code
    // differs from the one fakechat sent in its register frame.
    deps.logger.info('statusline_no_cwd_match', { cwd });
    return jsonResponse(200, { ok: true, matched: false });
  }

  const snapshot: StatuslineSnapshot = {
    model: input.model?.display_name ?? input.model?.id ?? null,
    ctx_pct: input.context_window?.used_percentage ?? null,
    five_h_pct: input.rate_limits?.five_hour?.used_percentage ?? null,
    seven_d_pct: input.rate_limits?.seven_day?.used_percentage ?? null,
    seven_d_reset_at:
      input.rate_limits?.seven_day?.reset_at !== undefined
        ? String(input.rate_limits.seven_day.reset_at)
        : null,
  };

  try {
    deps.hub.broadcast({ type: 'statusline', session_id, statusline: snapshot });
    // Info-level log so the happy path is visible in server output — makes
    // it trivial to verify the Claude Code statusline hook is wired up
    // correctly ("do I ever see statusline_routed entries?").
    deps.logger.info('statusline_routed', {
      session_id,
      model: snapshot.model,
      ctx_pct: snapshot.ctx_pct,
    });
  } catch (err) {
    deps.logger.warn('statusline_broadcast_failed', {
      session_id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return jsonResponse(200, { ok: true, matched: true, session_id });
}
