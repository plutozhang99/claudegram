import path from 'node:path';
import { jsonResponse } from '../http.js';
import type { Logger } from '../logger.js';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

const NOT_FOUND = { ok: false, error: 'not found' } as const;
const METHOD_NOT_ALLOWED = { ok: false, error: 'method not allowed' } as const;

export interface StaticDeps {
  readonly webRoot: string; // absolute path
  readonly logger: Logger;
}

/**
 * Serve a file from `webRoot`. Path traversal is prevented by resolving the
 * requested absolute path and verifying it sits inside `webRoot`.
 * Returns 404 when the file is missing, a directory, or outside the root.
 */
export async function serveStaticFile(
  relPath: string,
  deps: StaticDeps,
): Promise<Response> {
  // Normalise: strip leading slashes, reject when empty → caller decides fallback.
  const clean = relPath.replace(/^\/+/, '');
  if (clean.length === 0) return jsonResponse(404, NOT_FOUND);

  const absolute = path.resolve(deps.webRoot, clean);
  // Guard: absolute must be inside webRoot. `path.resolve` collapses ../ so a
  // payload like `/web/../secrets` resolves outside the root and is rejected here.
  const rootWithSep = deps.webRoot.endsWith(path.sep)
    ? deps.webRoot
    : deps.webRoot + path.sep;
  if (absolute !== deps.webRoot && !absolute.startsWith(rootWithSep)) {
    return jsonResponse(404, NOT_FOUND);
  }

  const file = Bun.file(absolute);
  // Bun.file does not reject by existence alone — use .exists().
  if (!(await file.exists())) return jsonResponse(404, NOT_FOUND);

  // Bun.file treats directories as files with size 0 / no extension; reject.
  const ext = path.extname(absolute).toLowerCase();
  if (ext === '') return jsonResponse(404, NOT_FOUND);

  // Strict allowlist: unmapped extensions are rejected rather than served as
  // octet-stream. Prevents accidental exposure of stray `.env`, `.pem`, etc.
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    deps.logger.debug('static_unmapped_extension', { ext, absolute });
    return jsonResponse(404, NOT_FOUND);
  }

  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function handleRoot(req: Request, deps: StaticDeps): Promise<Response> {
  if (req.method !== 'GET') return jsonResponse(405, METHOD_NOT_ALLOWED);
  // `/` → index.html
  return serveStaticFile('index.html', deps);
}

export async function handleWebAsset(req: Request, deps: StaticDeps): Promise<Response> {
  if (req.method !== 'GET') return jsonResponse(405, METHOD_NOT_ALLOWED);
  const url = new URL(req.url);
  // strip `/web/` prefix
  const rel = url.pathname.replace(/^\/web\//, '');
  // Early defense: `new URL` already percent-decodes, so `/web/%2e%2e/x` arrives
  // as `../x` and is caught by `includes('..')`. `serveStaticFile` also applies
  // a path.resolve + prefix-check as an independent second layer.
  if (rel.length === 0 || rel.includes('..')) return jsonResponse(404, NOT_FOUND);
  return serveStaticFile(rel, deps);
}
