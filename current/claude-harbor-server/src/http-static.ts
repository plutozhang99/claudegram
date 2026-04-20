/**
 * Static file serving for the Flutter web bundle.
 *
 * If `current/claude-harbor-frontend/build/web/index.html` exists at
 * process boot, this module serves the `build/web/` directory at `/`.
 * Unknown non-asset GETs fall through to `index.html` so Flutter-web's
 * client-side routing works.
 *
 * If the bundle is absent, `GET /` returns `{ frontend: "not built yet" }`
 * and all other paths return 404 (caller still handles API routes first).
 *
 * The existence check happens ONCE on boot (`createStaticServer`), so the
 * per-request path is minimal.
 */

import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { log } from "./config.ts";
import { err, jsonResponse } from "./http-utils.ts";

/**
 * Default location of the Flutter build relative to the repo root. The
 * server entry point can override this if needed (e.g. containers that
 * COPY the bundle to a different path).
 */
export const DEFAULT_FRONTEND_BUILD_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "claude-harbor-frontend",
  "build",
  "web",
);

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Extensions we consider "real assets" — i.e. NOT candidates for SPA fallback. */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(MIME_BY_EXT));

export interface StaticServer {
  /** True when `index.html` was found at boot. */
  readonly available: boolean;
  /** Serve a GET request under `/`. Returns null if method !== GET. */
  handle(req: Request): Promise<Response | null>;
}

/** Factory: resolves whether the bundle exists and returns a server. */
export function createStaticServer(
  buildDir: string = DEFAULT_FRONTEND_BUILD_DIR,
): StaticServer {
  const rootAbs = resolve(buildDir);
  const indexPath = join(rootAbs, "index.html");
  const available = (() => {
    try {
      return existsSync(indexPath) && statSync(indexPath).isFile();
    } catch {
      return false;
    }
  })();

  if (available) {
    log.info("static: frontend build detected", { path: rootAbs });
  } else {
    log.info("static: no frontend build found — serving JSON stub", {
      path: rootAbs,
    });
  }

  return {
    available,
    async handle(req: Request): Promise<Response | null> {
      if (req.method !== "GET" && req.method !== "HEAD") return null;
      const url = new URL(req.url);
      const path = url.pathname;

      if (!available) {
        if (path === "/") {
          return jsonResponse({ frontend: "not built yet" });
        }
        // Only claim `/` when stub — let the API router 404 the rest.
        return null;
      }

      // Try to resolve to a real file on disk within `rootAbs`.
      const resolvedFile = resolveAssetPath(rootAbs, path);
      if (resolvedFile) {
        return serveFile(resolvedFile);
      }

      // SPA fallback: any GET whose path doesn't carry a known asset
      // extension falls back to index.html so Flutter-web routing works.
      if (!pathLooksLikeAsset(path)) {
        return serveFile(indexPath);
      }

      // Asset-looking path that didn't resolve → 404.
      return err(404, "not found");
    },
  };
}

/**
 * Resolve a URL path to a real file within `rootAbs`, defending against
 * traversal via `..` segments or absolute paths. Returns null if:
 *   - the path escapes `rootAbs`
 *   - the target doesn't exist / isn't a file
 *   - the request is `/` (handled by the SPA fallback branch)
 */
function resolveAssetPath(rootAbs: string, urlPath: string): string | null {
  if (urlPath === "/") return null;
  const decoded = safeDecode(urlPath);
  if (decoded === null) return null;
  // Strip leading slash so `join` treats the rest as relative.
  const rel = decoded.replace(/^\/+/, "");
  if (rel.length === 0) return null;
  if (rel.includes("\0")) return null;
  const joined = normalize(join(rootAbs, rel));
  // Containment check: must start with rootAbs + sep (or equal rootAbs).
  if (joined !== rootAbs && !joined.startsWith(rootAbs + sep)) {
    return null;
  }
  try {
    const st = statSync(joined);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return joined;
}

function pathLooksLikeAsset(urlPath: string): boolean {
  const ext = extname(urlPath).toLowerCase();
  if (!ext) return false;
  return ASSET_EXTENSIONS.has(ext);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * M6 security headers for HTML responses. CSP is permissive enough for a
 * Flutter-web bundle (allows inline styles + wasm eval) but blocks inline
 * script, cross-origin framing, and mixed-content connects. Non-HTML
 * assets get `X-Content-Type-Options: nosniff` only.
 *
 * Note: we intentionally do NOT resolve symlinks via `realpathSync` here —
 * this server is internal-net and the bundle directory is fully operator-
 * controlled. The containment check in `resolveAssetPath` already blocks
 * `..`-style traversal; symlink-based escape would require operator-level
 * write access to the bundle directory.
 */
const HTML_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; base-uri 'self'; frame-ancestors 'none'",
};

async function serveFile(absPath: string): Promise<Response> {
  const ext = extname(absPath).toLowerCase();
  const type = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const file = Bun.file(absPath);
  const headers: Record<string, string> = { "content-type": type };
  if (ext === ".html" || ext === ".htm") {
    Object.assign(headers, HTML_SECURITY_HEADERS);
  } else {
    headers["x-content-type-options"] = "nosniff";
  }
  return new Response(file, {
    status: 200,
    headers,
  });
}

export const __test = {
  resolveAssetPath,
  pathLooksLikeAsset,
  MIME_BY_EXT,
};
