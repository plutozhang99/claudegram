/**
 * P2.0 static-serving tests.
 *
 * When the Flutter build is missing, GET `/` returns a JSON stub.
 * When a fake `build/web/index.html` fixture is staged, GET `/` and GET of
 * any unknown non-asset path return that file; assets are served with
 * correct MIME.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, type HarborHandle } from "../src/index.ts";
import { __resetCorrelation } from "../src/correlate.ts";
import { __resetBus } from "../src/event-bus.ts";

interface Handle {
  port: number;
  harbor: HarborHandle;
  stop(): void;
}

function bootServer(buildDir?: string): Handle {
  const h = start({
    port: 0,
    dbPath: ":memory:",
    frontendBuildDir: buildDir,
  });
  const port = h.server.port;
  if (typeof port !== "number") throw new Error("server port missing");
  return { port, harbor: h, stop: () => h.stop() };
}

let handle: Handle;
let scratch: string;

beforeEach(() => {
  __resetCorrelation();
  __resetBus();
  scratch = mkdtempSync(join(tmpdir(), "harbor-static-"));
});
afterEach(() => {
  if (handle) handle.stop();
  __resetCorrelation();
  __resetBus();
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function baseUrl(): string {
  return `http://localhost:${handle.port}`;
}

describe("static serving", () => {
  test("GET / returns JSON stub when no build present", async () => {
    // Point at a non-existent subdir.
    handle = bootServer(join(scratch, "does-not-exist"));
    const res = await fetch(`${baseUrl()}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frontend: string };
    expect(body.frontend).toBe("not built yet");
  });

  test("stub mode: unknown path returns 404 (API routing, not SPA)", async () => {
    handle = bootServer(join(scratch, "does-not-exist"));
    const res = await fetch(`${baseUrl()}/some/unknown/path`);
    expect(res.status).toBe(404);
  });

  test("bundle present: GET / serves index.html", async () => {
    // Stage a fake build dir.
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(scratch, "index.html"),
      "<!doctype html><title>stub</title>",
    );
    handle = bootServer(scratch);

    const res = await fetch(`${baseUrl()}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<title>stub</title>");
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("bundle present: SPA fallback returns index.html for unknown non-asset path", async () => {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(scratch, "index.html"),
      "<!doctype html><title>spa</title>",
    );
    handle = bootServer(scratch);

    const res = await fetch(`${baseUrl()}/session/123`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<title>spa</title>");
  });

  test("bundle present: asset served with correct MIME", async () => {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "index.html"), "<!doctype html>");
    writeFileSync(join(scratch, "main.js"), "console.log('x');");
    writeFileSync(join(scratch, "styles.css"), "body{}");
    writeFileSync(join(scratch, "app.wasm"), new Uint8Array([0, 1, 2, 3]));
    writeFileSync(join(scratch, "icon.svg"), "<svg/>");
    writeFileSync(join(scratch, "favicon.ico"), new Uint8Array([0]));

    handle = bootServer(scratch);

    const js = await fetch(`${baseUrl()}/main.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type") ?? "").toContain(
      "application/javascript",
    );

    const css = await fetch(`${baseUrl()}/styles.css`);
    expect(css.headers.get("content-type") ?? "").toContain("text/css");

    const wasm = await fetch(`${baseUrl()}/app.wasm`);
    expect(wasm.headers.get("content-type") ?? "").toBe("application/wasm");

    const svg = await fetch(`${baseUrl()}/icon.svg`);
    expect(svg.headers.get("content-type") ?? "").toBe("image/svg+xml");

    const ico = await fetch(`${baseUrl()}/favicon.ico`);
    expect(ico.headers.get("content-type") ?? "").toBe("image/x-icon");
  });

  test("bundle present: missing asset returns 404 (no SPA fallback for asset-looking paths)", async () => {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "index.html"), "<!doctype html>");
    handle = bootServer(scratch);

    const res = await fetch(`${baseUrl()}/missing.js`);
    expect(res.status).toBe(404);
  });

  test("bundle present: GET /health still wins over static", async () => {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "index.html"), "<!doctype html>");
    handle = bootServer(scratch);
    const res = await fetch(`${baseUrl()}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("bundle present: path traversal is blocked", async () => {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "index.html"), "<!doctype html>");
    handle = bootServer(scratch);
    // Try to escape via a URL-encoded traversal.
    const res = await fetch(`${baseUrl()}/..%2f..%2fetc%2fpasswd`);
    // Either served as SPA index (fallback) or 404; MUST NOT be the host
    // file contents. Response must be 200 HTML (index) OR 404.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const text = await res.text();
      expect(text).not.toContain("root:");
    }
  });
});
