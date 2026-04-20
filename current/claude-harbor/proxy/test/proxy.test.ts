/**
 * Integration tests for the stdio MCP channel proxy.
 *
 * Strategy:
 *   - Spin up a real Bun.serve instance that speaks both WS (`/channel`)
 *     and HTTP (`/channel/reply`) so the proxy runs against a realistic
 *     remote surface.
 *   - Drive the proxy's stdio by pushing chunks into an in-memory async
 *     iterable and capturing stdout lines with a callback writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import {
  emitChannelPush,
  handleMessage,
  parseLine,
  runMcpLoop,
  type LineWriter,
} from "../src/mcp.ts";
import { runProxy } from "../src/index.ts";

// ---- async iterable helper ---------------------------------------------

interface PushableStdin {
  push(chunk: string): void;
  end(): void;
  iter: AsyncIterable<string>;
}

function makePushableStdin(): PushableStdin {
  const queue: string[] = [];
  const waiters: Array<(v: IteratorResult<string>) => void> = [];
  let ended = false;

  function push(chunk: string): void {
    if (waiters.length > 0) {
      const w = waiters.shift();
      w?.({ value: chunk, done: false });
    } else {
      queue.push(chunk);
    }
  }
  function end(): void {
    ended = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.({ value: "", done: true });
    }
  }
  const iter: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            const v = queue.shift() as string;
            return Promise.resolve({ value: v, done: false });
          }
          if (ended) return Promise.resolve({ value: "", done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
  return { push, end, iter };
}

// ---- fake harbor server -------------------------------------------------

interface FakeState {
  wsHandshake: {
    parent_pid: number;
    cwd: string;
    ts: number;
  } | null;
  replies: Array<{ channel_token: string; content: string; meta?: Record<string, string> }>;
  sockets: Set<ServerWebSocket<{ sent: boolean }>>;
  channelToken: string;
  sessionId: string;
}

interface FakeHarbor {
  url: string;
  state: FakeState;
  /** Trigger a push frame to the currently bound socket. */
  pushToClient(content: string, meta?: Record<string, string>): void;
  stop(): void;
}

function startFakeHarbor(): FakeHarbor {
  const state: FakeState = {
    wsHandshake: null,
    replies: [],
    sockets: new Set(),
    channelToken: "test-token-abcdef",
    sessionId: "sess-test-1",
  };

  const server: Server<{ sent: boolean }> = Bun.serve<{ sent: boolean }>({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/channel" && req.headers.get("upgrade") === "websocket") {
        const ok = srv.upgrade(req, { data: { sent: false } });
        if (ok) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/channel/reply" && req.method === "POST") {
        const body = (await req.json()) as {
          channel_token?: string;
          content?: string;
          meta?: Record<string, string>;
        };
        if (!body.channel_token || !body.content) {
          return new Response(JSON.stringify({ ok: false }), { status: 400 });
        }
        if (body.channel_token !== state.channelToken) {
          return new Response(JSON.stringify({ ok: false }), { status: 401 });
        }
        state.replies.push({
          channel_token: body.channel_token,
          content: body.content,
          meta: body.meta,
        });
        return new Response(JSON.stringify({ ok: true, id: state.replies.length }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        state.sockets.add(ws);
      },
      message(ws, raw) {
        if (!state.wsHandshake) {
          try {
            const obj = JSON.parse(String(raw)) as Record<string, unknown>;
            state.wsHandshake = {
              parent_pid: Number(obj.parent_pid),
              cwd: String(obj.cwd),
              ts: Number(obj.ts),
            };
            ws.send(
              JSON.stringify({
                type: "bound",
                session_id: state.sessionId,
                channel_token: state.channelToken,
              }),
            );
          } catch {
            ws.close(4000, "bad handshake");
          }
          return;
        }
      },
      close(ws) {
        state.sockets.delete(ws);
      },
    },
  });

  const port = server.port;
  if (typeof port !== "number") throw new Error("fake harbor port missing");
  return {
    url: `http://localhost:${port}`,
    state,
    pushToClient(content, meta) {
      for (const ws of state.sockets) {
        try {
          ws.send(JSON.stringify({ type: "push", content, meta }));
        } catch {
          // ignore
        }
      }
    },
    stop(): void {
      server.stop(true);
    },
  };
}

