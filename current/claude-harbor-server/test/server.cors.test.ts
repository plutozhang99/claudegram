/**
 * P2.0 CORS behavior tests.
 *
 * Default: NO CORS headers on any response.
 * With `HARBOR_DEV=1` + loopback bind: CORS on GET only, OPTIONS preflight
 * returns 204, POST still has no CORS headers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { start, type HarborHandle } from "../src/index.ts";
import { __resetCorrelation } from "../src/correlate.ts";
import { __resetBus } from "../src/event-bus.ts";

interface Handle {
  port: number;
  harbor: HarborHandle;
  stop(): void;
}

function bootServer(): Handle {
  const h = start({ port: 0, dbPath: ":memory:" });
  const port = h.server.port;
  if (typeof port !== "number") throw new Error("server port missing");
  return { port, harbor: h, stop: () => h.stop() };
}

let handle: Handle | null = null;
beforeEach(() => {
  __resetCorrelation();
  __resetBus();
  delete process.env.HARBOR_DEV;
});
afterEach(() => {
  if (handle) handle.stop();
  handle = null;
  __resetCorrelation();
  __resetBus();
  delete process.env.HARBOR_DEV;
});

function baseUrl(): string {
  if (!handle) throw new Error("no handle");
  return `http://localhost:${handle.port}`;
}

describe("CORS default (off)", () => {
  test("GET /sessions has no ACAO", async () => {
    handle = bootServer();
    const res = await fetch(`${baseUrl()}/sessions`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("OPTIONS /sessions returns 405 (no preflight support off)", async () => {
    handle = bootServer();
    const res = await fetch(`${baseUrl()}/sessions`, { method: "OPTIONS" });
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("POST /hooks/session-start has no ACAO", async () => {
    handle = bootServer();
    const res = await fetch(`${baseUrl()}/hooks/session-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "c-1",
        cwd: "/tmp/c",
        pid: 1,
        ts: Date.now(),
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS dev-mode + loopback", () => {
  test("GET /sessions echoes localhost dev origin", async () => {
    process.env.HARBOR_DEV = "1";
    delete process.env.HARBOR_DEV_ORIGIN_PORT;
    handle = bootServer();
    const res = await fetch(`${baseUrl()}/sessions`);
    expect(res.status).toBe(200);
    // Default (env unset) → fall back to 8080.
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:8080",
    );
    const allowHeaders =
      res.headers.get("access-control-allow-headers") ?? "";
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders.toLowerCase()).not.toContain(
      "x-harbor-admin-token",
    );
  });

  test("HARBOR_DEV_ORIGIN_PORT overrides the echoed origin", async () => {
    process.env.HARBOR_DEV = "1";
    process.env.HARBOR_DEV_ORIGIN_PORT = "63595";
    handle = bootServer();
    const res = await fetch(`${baseUrl()}/sessions`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:63595",
    );
    delete process.env.HARBOR_DEV_ORIGIN_PORT;
  });

  test("OPTIONS /sessions returns 204 with restrictive headers", async () => {
    process.env.HARBOR_DEV = "1";
    delete process.env.HARBOR_DEV_ORIGIN_PORT;
    handle = bootServer();
    const res = await fetch(`${baseUrl()}/sessions`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:8080",
    );
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    expect(methods).toContain("GET");
    // Explicitly does NOT advertise POST — writes stay same-origin.
    expect(methods).not.toContain("POST");
    const allowHeaders =
      res.headers.get("access-control-allow-headers") ?? "";
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders.toLowerCase()).not.toContain(
      "x-harbor-admin-token",
    );
  });

  test("POST /hooks/session-start still has no ACAO in dev mode", async () => {
    process.env.HARBOR_DEV = "1";
    handle = bootServer();
    const res = await fetch(`${baseUrl()}/hooks/session-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "c-2",
        cwd: "/tmp/c2",
        pid: 2,
        ts: Date.now(),
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
