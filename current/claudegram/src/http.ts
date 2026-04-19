import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { MessageRepo, SessionRepo } from './repo/types.js';
import type { Database } from './db/client.js';
import type { Hub } from './ws/hub.js';
import type { SessionRegistry } from './ws/session-registry.js';
import { handleHealth } from './routes/health.js';
import { handleIngest } from './routes/ingest.js';
import { handleApiSessions, handleApiSessionDelete, handleApiSessionPatch } from './routes/api/sessions.js';
import { handleApiMessages } from './routes/api/messages.js';
import { handleApiMe } from './routes/api/me.js';
import { handleRoot, handleWebAsset, serveStaticFile } from './routes/static.js';

export interface RouterCtx {
  readonly msgRepo: MessageRepo;
  readonly sessRepo: SessionRepo;
  readonly logger: Logger;
  readonly db: Database;
  readonly hub: Hub;
  readonly config: Config;
  readonly webRoot: string;
  readonly sessionRegistry: SessionRegistry;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const NOT_FOUND = { ok: false, error: 'not found' } as const;

export async function dispatch(req: Request, ctx: RouterCtx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const staticDeps = { webRoot: ctx.webRoot, logger: ctx.logger };

  // Static routes
  if (path === '/') return handleRoot(req, staticDeps);
  // Serve service worker at origin root so its default scope is `/` (can cache `/`).
  // Registered from index.html as `/sw.js`.
  if (path === '/sw.js' && req.method === 'GET') return serveStaticFile('sw.js', staticDeps);
  if (path === '/sw.js') return jsonResponse(405, { ok: false, error: 'method not allowed' });
  if (path.startsWith('/web/')) return handleWebAsset(req, staticDeps);

  // Route: /health (all methods handled inside handleHealth)
  if (path === '/health') {
    return handleHealth(req, { db: ctx.db });
  }

  // Route: /ingest (POST only; all other methods → 405 via handleIngest)
  if (path === '/ingest') {
    return handleIngest(req, ctx);
  }

  // API routes
  if (path === '/api/sessions') {
    return handleApiSessions(req, ctx);
  }

  // PATCH /api/sessions/:id  (rename)
  // DELETE /api/sessions/:id
  const sessionIdMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionIdMatch !== null) {
    const id = decodeURIComponent(sessionIdMatch[1]!);
    if (req.method === 'PATCH') {
      return handleApiSessionPatch(req, id, ctx);
    }
    return handleApiSessionDelete(req, id, ctx);
  }

  if (path === '/api/messages') {
    return handleApiMessages(req, ctx);
  }

  if (path === '/api/me') {
    return handleApiMe(req, ctx);
  }

  // Reserved prefix fallback and all unknown paths → 404.
  if (path.startsWith('/api/')) {
    return jsonResponse(404, NOT_FOUND);
  }

  return jsonResponse(404, NOT_FOUND);
}
