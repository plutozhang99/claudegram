/**
 * P2.0 WS /subscribe + event bus fan-out tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { start, type HarborHandle } from "../src/index.ts";
import { __resetCorrelation } from "../src/correlate.ts";
import { __resetBus, getBus } from "../src/event-bus.ts";

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

let handle: Handle;
beforeEach(() => {
  __resetCorrelation();
  __resetBus();
  delete process.env.HARBOR_ADMIN_TOKEN;
  handle = bootServer();
});
afterEach(() => {
  handle.stop();
  __resetCorrelation();
  __resetBus();
  delete process.env.HARBOR_ADMIN_TOKEN;
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

function openSubWs(): WebSocket {
  return new WebSocket(`ws://localhost:${handle.port}/subscribe`);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    // Fast-path: if the socket has already completed its upgrade by the
    // time this is awaited (common when opening multiple WSs back-to-back
    // — Bun may dispatch the `open` event before a later `await` reaches
    // this helper), resolve immediately instead of registering a listener
    // that would never fire.
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

/**
 * Record all messages arriving on a ws from the moment this is called.
 * Returns a handle with `.drain(n)` that awaits until `n` messages have
 * been received. Attaching synchronously avoids a race where the
 * `subscribed` ack arrives before a test attaches its listener.
 */
function recorder(ws: WebSocket) {
  const buf: string[] = [];
  let resolveNext: (() => void) | null = null;
  const onMsg = (ev: MessageEvent) => {
    buf.push(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };
  ws.addEventListener("message", onMsg);
  return {
    async drain(n: number, timeoutMs = 3000): Promise<string[]> {
      const deadline = Date.now() + timeoutMs;
      while (buf.length < n) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`drain: expected ${n}, got ${buf.length}`);
        }
        await new Promise<void>((res, rej) => {
          resolveNext = res;
          setTimeout(() => rej(new Error("drain timeout")), remaining).unref?.();
        }).catch(() => {});
      }
      return buf.splice(0, n);
    },
    stop() {
      ws.removeEventListener("message", onMsg);
    },
  };
}

describe("WS /subscribe", () => {
  test("on connect, sends {type: subscribed}", async () => {
    const ws = openSubWs();
    const rec = recorder(ws);
    await waitOpen(ws);
    const [first] = await rec.drain(1);
    const parsed = JSON.parse(first!) as { type: string };
    expect(parsed.type).toBe("subscribed");
    rec.stop();
    ws.close();
  });

  test("creating a session fans out session.created to all subscribers", async () => {
    const ws1 = openSubWs();
    const ws2 = openSubWs();
    const r1 = recorder(ws1);
    const r2 = recorder(ws2);
    await waitOpen(ws1);
    await waitOpen(ws2);
    // Drain `subscribed` on each.
    await r1.drain(1);
    await r2.drain(1);

    const p1 = r1.drain(1);
    const p2 = r2.drain(1);
    await postJson("/hooks/session-start", {
      session_id: "sub-A",
      cwd: "/tmp/subA",
      pid: 9101,
      ts: Date.now(),
    });
    const [m1raw] = await p1;
    const [m2raw] = await p2;
    const m1 = JSON.parse(m1raw!) as {
      type: string;
      session: Record<string, unknown>;
    };
    const m2 = JSON.parse(m2raw!) as {
      type: string;
      session: Record<string, unknown>;
    };
    expect(m1.type).toBe("session.created");
    expect(m2.type).toBe("session.created");
    // C1: channel_token MUST NOT be included in the broadcast frame.
    expect("channel_token" in m1.session).toBe(false);
    expect("channel_token" in m2.session).toBe(false);
    r1.stop();
    r2.stop();
    ws1.close();
    ws2.close();
  });

  test("/channel/reply fans out message.created", async () => {
    const startRes = (await (
      await postJson("/hooks/session-start", {
        session_id: "sub-reply",
        cwd: "/tmp/sub-reply",
        pid: 9102,
        ts: Date.now(),
      })
    ).json()) as { channel_token: string };

    const ws = openSubWs();
    const rec = recorder(ws);
    await waitOpen(ws);
    await rec.drain(2); // subscribed + replayed session.created

    const pending = rec.drain(1);
    const res = await postJson("/channel/reply", {
      channel_token: startRes.channel_token,
      content: "from Claude",
    });
    expect(res.status).toBe(200);
    const [m] = (await pending).map(
      (s) => JSON.parse(s) as { type: string; message?: { content: string } },
    );
    expect(m!.type).toBe("message.created");
    expect(m!.message?.content).toBe("from Claude");
    rec.stop();
    ws.close();
  });

  test("/statusline fans out statusline.updated", async () => {
    await postJson("/hooks/session-start", {
      session_id: "sub-sl",
      cwd: "/tmp/sub-sl",
      pid: 9103,
      ts: Date.now(),
    });
    const ws = openSubWs();
    const rec = recorder(ws);
    await waitOpen(ws);
    // Drain subscribed + session.created (from earlier post).
    await rec.drain(2);

    const pending = rec.drain(2);
    await postJson("/statusline", {
      session_id: "sub-sl",
      model: { id: "m", display_name: "M" },
      context_window: { used_percentage: 50 },
      cost: { total_cost_usd: 1.0 },
      cwd: "/tmp/sub-sl",
    });
    const frames = (await pending).map(
      (s) => JSON.parse(s) as { type: string; session?: Record<string, unknown> },
    );
    const types = frames.map((f) => f.type);
    expect(types).toContain("statusline.updated");
    expect(types).toContain("session.updated");
    // C1: the session.updated payload must NOT include channel_token.
    const updated = frames.find((f) => f.type === "session.updated");
    expect(updated).toBeTruthy();
    expect("channel_token" in (updated!.session ?? {})).toBe(false);
    rec.stop();
    ws.close();
  });

  test("/hooks/session-end fans out session.ended", async () => {
    await postJson("/hooks/session-start", {
      session_id: "sub-end",
      cwd: "/tmp/sub-end",
      pid: 9104,
      ts: Date.now(),
    });
    const ws = openSubWs();
    const rec = recorder(ws);
    await waitOpen(ws);
    await rec.drain(2); // subscribed + earlier session.created

    const pending = rec.drain(1);
    await postJson("/hooks/session-end", { session_id: "sub-end" });
    const [m] = (await pending).map(
      (s) => JSON.parse(s) as { type: string; session_id: string },
    );
    expect(m!.type).toBe("session.ended");
    expect(m!.session_id).toBe("sub-end");
    rec.stop();
    ws.close();
  });

  test("subscriber error does not kill the bus", () => {
    const bus = getBus();
    const throwing = () => {
      throw new Error("boom");
    };
    const ok1Events: string[] = [];
    const ok2Events: string[] = [];
    bus.subscribeAll(() => ok1Events.push("a"));
    bus.subscribeAll(throwing);
    bus.subscribeAll(() => ok2Events.push("b"));
    bus.emit({ type: "session.ended", session_id: "x" });
    bus.emit({ type: "session.ended", session_id: "y" });
    expect(ok1Events).toEqual(["a", "a"]);
    expect(ok2Events).toEqual(["b", "b"]);
  });
});

