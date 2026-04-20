/**
 * Unit-level tests for P0.2 review fixes on the proxy:
 *   - inbound push caps (content length, control chars, meta caps)
 *   - HARBOR_URL scheme allowlist
 *   - stdin 1 MiB line cap
 *   - reply text pre-check (> 60k)
 *   - args.content alias path
 *   - tools/list schema properties
 *
 * Reconnect + SIGTERM tests live in proxy.p02-reconnect.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  capContent,
  sanitizeMeta,
  stripControlChars,
  MAX_CONTENT_LEN,
  MAX_META_ENTRIES,
} from "../src/sanitize.ts";
import {
  parsePush,
  parseLegacyPush,
} from "../src/ws-client.ts";
import {
  handleMessage,
  runMcpLoop,
  type LineWriter,
  MAX_STDIN_LINE_BYTES,
  MAX_REPLY_TEXT_LEN,
  __test as mcpTest,
} from "../src/mcp.ts";
import { validateHarborUrl } from "../src/config.ts";

// ---- pushable stdin helper ---------------------------------------------

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

// ---- sanitize utilities ------------------------------------------------

describe("sanitize utilities", () => {
  test("capContent truncates at MAX_CONTENT_LEN", () => {
    const big = "x".repeat(MAX_CONTENT_LEN + 100);
    const out = capContent(big);
    expect(out.length).toBe(MAX_CONTENT_LEN);
  });

  test("stripControlChars removes 0x00-0x1F except \\n and \\t, and 0x7F", () => {
    const input = "a\u0000b\u0001c\td\ne\u007ff";
    const out = stripControlChars(input);
    expect(out).toBe("abc\td\nef");
  });

  test("sanitizeMeta enforces entry cap, key-length cap, value-size cap", () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < MAX_META_ENTRIES + 5; i++) meta[`k${i}`] = "v";
    meta["longkey_" + "x".repeat(300)] = "v";
    meta["oversized"] = "v".repeat(4096 + 10);
    const out = sanitizeMeta(meta);
    expect(Object.keys(out).length).toBeLessThanOrEqual(MAX_META_ENTRIES);
    for (const [k, v] of Object.entries(out)) {
      expect(k.length).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(v, "utf8")).toBeLessThanOrEqual(4096);
    }
  });
});

// ---- parsePush / parseLegacyPush sanitation ----------------------------

describe("parsePush / parseLegacyPush sanitation", () => {
  test("parsePush caps content length and strips control chars", () => {
    const bigRaw = "a".repeat(MAX_CONTENT_LEN + 50);
    const out = parsePush({
      type: "push",
      content: bigRaw + "\u0001\u0007",
      meta: { chat_id: "1" },
    });
    expect(out).not.toBeNull();
    expect(out?.content.length).toBeLessThanOrEqual(MAX_CONTENT_LEN);
    expect(out?.content).not.toContain("\u0001");
    expect(out?.content).not.toContain("\u0007");
  });

  test("parseLegacyPush caps meta and drops oversize entries", () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 25; i++) meta[`k${i}`] = "v";
    const out = parseLegacyPush({
      method: "notifications/claude/channel",
      params: { content: "hi", meta },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out?.meta ?? {}).length).toBeLessThanOrEqual(
      MAX_META_ENTRIES,
    );
  });

  test("parsePush drops meta keys longer than 256 chars", () => {
    const out = parsePush({
      type: "push",
      content: "hi",
      meta: { ["x".repeat(300)]: "v", ok: "y" },
    });
    expect(out?.meta?.ok).toBe("y");
    expect(Object.keys(out?.meta ?? {}).every((k) => k.length <= 256)).toBe(true);
  });
});

// ---- HARBOR_URL scheme allowlist ---------------------------------------

describe("validateHarborUrl", () => {
  test("accepts http://", () => {
    expect(() => validateHarborUrl("http://localhost:7823")).not.toThrow();
  });
  test("accepts https://", () => {
    expect(() => validateHarborUrl("https://harbor.example.com")).not.toThrow();
  });
  test("rejects ws://", () => {
    expect(() => validateHarborUrl("ws://localhost:7823")).toThrow();
  });
  test("rejects file://", () => {
    expect(() => validateHarborUrl("file:///etc/passwd")).toThrow();
  });
  test("rejects javascript:", () => {
    expect(() => validateHarborUrl("javascript:alert(1)")).toThrow();
  });
  test("rejects unparsable strings", () => {
    expect(() => validateHarborUrl("not a url")).toThrow();
  });
});

// ---- stdin line cap ----------------------------------------------------

describe("runMcpLoop stdin line cap", () => {
  test("oversized line emits -32700 parse error and resyncs on next newline", async () => {
    const lines: string[] = [];
    const writer: LineWriter = (l) => lines.push(l);
    const stdin = makePushableStdin();

    const big = "a".repeat(MAX_STDIN_LINE_BYTES + 100);
    stdin.push(big);
    stdin.push("\n");
    stdin.push(
      JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" }) + "\n",
    );
    stdin.end();

    await runMcpLoop(stdin.iter, {
      writer,
      sendReply: async () => ({ ok: true }),
    });

    const parseErr = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { error?: { code: number; message: string } };
        } catch {
          return {};
        }
      })
      .find((m) => m.error?.code === -32700);
    expect(parseErr).toBeDefined();

    const pingResp = lines.find((l) => l.includes("\"id\":42"));
    expect(pingResp).toBeDefined();
  });
});

// ---- reply text pre-check ----------------------------------------------

describe("tools/call reply text length pre-check", () => {
  test("text.length > 60000 returns -32602 WITHOUT calling sendReply", async () => {
    const lines: string[] = [];
    let called = false;
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: {
          name: "reply",
          arguments: {
            chat_id: "1",
            text: "a".repeat(MAX_REPLY_TEXT_LEN + 1),
          },
        },
      },
      {
        writer: (l) => lines.push(l),
        sendReply: async () => {
          called = true;
          return { ok: true };
        },
      },
    );
    expect(called).toBe(false);
    const resp = JSON.parse(lines[0] as string) as {
      error: { code: number; message: string };
    };
    expect(resp.error.code).toBe(-32602);
    expect(resp.error.message).toContain("text too long");
  });
});

// ---- args.content alias path -------------------------------------------

describe("tools/call reply accepts args.content as alias for args.text", () => {
  test("content argument is forwarded to sendReply as body", async () => {
    const lines: string[] = [];
    const captured: { content: string | null } = { content: null };
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "reply",
          arguments: { chat_id: "9", content: "via content alias" },
        },
      },
      {
        writer: (l) => lines.push(l),
        sendReply: async (content) => {
          captured.content = content;
          return { ok: true };
        },
      },
    );
    expect(captured.content).toBe("via content alias");
    const resp = JSON.parse(lines[0] as string) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(resp.result.isError).not.toBe(true);
  });
});

// ---- tools/list schema properties --------------------------------------

describe("tools/list schema assertion", () => {
  test("reply tool has inputSchema.properties.chat_id and .text as strings", async () => {
    const lines: string[] = [];
    await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        writer: (l) => lines.push(l),
        sendReply: async () => ({ ok: true }),
      },
    );
    const resp = JSON.parse(lines[0] as string) as {
      result: {
        tools: Array<{
          inputSchema: {
            properties: {
              chat_id: { type: string };
              text: { type: string };
            };
          };
        }>;
      };
    };
    const tool = resp.result.tools[0];
    expect(tool?.inputSchema.properties.chat_id.type).toBe("string");
    expect(tool?.inputSchema.properties.text.type).toBe("string");
    expect(mcpTest.REPLY_TOOL.name).toBe("reply");
  });
});
