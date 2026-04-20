/**
 * claude-harbor-statusline tests.
 *
 * Covers:
 *   - Happy path: stdin JSON POSTs, `line` prints to stdout
 *   - Malformed JSON → prints OFFLINE_LINE, no POST
 *   - Empty stdin → prints OFFLINE_LINE, no POST
 *   - Network failure → OFFLINE_LINE
 *   - Non-200 → OFFLINE_LINE
 *   - Response missing `line` → OFFLINE_LINE
 *   - Timeout (500 ms budget respected)
 *   - Trailing-slash HARBOR_URL normalized
 */

import { describe, expect, test } from "bun:test";
import { run } from "../src/index.ts";

const OFFLINE_LINE = "claude-harbor: offline";

function asStdin(text: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text);
    },
  };
}

interface Capture {
  readonly url: string;
  readonly body: string;
}

type Behavior =
  | { kind: "ok"; line: unknown }
  | { kind: "http-error"; status: number }
  | { kind: "bad-json" }
  | { kind: "throw" }
  | { kind: "abort" };

function makeFetch(capture: Capture[], behavior: Behavior): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    capture.push({ url, body });
    if (behavior.kind === "throw") throw new Error("net down");
    if (behavior.kind === "abort") {
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
      return new Response("", { status: 200 });
    }
    if (behavior.kind === "http-error") {
      return new Response("oops", { status: behavior.status });
    }
    if (behavior.kind === "bad-json") {
      return new Response("not-json{{{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ line: behavior.line }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("happy path", () => {
  test("POSTs to /statusline and echoes server line", async () => {
    const capture: Capture[] = [];
    const out: string[] = [];
    const code = await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin(JSON.stringify({ model: { id: "sonnet-4.6" } })),
      fetchImpl: makeFetch(capture, { kind: "ok", line: "Claude · 12% · $0.04" }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.url).toBe("http://127.0.0.1:7823/statusline");
    expect(out).toEqual(["Claude · 12% · $0.04"]);
  });

  test("trailing slash on HARBOR_URL is stripped", async () => {
    const capture: Capture[] = [];
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823/" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, { kind: "ok", line: "ok" }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(capture[0]!.url).toBe("http://127.0.0.1:7823/statusline");
  });

  test("default HARBOR_URL when unset", async () => {
    const capture: Capture[] = [];
    const out: string[] = [];
    await run({
      env: {},
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, { kind: "ok", line: "ok" }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(capture[0]!.url).toBe("http://localhost:7823/statusline");
  });
});

describe("degraded paths", () => {
  test("malformed stdin JSON → OFFLINE, no POST", async () => {
    const capture: Capture[] = [];
    const out: string[] = [];
    const logs: string[] = [];
    const code = await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("not-json{{{"),
      fetchImpl: makeFetch(capture, { kind: "ok", line: "x" }),
      stdout: (m) => out.push(m),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(0);
    expect(out).toEqual([OFFLINE_LINE]);
    expect(logs.some((l) => l.includes("invalid JSON"))).toBe(true);
  });

  test("empty stdin → OFFLINE, no POST", async () => {
    const capture: Capture[] = [];
    const out: string[] = [];
    const code = await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("  \n  "),
      fetchImpl: makeFetch(capture, { kind: "ok", line: "x" }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(0);
    expect(out).toEqual([OFFLINE_LINE]);
  });

  test("network failure → OFFLINE", async () => {
    const capture: Capture[] = [];
    const out: string[] = [];
    const logs: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, { kind: "throw" }),
      stdout: (m) => out.push(m),
      logErr: (m) => logs.push(m),
    });
    expect(capture).toHaveLength(1);
    expect(out).toEqual([OFFLINE_LINE]);
    expect(logs.some((l) => l.includes("network-error"))).toBe(true);
  });

  test("non-200 → OFFLINE", async () => {
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "http-error", status: 500 }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toEqual([OFFLINE_LINE]);
  });

  test("response is not JSON → OFFLINE", async () => {
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "bad-json" }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toEqual([OFFLINE_LINE]);
  });

  test("response missing `line` → OFFLINE", async () => {
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "ok", line: undefined }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toEqual([OFFLINE_LINE]);
  });

  test("response `line` is not a string → OFFLINE", async () => {
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "ok", line: 42 }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toEqual([OFFLINE_LINE]);
  });

  test("null `line` in OK response → OFFLINE_LINE", async () => {
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "ok", line: null }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toEqual([OFFLINE_LINE]);
  });

  test("empty-string `line` in OK response → OFFLINE_LINE", async () => {
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "ok", line: "" }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toEqual([OFFLINE_LINE]);
  });

  test("ASCII control chars in `line` are stripped (ESC [2J)", async () => {
    const out: string[] = [];
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      // Injects ESC (0x1B) + `[2J` (ANSI clear-screen) and a DEL (0x7F).
      fetchImpl: makeFetch([], {
        kind: "ok",
        line: "Claude \u001B[2Jmasked\u007F ok",
      }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toEqual(["Claude [2Jmasked ok"]);
  });

  test("very long `line` is truncated to 512 chars", async () => {
    const out: string[] = [];
    const huge = "x".repeat(5000);
    await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "ok", line: huge }),
      stdout: (m) => out.push(m),
      logErr: () => {},
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(512);
  });

  test("timeout → OFFLINE", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const code = await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch([], { kind: "abort" }),
      stdout: (m) => out.push(m),
      logErr: (m) => logs.push(m),
      timeoutMs: 20,
    });
    expect(code).toBe(0);
    expect(out).toEqual([OFFLINE_LINE]);
    expect(logs.some((l) => l.includes("timeout"))).toBe(true);
  });
});

describe("URL validation", () => {
  test("rejects non-http(s) scheme, falls back to default", async () => {
    const capture: Capture[] = [];
    const out: string[] = [];
    const logs: string[] = [];
    await run({
      env: { HARBOR_URL: "file:///etc/passwd" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, { kind: "ok", line: "hi" }),
      stdout: (m) => out.push(m),
      logErr: (m) => logs.push(m),
    });
    expect(capture[0]!.url).toBe("http://localhost:7823/statusline");
    expect(logs.some((l) => l.toLowerCase().includes("not allowed"))).toBe(true);
  });

  test("strips userinfo from HARBOR_URL and warns", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    await run({
      env: { HARBOR_URL: "http://alice:secret@127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, { kind: "ok", line: "hi" }),
      stdout: () => {},
      logErr: (m) => logs.push(m),
    });
    expect(capture[0]!.url).not.toContain("alice");
    expect(capture[0]!.url).not.toContain("secret");
    expect(logs.some((l) => l.toLowerCase().includes("credentials"))).toBe(true);
  });
});

describe("stdin timeout", () => {
  test("never-closing stdin yields OFFLINE promptly", async () => {
    const pending: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {});
      },
    };
    const out: string[] = [];
    const logs: string[] = [];
    const start = Date.now();
    const code = await run({
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: pending,
      fetchImpl: makeFetch([], { kind: "ok", line: "x" }),
      stdout: (m) => out.push(m),
      logErr: (m) => logs.push(m),
      stdinTimeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(400);
    expect(out).toEqual([OFFLINE_LINE]);
    expect(logs.some((l) => l.includes("stdin"))).toBe(true);
  });
});
