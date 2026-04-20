/**
 * P2.0 REST endpoint tests:
 *   - GET /sessions (filter, limit, offset, ordering)
 *   - GET /sessions/:session_id (404, counts)
 *   - GET /sessions/:session_id/messages (cursor pagination)
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

let handle: Handle;
beforeEach(() => {
  __resetCorrelation();
  __resetBus();
  handle = bootServer();
});
afterEach(() => {
  handle.stop();
  __resetCorrelation();
  __resetBus();
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

async function createSession(id: string, cwd: string, pid: number) {
  const res = await postJson("/hooks/session-start", {
    session_id: id,
    cwd,
    pid,
    ts: Date.now(),
  });
  return (await res.json()) as { channel_token: string };
}

describe("GET /sessions", () => {
  test("returns empty list when no sessions", async () => {
    const res = await fetch(`${baseUrl()}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; total: number };
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
  });

  test("lists created sessions, total matches filter", async () => {
    await createSession("s-a", "/tmp/a", 101);
    await createSession("s-b", "/tmp/b", 102);
    await createSession("s-c", "/tmp/c", 103);
    const res = await fetch(`${baseUrl()}/sessions`);
    const body = (await res.json()) as {
      sessions: { session_id: string }[];
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.sessions).toHaveLength(3);
    const ids = body.sessions.map((s) => s.session_id).sort();
    expect(ids).toEqual(["s-a", "s-b", "s-c"]);
  });

  test("filters by status", async () => {
    await createSession("s1", "/tmp/s1", 201);
    await createSession("s2", "/tmp/s2", 202);
    // End s2.
    await postJson("/hooks/session-end", { session_id: "s2" });

    const active = (await (
      await fetch(`${baseUrl()}/sessions?status=active`)
    ).json()) as { sessions: { session_id: string }[]; total: number };
    expect(active.total).toBe(1);
    expect(active.sessions[0]?.session_id).toBe("s1");

    const ended = (await (
      await fetch(`${baseUrl()}/sessions?status=ended`)
    ).json()) as { sessions: { session_id: string }[]; total: number };
    expect(ended.total).toBe(1);
    expect(ended.sessions[0]?.session_id).toBe("s2");
  });

  test("rejects unknown status with 400", async () => {
    const res = await fetch(`${baseUrl()}/sessions?status=bogus`);
    expect(res.status).toBe(400);
  });

  test("clamps limit to MAX, rejects non-integer", async () => {
    // Plenty of sessions.
    for (let i = 0; i < 5; i++) {
      await createSession(`s-${i}`, `/tmp/sx-${i}`, 300 + i);
    }
    // Over-cap limit → clamps, still returns 200 with up to 200 rows.
    const over = await fetch(`${baseUrl()}/sessions?limit=99999`);
    expect(over.status).toBe(200);

    // Non-integer limit → 400.
    const bad = await fetch(`${baseUrl()}/sessions?limit=abc`);
    expect(bad.status).toBe(400);

    // Zero limit → 400 (below min=1).
    const zero = await fetch(`${baseUrl()}/sessions?limit=0`);
    expect(zero.status).toBe(400);
  });

  test("paginates via offset", async () => {
    for (let i = 0; i < 5; i++) {
      await createSession(`p-${i}`, `/tmp/p-${i}`, 400 + i);
    }
    const page1 = (await (
      await fetch(`${baseUrl()}/sessions?limit=2&offset=0`)
    ).json()) as { sessions: unknown[]; total: number };
    const page2 = (await (
      await fetch(`${baseUrl()}/sessions?limit=2&offset=2`)
    ).json()) as { sessions: unknown[]; total: number };
    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page1.sessions).toHaveLength(2);
    expect(page2.sessions).toHaveLength(2);
  });

  test("rejects non-integer offset", async () => {
    const res = await fetch(`${baseUrl()}/sessions?offset=foo`);
    expect(res.status).toBe(400);
  });
});

describe("GET /sessions/:session_id", () => {
  test("returns row + counts", async () => {
    await createSession("sess-detail", "/tmp/detail", 501);
    // One inbound.
    await postJson("/hooks/user-prompt-submit", {
      session_id: "sess-detail",
      prompt: "hello",
    });
    // One pre-tool event.
    await postJson("/hooks/pre-tool-use", {
      session_id: "sess-detail",
      tool_name: "Bash",
      tool_input: { cmd: "ls" },
    });

    const res = await fetch(`${baseUrl()}/sessions/sess-detail`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: Record<string, unknown>;
      counts: { messages: number; tool_events: number };
    };
    expect(body.session.session_id).toBe("sess-detail");
    // C1: channel_token MUST NOT be exposed on this unauthenticated route.
    expect("channel_token" in body.session).toBe(false);
    expect(body.counts.messages).toBe(1);
    expect(body.counts.tool_events).toBe(1);
  });

  test("404 when unknown", async () => {
    const res = await fetch(`${baseUrl()}/sessions/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("rejects invalid session_id format with 400", async () => {
    const res = await fetch(`${baseUrl()}/sessions/has%20space`);
    expect(res.status).toBe(400);
  });
});

describe("GET /sessions/:session_id/messages", () => {
  test("paginates desc by id with next_before cursor", async () => {
    await createSession("sess-m", "/tmp/m", 601);
    for (let i = 0; i < 5; i++) {
      await postJson("/hooks/user-prompt-submit", {
        session_id: "sess-m",
        prompt: `p${i}`,
      });
    }
    const page1 = (await (
      await fetch(`${baseUrl()}/sessions/sess-m/messages?limit=2`)
    ).json()) as {
      messages: { id: number; content: string }[];
      next_before: number | null;
    };
    expect(page1.messages).toHaveLength(2);
    // Newest first.
    expect(page1.messages[0]!.content).toBe("p4");
    expect(page1.messages[1]!.content).toBe("p3");
    expect(page1.next_before).toBe(page1.messages[1]!.id);

    const page2 = (await (
      await fetch(
        `${baseUrl()}/sessions/sess-m/messages?limit=2&before=${page1.next_before}`,
      )
    ).json()) as {
      messages: { content: string }[];
      next_before: number | null;
    };
    expect(page2.messages.map((m) => m.content)).toEqual(["p2", "p1"]);
    expect(page2.next_before).not.toBeNull();

    const page3 = (await (
      await fetch(
        `${baseUrl()}/sessions/sess-m/messages?limit=2&before=${page2.next_before}`,
      )
    ).json()) as {
      messages: { content: string }[];
      next_before: number | null;
    };
    // Last page is partial → next_before null.
    expect(page3.messages.map((m) => m.content)).toEqual(["p0"]);
    expect(page3.next_before).toBeNull();
  });

  test("404 for unknown session", async () => {
    const res = await fetch(`${baseUrl()}/sessions/nope/messages`);
    expect(res.status).toBe(404);
  });

  test("rejects invalid before", async () => {
    await createSession("sess-bad", "/tmp/bad", 701);
    const res = await fetch(
      `${baseUrl()}/sessions/sess-bad/messages?before=xyz`,
    );
    expect(res.status).toBe(400);
  });

  test("clamps limit above max", async () => {
    await createSession("sess-cap", "/tmp/cap", 702);
    const res = await fetch(
      `${baseUrl()}/sessions/sess-cap/messages?limit=99999`,
    );
    expect(res.status).toBe(200);
  });
});

// ----------------------------------------------------------------
// C1: channel_token MUST NOT be leaked via any unauthenticated REST
// route, nor via the frontend WS fan-out. The per-route checks below
// parse responses explicitly and assert the column is absent.
// ----------------------------------------------------------------

describe("C1: channel_token not leaked on REST", () => {
  test("GET /sessions never exposes channel_token on any row", async () => {
    await createSession("leak-a", "/tmp/la", 801);
    await createSession("leak-b", "/tmp/lb", 802);
    const res = await fetch(`${baseUrl()}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    expect(body.sessions.length).toBeGreaterThan(0);
    for (const s of body.sessions) {
      expect("channel_token" in s).toBe(false);
    }
  });

  test("GET /sessions/:id never exposes channel_token", async () => {
    await createSession("leak-c", "/tmp/lc", 803);
    const res = await fetch(`${baseUrl()}/sessions/leak-c`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: Record<string, unknown> };
    expect("channel_token" in body.session).toBe(false);
  });
});

// ----------------------------------------------------------------
// TS-M ORDER BY tiebreaker: sessions with identical (null) statusline
// timestamps should come back stably in session_id-desc order.
// ----------------------------------------------------------------

describe("TS-M: listSessions tiebreaker", () => {
  test("identical latest_statusline_at falls back to session_id DESC", async () => {
    // All three sessions are freshly created with latest_statusline_at=null.
    // `started_at` comes from the ts we supply; inject identical ts so the
    // tiebreaker decides the final order.
    const ts = Date.now();
    async function seed(id: string, cwd: string, pid: number) {
      await fetch(`${baseUrl()}/hooks/session-start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: id, cwd, pid, ts }),
      });
    }
    await seed("tie-aaa", "/tmp/tie-aaa", 901);
    await seed("tie-bbb", "/tmp/tie-bbb", 902);
    await seed("tie-ccc", "/tmp/tie-ccc", 903);

    const res = await fetch(`${baseUrl()}/sessions?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { session_id: string }[] };
    const ids = body.sessions.map((s) => s.session_id);
    // tie-ccc > tie-bbb > tie-aaa under `session_id DESC` fallback.
    const idxAaa = ids.indexOf("tie-aaa");
    const idxBbb = ids.indexOf("tie-bbb");
    const idxCcc = ids.indexOf("tie-ccc");
    expect(idxAaa).toBeGreaterThan(-1);
    expect(idxCcc).toBeLessThan(idxBbb);
    expect(idxBbb).toBeLessThan(idxAaa);
  });
});
