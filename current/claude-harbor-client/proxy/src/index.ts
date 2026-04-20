/**
 * claude-harbor-proxy entrypoint.
 *
 * Wires stdio (MCP to/from CC) <-> WebSocket (to harbor server). Spawned by
 * Claude Code as a channel plugin. Reads MCP on stdin, writes MCP on
 * stdout, logs to stderr.
 */

import { loadConfig, log } from "./config.ts";
import { connectWs } from "./ws-client.ts";
import { emitChannelPush, runMcpLoop, type LineWriter } from "./mcp.ts";
import { shortSessionId } from "./sanitize.ts";
import type { SendReply } from "./types.ts";

async function postReply(
  harborUrl: string,
  channelToken: string,
  content: string,
  meta: Record<string, string> | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = JSON.stringify({
    channel_token: channelToken,
    content,
    ...(meta ? { meta } : {}),
  });
  try {
    const res = await fetch(`${harborUrl}/channel/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, error: `http ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: `fetch failed: ${String(err)}` };
  }
}

export interface RunOptions {
  readonly harborUrl: string;
  readonly parentPid: number;
  readonly cwd: string;
  readonly stdin: AsyncIterable<string | Uint8Array>;
  readonly writer: LineWriter;
  /** Optional: provide a pre-built fetch for tests. Defaults to globalThis.fetch. */
  readonly postReply?: (
    harborUrl: string,
    channelToken: string,
    content: string,
    meta?: Record<string, string>,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Optional external shutdown hook. When present, runProxy registers a
   * callback that can be invoked to close the WS cleanly. Useful for
   * SIGTERM handling in the CLI entrypoint without exposing the client.
   */
  readonly registerShutdown?: (close: () => void) => void;
}

/**
 * Run the proxy to completion. Resolves when stdin EOFs and the WS client
 * has been closed cleanly.
 */
export async function runProxy(opts: RunOptions): Promise<void> {
  let shuttingDown = false;
  const client = connectWs({
    harborUrl: opts.harborUrl,
    parentPid: opts.parentPid,
    cwd: opts.cwd,
    onPush: (push) => {
      emitChannelPush(opts.writer, push.content, push.meta ?? {});
    },
    onBound: (bound) => {
      log.info("ws: bound", {
        session_id: shortSessionId(bound.session_id),
      });
    },
    onFatal: (reason) => {
      if (shuttingDown) return;
      log.error("ws: fatal", { reason });
      // Give stderr a tick to flush, then exit non-zero.
      setTimeout(() => process.exit(1), 10).unref?.();
    },
  });

  opts.registerShutdown?.(() => {
    shuttingDown = true;
    client.close();
  });

  const sendReply: SendReply = async (content, meta) => {
    const token = client.channelToken();
    if (!token) {
      return { ok: false, error: "channel not bound yet" };
    }
    const post = opts.postReply ?? postReply;
    return post(opts.harborUrl, token, content, meta);
  };

  try {
    await runMcpLoop(opts.stdin, { writer: opts.writer, sendReply });
  } finally {
    shuttingDown = true;
    client.close();
  }
}

/**
 * Adapt Node's `process.stdin` (a Readable) to the `AsyncIterable` shape
 * `runProxy` expects. Node ReadStream is already async-iterable at runtime;
 * this helper just documents the contract and avoids the unsafe double-cast.
 */
function stdinIter(
  stream: NodeJS.ReadStream,
): AsyncIterable<string | Uint8Array> {
  return stream as AsyncIterable<string | Uint8Array>;
}

if (import.meta.main) {
  const cfg = loadConfig();
  const writer: LineWriter = (line) => {
    process.stdout.write(line + "\n");
  };
  let closeWs: (() => void) | null = null;
  let shuttingDownOnce = false;
  const shutdown = (signal: string): void => {
    if (shuttingDownOnce) return;
    shuttingDownOnce = true;
    log.info("proxy: shutting down", { signal });
    try {
      closeWs?.();
    } catch {
      // ignore
    }
    try {
      process.stdin.pause();
    } catch {
      // ignore
    }
    // Safety net: signal-driven shutdown always exits 0 after a short grace
    // period so a stuck stdin iterator can't hold the process open.
    setTimeout(() => process.exit(0), 150);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  runProxy({
    harborUrl: cfg.harborUrl,
    parentPid: process.ppid,
    cwd: process.cwd(),
    stdin: stdinIter(process.stdin),
    writer,
    registerShutdown: (fn) => {
      closeWs = fn;
    },
  })
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.error("proxy: fatal", { err: String(err) });
      process.exit(1);
    });
}
