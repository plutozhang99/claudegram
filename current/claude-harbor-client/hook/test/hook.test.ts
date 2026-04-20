/**
 * claude-harbor-hook tests.
 *
 * Covers:
 *   - POSTs correct URL / body for each mapped event
 *   - Malformed JSON → exits 0 without POST
 *   - Empty stdin → exits 0 without POST
 *   - Unknown event → exits 0 without POST
 *   - Network failure → exits 0, error on stderr
 *   - Timeout → exits 0, timeout message on stderr
 *   - Trailing-slash HARBOR_URL is normalized
 */

import { describe, expect, test } from "bun:test";
import { run } from "../src/index.ts";
import { EVENT_PATHS, HOOK_EVENTS } from "../src/events.ts";

/** Wrap a string as an async iterable of a single Uint8Array chunk. */
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
  readonly headers: Headers;
}

function makeFetch(
  capture: Capture[],
  behavior: "ok" | "throw" | "abort" = "ok",
): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    capture.push({ url, body, headers });
    if (behavior === "throw") {
      throw new Error("simulated network failure");
    }
    if (behavior === "abort") {
      // Wait for the abort signal to fire.
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
      return new Response("", { status: 200 });
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("event mapping", () => {
  for (const event of HOOK_EVENTS) {
    test(`${event} -> /hooks/${EVENT_PATHS[event]}`, async () => {
      const capture: Capture[] = [];
      const logs: string[] = [];
      const code = await run({
        argv: [event],
        env: { HARBOR_URL: "http://127.0.0.1:7823" },
        stdinSource: asStdin(JSON.stringify({ event, ok: true })),
        fetchImpl: makeFetch(capture, "ok"),
        logErr: (m) => logs.push(m),
      });
      expect(code).toBe(0);
      expect(capture).toHaveLength(1);
      expect(capture[0]!.url).toBe(
        `http://127.0.0.1:7823/hooks/${EVENT_PATHS[event]}`,
      );
      expect(capture[0]!.headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(capture[0]!.body)).toEqual({ event, ok: true });
    });
  }
});

describe("robustness", () => {
  test("malformed JSON → exits 0, no POST", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["SessionStart"],
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("not-json{{{"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(0);
    expect(logs.some((l) => l.includes("invalid JSON"))).toBe(true);
  });

  test("empty stdin → exits 0, no POST", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["Stop"],
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin("   \n  "),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(0);
  });

  test("unknown event → exits 0, no POST", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["BogusEvent"],
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(0);
    expect(logs.some((l) => l.includes("unknown event"))).toBe(true);
  });

  test("missing event arg → exits 0, no POST", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: [],
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(0);
    expect(logs.some((l) => l.includes("missing event-name"))).toBe(true);
  });

  test("network failure → exits 0, stderr-only", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["PreToolUse"],
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin('{"ok":1}'),
      fetchImpl: makeFetch(capture, "throw"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(logs.some((l) => l.includes("failed"))).toBe(true);
  });

  test("timeout → exits 0, stderr mentions timeout", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["PostToolUse"],
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: asStdin('{"ok":1}'),
      fetchImpl: makeFetch(capture, "abort"),
      logErr: (m) => logs.push(m),
      timeoutMs: 20,
    });
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(logs.some((l) => l.toLowerCase().includes("timed out"))).toBe(true);
  });
});

describe("URL validation", () => {
  test("rejects non-http(s) scheme, falls back to default", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["SessionStart"],
      env: { HARBOR_URL: "file:///etc/passwd" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture[0]!.url).toBe(
      "http://localhost:7823/hooks/session-start",
    );
    expect(logs.some((l) => l.toLowerCase().includes("not allowed"))).toBe(true);
  });

  test("rejects malformed URL, falls back to default", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["SessionStart"],
      env: { HARBOR_URL: "not-a-url" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(capture[0]!.url).toBe(
      "http://localhost:7823/hooks/session-start",
    );
    expect(logs.some((l) => l.toLowerCase().includes("not a valid url"))).toBe(
      true,
    );
  });

  test("strips userinfo from HARBOR_URL and warns", async () => {
    const capture: Capture[] = [];
    const logs: string[] = [];
    const code = await run({
      argv: ["SessionStart"],
      env: { HARBOR_URL: "http://user:pass@127.0.0.1:7823" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    // No `user:pass@` in the outgoing URL.
    expect(capture[0]!.url).not.toContain("user:pass");
    expect(capture[0]!.url).toContain("127.0.0.1:7823");
    expect(
      logs.some((l) => l.toLowerCase().includes("credentials")),
    ).toBe(true);
  });
});

describe("stdin timeout (e2e)", () => {
  test("spawned binary with never-closed stdin exits 0 within budget", async () => {
    // We can't easily override stdinTimeoutMs from the CLI, so the
    // default 1500 ms applies. Allow 1500 + 500 = 2000 ms slack.
    const ENTRY = `${import.meta.dir}/../src/index.ts`;
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", ENTRY, "SessionStart"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HARBOR_URL: "http://127.0.0.1:1" },
    });
    const start = Date.now();
    // Deliberately do NOT close proc.stdin — the timeout must kick in.
    const code = await proc.exited;
    const elapsed = Date.now() - start;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe("stdin timeout", () => {
  test("never-closing stdin returns error and exits 0", async () => {
    // An async-iterable that never yields. The run() must return
    // promptly thanks to stdinTimeoutMs.
    const pending: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {
          // never resolve
        });
      },
    };
    const logs: string[] = [];
    const start = Date.now();
    const code = await run({
      argv: ["SessionStart"],
      env: { HARBOR_URL: "http://127.0.0.1:7823" },
      stdinSource: pending,
      fetchImpl: makeFetch([], "ok"),
      logErr: (m) => logs.push(m),
      stdinTimeoutMs: 80,
    });
    const elapsed = Date.now() - start;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(500);
    expect(logs.some((l) => l.includes("stdin read failed"))).toBe(true);
  });
});

describe("URL normalization", () => {
  test("trailing slash on HARBOR_URL is stripped", async () => {
    const capture: Capture[] = [];
    const code = await run({
      argv: ["SessionStart"],
      env: { HARBOR_URL: "http://127.0.0.1:7823///" },
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: () => {},
    });
    expect(code).toBe(0);
    expect(capture[0]!.url).toBe("http://127.0.0.1:7823/hooks/session-start");
  });

  test("default HARBOR_URL when unset", async () => {
    const capture: Capture[] = [];
    const code = await run({
      argv: ["Notification"],
      env: {},
      stdinSource: asStdin("{}"),
      fetchImpl: makeFetch(capture, "ok"),
      logErr: () => {},
    });
    expect(code).toBe(0);
    expect(capture[0]!.url).toBe(
      "http://localhost:7823/hooks/notification",
    );
  });
});
