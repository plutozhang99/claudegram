/**
 * Tests for P0.2 review fixes — constant-time token check and meta caps
 * on the /channel/reply path.
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
  return { port, stop: () => h.stop() };
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

async function startSession(id: string): Promise<string> {
  const res = await postJson("/hooks/session-start", {
    session_id: id,
    cwd: `/tmp/${id}`,
    pid: 1,
    ts: Date.now(),
  });
  const body = (await res.json()) as { channel_token: string };
  return body.channel_token;
}

describe("/channel/reply auth + meta caps", () => {
  test("identical 401 body for wrong token vs unknown token", async () => {
    await startSession("sess-ct-1");

    const wrong = await postJson("/channel/reply", {
      channel_token: "definitely-not-the-real-token-0123456",
      content: "x",
    });
    const unknown = await postJson("/channel/reply", {
      channel_token: "another-bogus-token-abcdef0123456789",
      content: "x",
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const wrongBody = await wrong.text();
    const unknownBody = await unknown.text();
    expect(wrongBody).toBe(unknownBody);
    expect(wrongBody).toContain("invalid channel_token");
  });

  test("missing channel_token returns 400 (not 401)", async () => {
    const res = await postJson("/channel/reply", {
      content: "no token field",
    });
    expect(res.status).toBe(400);
  });

  test("meta with >16 entries returns 400", async () => {
    const token = await startSession("sess-meta-count");
    const meta: Record<string, string> = {};
    for (let i = 0; i < 17; i++) meta[`k${i}`] = "v";
    const res = await postJson("/channel/reply", {
      channel_token: token,
      content: "hi",
      meta,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("too many entries");
  });

  test("meta key longer than 256 chars returns 400", async () => {
    const token = await startSession("sess-meta-key");
    const longKey = "k".repeat(257);
    const res = await postJson("/channel/reply", {
      channel_token: token,
      content: "hi",
      meta: { [longKey]: "v" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("key too long");
  });

  test("meta value larger than 4 KiB returns 400", async () => {
    const token = await startSession("sess-meta-val");
    const bigValue = "x".repeat(4 * 1024 + 1);
    const res = await postJson("/channel/reply", {
      channel_token: token,
      content: "hi",
      meta: { k: bigValue },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("value too large");
  });

  test("meta within caps still accepted", async () => {
    const token = await startSession("sess-meta-ok");
    const res = await postJson("/channel/reply", {
      channel_token: token,
      content: "hi",
      meta: { chat_id: "42", user: "alice" },
    });
    expect(res.status).toBe(200);
  });

  test("meta validation fires BEFORE token lookup (no 401 leakage)", async () => {
    // Send a fake token + oversized meta. Must return 400 for meta, not
    // 401 for token — proves meta validation happens first.
    const bigValue = "x".repeat(4 * 1024 + 1);
    const res = await postJson("/channel/reply", {
      channel_token: "not-a-real-token",
      content: "hi",
      meta: { k: bigValue },
    });
    expect(res.status).toBe(400);
  });
});