// ---- tests --------------------------------------------------------------

describe("mcp dispatcher (unit)", () => {
  test("initialize response advertises claude/channel capability", async () => {
    const lines: string[] = [];
    const writer: LineWriter = (l) => lines.push(l);
    await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        writer,
        sendReply: async () => ({ ok: true }),
      },
    );
    expect(lines).toHaveLength(1);
    const resp = JSON.parse(lines[0] as string) as {
      id: number;
      result: {
        capabilities: {
          experimental: Record<string, unknown>;
          tools: Record<string, unknown>;
        };
        serverInfo: { name: string };
      };
    };
    expect(resp.id).toBe(1);
    expect(resp.result.capabilities.experimental["claude/channel"]).toBeDefined();
    expect(resp.result.capabilities.tools).toBeDefined();
    expect(resp.result.serverInfo.name).toBe("claude-harbor");
  });

  test("tools/list returns a single reply tool", async () => {
    const lines: string[] = [];
    await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        writer: (l) => lines.push(l),
        sendReply: async () => ({ ok: true }),
      },
    );
    const resp = JSON.parse(lines[0] as string) as {
      result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> };
    };
    expect(resp.result.tools).toHaveLength(1);
    expect(resp.result.tools[0]?.name).toBe("reply");
    expect(resp.result.tools[0]?.inputSchema.required).toContain("chat_id");
    expect(resp.result.tools[0]?.inputSchema.required).toContain("text");
  });

  test("tools/call reply invokes sendReply and returns a text result", async () => {
    const lines: string[] = [];
    const captured: {
      content: string | null;
      meta: Record<string, string> | undefined;
    } = { content: null, meta: undefined };
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "reply",
          arguments: { chat_id: "5", text: "hi there" },
        },
      },
      {
        writer: (l) => lines.push(l),
        sendReply: async (content, meta) => {
          captured.content = content;
          captured.meta = meta;
          return { ok: true };
        },
      },
    );
    expect(captured.content).toBe("hi there");
    expect(captured.meta?.chat_id).toBe("5");
    const resp = JSON.parse(lines[0] as string) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(resp.result.isError).not.toBe(true);
    expect(resp.result.content[0]?.text).toContain("sent");
  });

  test("unknown method returns JSON-RPC method-not-found", async () => {
    const lines: string[] = [];
    await handleMessage(
      { jsonrpc: "2.0", id: 99, method: "does/not/exist" },
      {
        writer: (l) => lines.push(l),
        sendReply: async () => ({ ok: true }),
      },
    );
    const resp = JSON.parse(lines[0] as string) as { error: { code: number } };
    expect(resp.error.code).toBe(-32601);
  });

  test("malformed message does not crash and writes parse error response", async () => {
    const lines: string[] = [];
    const stdin = makePushableStdin();
    stdin.push("{not json}\n");
    stdin.push(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n");
    stdin.end();
    await runMcpLoop(stdin.iter, {
      writer: (l) => lines.push(l),
      sendReply: async () => ({ ok: true }),
    });
    // first line: parse error, second: ping result.
    expect(lines).toHaveLength(2);
    const parseErr = JSON.parse(lines[0] as string) as { error: { code: number } };
    expect(parseErr.error.code).toBe(-32700);
  });

  test("parseLine ignores blank lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("{\"a\":1}")).toEqual({ a: 1 });
  });

  test("emitChannelPush writes the correct notification shape", () => {
    const lines: string[] = [];
    emitChannelPush((l) => lines.push(l), "hello", { chat_id: "1" });
    const msg = JSON.parse(lines[0] as string) as {
      method: string;
      params: { content: string; meta: Record<string, string> };
    };
    expect(msg.method).toBe("notifications/claude/channel");
    expect(msg.params.content).toBe("hello");
    expect(msg.params.meta.chat_id).toBe("1");
  });
});

// ---- end-to-end with fake harbor ---------------------------------------

