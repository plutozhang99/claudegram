/**
 * Integration tests for P0.2 review fixes that require a real server:
 *   - reconnect rate cap → onFatal
 *   - reconnect attempt counter resets on successful bind
 *   - SIGTERM graceful shutdown of the spawned proxy subprocess
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { connectWs } from "../src/ws-client.ts";

// ---- reconnect rate cap ------------------------------------------------

interface FlappingServer {
  url: string;
  stop(): void;
  connections: number;
}

function startFlappingServer(): FlappingServer {
  let connections = 0;
  const sockets: Set<ServerWebSocket<null>> = new Set();
  const server: Server<null> = Bun.serve<null>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (
        url.pathname === "/channel" &&
        req.headers.get("upgrade") === "websocket"
      ) {
        const ok = srv.upgrade(req, { data: null });
        if (ok) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connections += 1;
        sockets.add(ws);
        // Accept then close immediately — never send a bound ack.
        setTimeout(() => {
          try {
            ws.close(1006, "flap");
          } catch {
            // ignore
          }
        }, 1);
      },
      message() {
        // no-op
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  const port = server.port;
  if (typeof port !== "number") {
    throw new Error("flapping server missing port");
  }
  return {
    url: `http://localhost:${port}`,
    stop: () => server.stop(true),
    get connections() {
      return connections;
    },
  };
}

describe("ws reconnect rate cap", () => {
  test("degenerate flapping server triggers onFatal within a reasonable time", async () => {
    const server = startFlappingServer();
    try {
      // Inject a slow synthetic clock so we can exercise the sliding window
      // deterministically. The per-episode 3-attempt budget still trips
      // first here, but either fatal reason is a valid pass.
      let clock = 0;
      const now = (): number => clock;
      const tick = setInterval(() => {
        clock += 10;
      }, 5);
      (tick as unknown as { unref?: () => void }).unref?.();

      const fatalReason = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for fatal")),
          30_000,
        );
        const c = connectWs({
          harborUrl: server.url,
          parentPid: 1,
          cwd: "/tmp/flap",
          onPush: () => {},
          onBound: () => {},
          onFatal: (reason) => {
            clearTimeout(timer);
            resolve(reason);
          },
          now,
        });
        // Consume the ready-promise rejection so it is not unhandled.
        c.ready().catch(() => {});
      });
      clearInterval(tick);

      expect(fatalReason).toMatch(/reconnect/);
      expect(server.connections).toBeGreaterThanOrEqual(1);
    } finally {
      server.stop();
    }
  });
});

// ---- reconnect counter reset on successful bind ------------------------

describe("ws reconnect counter resets on successful bind", () => {
  test("attempt counter resets so a second reconnect episode does not leak budget", async () => {
    let sessionSocket: ServerWebSocket<null> | null = null;
    let openedCount = 0;
    const server: Server<null> = Bun.serve<null>({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (
          url.pathname === "/channel" &&
          req.headers.get("upgrade") === "websocket"
        ) {
          const ok = srv.upgrade(req, { data: null });
          if (ok) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open(ws) {
          openedCount += 1;
          sessionSocket = ws;
        },
        message(ws) {
          ws.send(
            JSON.stringify({
              type: "bound",
              session_id: "sess-rec",
              channel_token: "tok-abcdef",
            }),
          );
        },
        close() {
          sessionSocket = null;
        },
      },
    });
    const port = server.port;
    if (typeof port !== "number") throw new Error("port missing");
    try {
      let bounds = 0;
      let fatal = false;
      const client = connectWs({
        harborUrl: `http://localhost:${port}`,
        parentPid: 1,
        cwd: "/tmp/rec",
        onPush: () => {},
        onBound: () => {
          bounds += 1;
          // Drop immediately after first bind to force reconnect.
          if (bounds === 1) {
            setTimeout(() => {
              try {
                sessionSocket?.close(1006, "force-rec");
              } catch {
                // ignore
              }
            }, 5);
          }
        },
        onFatal: () => {
          fatal = true;
        },
      });
      for (let i = 0; i < 200; i++) {
        if (bounds >= 2) break;
        await Bun.sleep(10);
      }
      expect(bounds).toBeGreaterThanOrEqual(2);
      expect(fatal).toBe(false);
      expect(openedCount).toBeGreaterThanOrEqual(2);
      client.close();
    } finally {
      server.stop(true);
    }
  });
});

// ---- SIGTERM graceful shutdown -----------------------------------------

describe("SIGTERM graceful shutdown (subprocess)", () => {
  test("spawned proxy exits 0 within 3s on SIGTERM", async () => {
    const sockets: Set<ServerWebSocket<null>> = new Set();
    let shutdownClose = false;
    const server: Server<null> = Bun.serve<null>({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (
          url.pathname === "/channel" &&
          req.headers.get("upgrade") === "websocket"
        ) {
          const ok = srv.upgrade(req, { data: null });
          if (ok) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
        },
        message(ws) {
          ws.send(
            JSON.stringify({
              type: "bound",
              session_id: "sess-term",
              channel_token: "tok-term",
            }),
          );
        },
        close(ws, code) {
          sockets.delete(ws);
          if (code === 1000) shutdownClose = true;
        },
      },
    });
    const port = server.port;
    if (typeof port !== "number") throw new Error("port missing");

    const entry = path.resolve(import.meta.dir, "..", "src", "index.ts");
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [entry],
      {
        env: {
          ...process.env,
          HARBOR_URL: `http://localhost:${port}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    try {
      for (let i = 0; i < 200; i++) {
        if (sockets.size > 0) break;
        await Bun.sleep(10);
      }
      expect(sockets.size).toBeGreaterThanOrEqual(1);

      child.kill("SIGTERM");

      const exit = await Promise.race([
        new Promise<number>((resolve) => {
          child.once("exit", (code) => resolve(code ?? -1));
        }),
        Bun.sleep(3000).then(() => -99),
      ]);
      expect(exit).toBe(0);
      expect(shutdownClose || sockets.size === 0).toBe(true);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      server.stop(true);
    }
  });
});
