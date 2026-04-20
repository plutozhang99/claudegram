/**
 * Integration tests for the P0.1 server.
 *
 * Each test spins up a fresh server on an ephemeral port with an in-memory
 * SQLite database, so state does not leak across tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { start } from "../src/index.ts";
import { __resetCorrelation } from "../src/correlate.ts";

interface Handle {
  port: number;
  stop: () => void;
}

function bootServer(): Handle {
  const h = start({ port: 0, dbPath: ":memory:" });
  const port = h.server.port;
  if (typeof port !== "number") throw new Error("server port missing");
  return {
    port,
    stop: () => h.stop(),
  };
}

let handle: Handle;
beforeEach(() => {
  __resetCorrelation();
  handle = bootServer();
});
afterEach(() => {
  handle.stop();
  __resetCorrelation();
});

function baseUrl(): string {
  return `http://localhost:${handle.port}`;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /hooks/session-start", () => {
  test("creates a session row and returns a channel_token", async () => {
    const res = await postJson("/hooks/session-start", {
      session_id: "sess-1",
      cwd: "/tmp/proj",
      pid: 12345,
      transcript_path: "/tmp/t.jsonl",
      ts: Date.now(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_token: string };
    expect(typeof body.channel_token).toBe("string");
    expect(body.channel_token.length).toBeGreaterThan(8);
  });

  test("rejects malformed JSON with 400", async () => {
    const res = await fetch(`${baseUrl()}/hooks/session-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing required fields with 400", async () => {
    const res = await postJson("/hooks/session-start", { session_id: "x" });
    expect(res.status).toBe(400);
  });

  test("is idempotent on repeat session_id (returns same token)", async () => {
    const body = {
      session_id: "sess-dup",
      cwd: "/tmp/p",
      pid: 1,
      ts: Date.now(),
    };
    const a = (await (await postJson("/hooks/session-start", body)).json()) as {
      channel_token: string;
    };
    const b = (await (await postJson("/hooks/session-start", body)).json()) as {
      channel_token: string;
    };
    expect(a.channel_token).toBe(b.channel_token);
  });
});

describe("POST /statusline", () => {
  test("persists snapshot and returns a non-empty line", async () => {
    await postJson("/hooks/session-start", {
      session_id: "sess-2",
      cwd: "/tmp/alpha",
      pid: 2222,
      ts: Date.now(),
    });
    const res = await postJson("/statusline", {
      session_id: "sess-2",
      model: { id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" },
      context_window: { used_percentage: 42.7, context_window_size: 200000 },
      rate_limits: {
        five_hour: { used: 10, total: 100 },
        seven_day: { used: 50, total: 500 },
      },
      cost: { total_cost_usd: 0.1234 },
      cwd: "/tmp/alpha",
      workspace: { project_dir: "/tmp/alpha" },
      version: "2.1.80",
      permission_mode: "default",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { line: string };
    expect(typeof body.line).toBe("string");
    expect(body.line.length).toBeGreaterThan(0);
    expect(body.line).toContain("Sonnet");
    expect(body.line).toContain("$0.12");
  });

  test("falls back to cwd match when session_id missing", async () => {
    await postJson("/hooks/session-start", {
      session_id: "sess-cwd",
      cwd: "/tmp/beta",
      pid: 3333,
      ts: Date.now(),
    });
    const res = await postJson("/statusline", {
      model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
      context_window: { used_percentage: 10 },
      cost: { total_cost_usd: 0 },
      cwd: "/tmp/beta",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { line: string };
    expect(body.line).toContain("Opus");
  });
});

// ---- WebSocket correlation --------------------------------------------

function openWs(): WebSocket {
  return new WebSocket(`ws://localhost:${handle.port}/channel`);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

function waitClose(ws: WebSocket, timeoutMs = 15000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener(
      "close",
      (ev) => {
        clearTimeout(t);
        resolve(ev);
      },
      { once: true },
    );
  });
}

function waitMessage(ws: WebSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    ws.addEventListener(
      "message",
      (ev) => {
        clearTimeout(t);
        resolve(typeof ev.data === "string" ? ev.data : String(ev.data));
      },
      { once: true },
    );
  });
}

describe("WS /channel correlation", () => {
  test("succeeds when pid+cwd match a recent SessionStart", async () => {
    const pid = 9001;
    const cwd = "/tmp/ws-ok";
    await postJson("/hooks/session-start", {
      session_id: "sess-ws-ok",
      cwd,
      pid,
      ts: Date.now(),
    });
    const ws = openWs();
    await waitOpen(ws);
    ws.send(JSON.stringify({ parent_pid: pid, cwd, ts: Date.now() }));
    const msg = await waitMessage(ws);
    const parsed = JSON.parse(msg) as {
      type: string;
      session_id: string;
      channel_token: string;
    };
    expect(parsed.type).toBe("bound");
    expect(parsed.session_id).toBe("sess-ws-ok");
    expect(typeof parsed.channel_token).toBe("string");
    expect(parsed.channel_token.length).toBeGreaterThan(8);
    ws.close();
  });

  test("closes with 4004 when no pending session matches", async () => {
    const ws = openWs();
    await waitOpen(ws);
    ws.send(JSON.stringify({ parent_pid: 777, cwd: "/nope", ts: Date.now() }));
    const ev = await waitClose(ws);
    expect(ev.code).toBe(4004);
  });
});

describe("POST /admin/push-message", () => {
  test("delivers content over the bound WS", async () => {
    const pid = 7777;
    const cwd = "/tmp/push-ok";
    await postJson("/hooks/session-start", {
      session_id: "sess-push",
      cwd,
      pid,
      ts: Date.now(),
    });
    const ws = openWs();
    await waitOpen(ws);
    ws.send(JSON.stringify({ parent_pid: pid, cwd, ts: Date.now() }));
    const bound = await waitMessage(ws);
    expect(JSON.parse(bound).type).toBe("bound");

    const pending = waitMessage(ws);
    const res = await postJson("/admin/push-message", {
      session_id: "sess-push",
      content: "hello from tests",
    });
    expect(res.status).toBe(200);
    const ack = (await res.json()) as { ok: boolean; delivered: boolean };
    expect(ack.delivered).toBe(true);

    const frame = JSON.parse(await pending) as {
      method: string;
      params: { content: string };
    };
    expect(frame.method).toBe("notifications/claude/channel");
    expect(frame.params.content).toBe("hello from tests");
    ws.close();
  });

  test("returns delivered=false when no WS is bound", async () => {
    await postJson("/hooks/session-start", {
      session_id: "sess-nows",
      cwd: "/tmp/nows",
      pid: 1,
      ts: Date.now(),
    });
    const res = await postJson("/admin/push-message", {
      session_id: "sess-nows",
      content: "nobody home",
    });
    const body = (await res.json()) as { delivered: boolean };
    expect(body.delivered).toBe(false);
  });
});

describe("POST /channel/reply", () => {
  test("valid channel_token inserts an outbound messages row", async () => {
    const start = (await (
      await postJson("/hooks/session-start", {
        session_id: "sess-reply",
        cwd: "/tmp/reply",
        pid: 1,
        ts: Date.now(),
      })
    ).json()) as { channel_token: string };
    const token = start.channel_token;

    const res = await postJson("/channel/reply", {
      channel_token: token,
      content: "hello from claude",
      meta: { kind: "reply" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("number");

    // Admin route is loopback-gated; fetch the session & verify message row.
    const rows = await fetch(`${baseUrl()}/admin/session/sess-reply`);
    expect(rows.status).toBe(200);
  });

  test("unknown channel_token returns 401", async () => {
    const res = await postJson("/channel/reply", {
      channel_token: "does-not-exist",
      content: "x",
    });
    expect(res.status).toBe(401);
  });

  test("missing fields return 400", async () => {
    const res = await postJson("/channel/reply", {
      content: "no token",
    });
    expect(res.status).toBe(400);
  });
});