describe("proxy end-to-end (with fake harbor)", () => {
  let harbor: FakeHarbor;

  beforeEach(() => {
    harbor = startFakeHarbor();
  });
  afterEach(() => {
    harbor.stop();
  });

  test("handshake: sends {parent_pid, cwd, ts} as first WS frame", async () => {
    const stdin = makePushableStdin();
    const lines: string[] = [];
    const writer: LineWriter = (l) => lines.push(l);

    const done = runProxy({
      harborUrl: harbor.url,
      parentPid: 9999,
      cwd: "/tmp/proxy-hs",
      stdin: stdin.iter,
      writer,
    });

    // Wait until fake harbor records the handshake.
    for (let i = 0; i < 100; i++) {
      if (harbor.state.wsHandshake) break;
      await Bun.sleep(10);
    }
    expect(harbor.state.wsHandshake).not.toBeNull();
    expect(harbor.state.wsHandshake?.parent_pid).toBe(9999);
    expect(harbor.state.wsHandshake?.cwd).toBe("/tmp/proxy-hs");
    expect(typeof harbor.state.wsHandshake?.ts).toBe("number");

    // Graceful shutdown: close stdin.
    stdin.end();
    await done;
  });

  test("inbound push is forwarded to stdout as notifications/claude/channel", async () => {
    const stdin = makePushableStdin();
    const lines: string[] = [];
    const writer: LineWriter = (l) => lines.push(l);

    const done = runProxy({
      harborUrl: harbor.url,
      parentPid: 12345,
      cwd: "/tmp/proxy-in",
      stdin: stdin.iter,
      writer,
    });

    // Wait for bound.
    for (let i = 0; i < 100; i++) {
      if (harbor.state.sockets.size > 0 && harbor.state.wsHandshake) break;
      await Bun.sleep(10);
    }
    // Give server time to send the bound ack and client to process it.
    await Bun.sleep(30);

    harbor.pushToClient("what's up?", { chat_id: "42", user: "alice" });

    // Poll stdout for the notification.
    let found: string | null = null;
    for (let i = 0; i < 100; i++) {
      const match = lines.find((l) => l.includes("notifications/claude/channel"));
      if (match) {
        found = match;
        break;
      }
      await Bun.sleep(10);
    }
    expect(found).not.toBeNull();
    const msg = JSON.parse(found as string) as {
      method: string;
      params: { content: string; meta: Record<string, string> };
    };
    expect(msg.method).toBe("notifications/claude/channel");
    expect(msg.params.content).toBe("what's up?");
    expect(msg.params.meta.chat_id).toBe("42");
    expect(msg.params.meta.user).toBe("alice");

    stdin.end();
    await done;
  });

  test("tools/call reply posts to /channel/reply with learned channel_token", async () => {
    const stdin = makePushableStdin();
    const lines: string[] = [];
    const writer: LineWriter = (l) => lines.push(l);

    const done = runProxy({
      harborUrl: harbor.url,
      parentPid: 2020,
      cwd: "/tmp/proxy-out",
      stdin: stdin.iter,
      writer,
    });

    // Wait until bound.
    for (let i = 0; i < 100; i++) {
      if (harbor.state.wsHandshake) break;
      await Bun.sleep(10);
    }
    await Bun.sleep(30);

    // Simulate CC's tools/call on stdin.
    stdin.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "reply",
          arguments: { chat_id: "5", text: "hello from claude" },
        },
      }) + "\n",
    );

    // Wait for reply delivery.
    for (let i = 0; i < 100; i++) {
      if (harbor.state.replies.length > 0) break;
      await Bun.sleep(10);
    }
    expect(harbor.state.replies).toHaveLength(1);
    const r = harbor.state.replies[0];
    expect(r?.channel_token).toBe(harbor.state.channelToken);
    expect(r?.content).toBe("hello from claude");
    expect(r?.meta?.chat_id).toBe("5");

    // A tools/call response should appear on stdout.
    const responseLine = lines.find((l) => l.includes("\"id\":100"));
    expect(responseLine).toBeDefined();

    stdin.end();
    await done;
  });

  test("graceful shutdown on stdin EOF", async () => {
    const stdin = makePushableStdin();
    const writer: LineWriter = () => {};
    const done = runProxy({
      harborUrl: harbor.url,
      parentPid: 7,
      cwd: "/tmp/proxy-eof",
      stdin: stdin.iter,
      writer,
    });
    // Immediately end stdin.
    stdin.end();
    // runProxy should resolve without hanging.
    const outcome = await Promise.race([
      done.then(() => "done" as const),
      Bun.sleep(5000).then(() => "timeout" as const),
    ]);
    expect(outcome).toBe("done");
  });
});