describe("WS /subscribe: C1 replay safety", () => {
  test("replay of session.created never exposes channel_token", async () => {
    // Stage a session before the WS opens so it arrives via the replay
    // path (not the live fan-out path).
    await postJson("/hooks/session-start", {
      session_id: "replay-leak-guard",
      cwd: "/tmp/replay-leak",
      pid: 9201,
      ts: Date.now(),
    });
    const ws = openSubWs();
    const rec = recorder(ws);
    await waitOpen(ws);
    const [subscribedRaw, replayRaw] = await rec.drain(2);
    const subscribed = JSON.parse(subscribedRaw!) as { type: string };
    expect(subscribed.type).toBe("subscribed");
    const replay = JSON.parse(replayRaw!) as {
      type: string;
      session: Record<string, unknown>;
    };
    expect(replay.type).toBe("session.created");
    expect("channel_token" in replay.session).toBe(false);
    rec.stop();
    ws.close();
  });
});

describe("H2: subscriber cap", () => {
  test("33rd subscriber is closed with 1013 once the cap is full", async () => {
    // Cap is 32. Open 32, wait for them all to ack 'subscribed', then open
    // the 33rd and expect a close event with code 1013.
    const sockets: WebSocket[] = [];
    const recs: Array<ReturnType<typeof recorder>> = [];
    try {
      for (let i = 0; i < 32; i++) {
        const ws = openSubWs();
        sockets.push(ws);
        const rec = recorder(ws);
        recs.push(rec);
        await waitOpen(ws);
        await rec.drain(1); // subscribed
      }
      const extra = new WebSocket(
        `ws://localhost:${handle.port}/subscribe`,
      );
      const closeEv = await new Promise<CloseEvent | Event>((resolve) => {
        extra.addEventListener(
          "close",
          (e) => resolve(e as CloseEvent),
          { once: true },
        );
        extra.addEventListener("error", (e) => resolve(e), { once: true });
        setTimeout(() => resolve({} as Event), 3000).unref?.();
      });
      // If the close arrives as a CloseEvent, code is 1013; error path is
      // accepted too since Bun's ws client surfaces some rejections that
      // way.
      const code = (closeEv as CloseEvent).code;
      if (typeof code === "number") {
        expect(code).toBe(1013);
      } else {
        // At minimum the socket must not have stayed open.
        expect(extra.readyState).not.toBe(WebSocket.OPEN);
      }
      try {
        extra.close();
      } catch {
        // ignore
      }
    } finally {
      for (const r of recs) r.stop();
      for (const w of sockets) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
    }
  });
});

describe("WS /subscribe auth", () => {
  test("with HARBOR_ADMIN_TOKEN set, un-authed upgrade is rejected", async () => {
    handle.stop();
    process.env.HARBOR_ADMIN_TOKEN = "secret-token-xyz";
    handle = bootServer();

    const ws = new WebSocket(`ws://localhost:${handle.port}/subscribe`);
    const close = await new Promise<CloseEvent | Event>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e), { once: true });
      ws.addEventListener("error", (e) => resolve(e), { once: true });
    });
    // Either a close event with a non-1000 code or an error event counts
    // as rejection — Bun/Safari's ws client handles HTTP-error upgrades
    // slightly differently by runtime version.
    expect(close).toBeTruthy();
    try {
      ws.close();
    } catch {
      // ignore
    }
  });

  test("with token set, loopback unauth fetch of plain GET returns not-upgraded response", async () => {
    handle.stop();
    process.env.HARBOR_ADMIN_TOKEN = "secret-token-xyz";
    handle = bootServer();
    // GET /subscribe without upgrade header bypasses the subscribe path
    // entirely — should fall through to API routing (404).
    const res = await fetch(`${baseUrl()}/subscribe`);
    expect(res.status).toBe(404);
  });
});
