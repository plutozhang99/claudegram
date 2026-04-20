/**
 * MCP stdio JSON-RPC reader/writer + request handlers.
 *
 * Wire format: newline-delimited JSON on stdin/stdout per the MCP stdio
 * transport convention. Each line is a complete JSON-RPC 2.0 message.
 *
 * We implement the minimum handshake surface CC needs:
 *   - initialize          → respond with server capabilities
 *   - notifications/initialized → no-op
 *   - tools/list          → returns single `reply` tool
 *   - tools/call name=reply → invokes sendReply() and returns tool result
 *
 * Inbound pushes from the WS side are written to stdout as
 * `notifications/claude/channel` per CHANNELS-REFERENCE §2.
 */

import type {
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcResponse,
  SendReply,
} from "./types.ts";
import { log } from "./config.ts";

/** Cap on the per-line stdin buffer — defensive, 1 MiB. */
export const MAX_STDIN_LINE_BYTES = 1024 * 1024;
/** Cap on the outbound `reply` text length (pre-HTTP). Must match server cap. */
export const MAX_REPLY_TEXT_LEN = 60_000;

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "claude-harbor";
const SERVER_VERSION = "0.0.1";

const REPLY_TOOL = {
  name: "reply",
  description: "Send a message back over this claude-harbor channel",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: {
        type: "string" as const,
        description: "Channel chat id (from inbound <channel> tag).",
      },
      text: {
        type: "string" as const,
        description: "Message text to send back.",
      },
    },
    required: ["chat_id", "text"] as const,
  },
} as const;

/** Writer handle: takes a line (no trailing newline) and emits it to stdout. */
export type LineWriter = (line: string) => void;

export interface McpServerOptions {
  readonly writer: LineWriter;
  readonly sendReply: SendReply;
}

/** Strict string field extract from an unknown record. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function writeMessage(
  writer: LineWriter,
  msg: JsonRpcResponse | JsonRpcNotification,
): void {
  writer(JSON.stringify(msg));
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  return { jsonrpc: "2.0", id, error };
}

/** Build the result payload for MCP `initialize`. */
function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    instructions:
      "claude-harbor channel. Inbound messages arrive as " +
      "<channel source=\"claude-harbor\" chat_id=\"…\">. Reply using the " +
      "reply tool with the same chat_id.",
  };
}

/** Build the MCP tool-result envelope for a reply call. */
function replyToolResult(ok: boolean, note: string): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: ok ? `sent: ${note}` : `failed: ${note}`,
      },
    ],
    isError: !ok,
  };
}

/**
 * Handle a single JSON-RPC request or notification from CC.
 * Never throws — malformed / unknown methods produce JSON-RPC error
 * responses (for requests) or are logged (for notifications).
 */
export async function handleMessage(
  raw: unknown,
  opts: McpServerOptions,
): Promise<void> {
  if (!isObject(raw)) {
    log.warn("mcp: dropping non-object message", {});
    return;
  }
  // Narrow id: JSON-RPC 2.0 permits string, number, or null.
  const rawId = raw.id;
  const id: string | number | null =
    typeof rawId === "string" || typeof rawId === "number"
      ? rawId
      : null;
  const method = asString(raw.method);
  const isNotification = rawId === undefined;

  if (!method) {
    if (!isNotification) {
      writeMessage(
        opts.writer,
        errorResponse(id, -32600, "invalid request: missing method"),
      );
    }
    return;
  }

  if (method === "initialize") {
    if (isNotification) return;
    writeMessage(opts.writer, {
      jsonrpc: "2.0",
      id,
      result: initializeResult(),
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    // No response for notifications.
    return;
  }

  if (method === "tools/list") {
    if (isNotification) return;
    writeMessage(opts.writer, {
      jsonrpc: "2.0",
      id,
      result: { tools: [REPLY_TOOL] },
    });
    return;
  }

  if (method === "tools/call") {
    if (isNotification) return;
    await handleToolsCall(id, raw.params, opts);
    return;
  }

  if (method === "ping") {
    if (isNotification) return;
    writeMessage(opts.writer, { jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Unknown method.
  if (!isNotification) {
    writeMessage(
      opts.writer,
      errorResponse(id, -32601, `method not found: ${method}`),
    );
  } else {
    log.info("mcp: ignoring unknown notification", { method });
  }
}

async function handleToolsCall(
  id: string | number | null,
  params: unknown,
  opts: McpServerOptions,
): Promise<void> {
  if (!isObject(params)) {
    writeMessage(
      opts.writer,
      errorResponse(id, -32602, "invalid params: expected object"),
    );
    return;
  }
  const name = asString(params.name);
  if (!name) {
    writeMessage(
      opts.writer,
      errorResponse(id, -32602, "invalid params: missing tool name"),
    );
    return;
  }
  if (name !== "reply") {
    writeMessage(
      opts.writer,
      errorResponse(id, -32601, `unknown tool: ${name}`),
    );
    return;
  }
  const args = isObject(params.arguments) ? params.arguments : {};
  // Reference spec uses `text`; accept `content` as an alias for robustness.
  const text = asString(args.text) ?? asString(args.content);
  const chatId = asString(args.chat_id);
  if (!text) {
    writeMessage(
      opts.writer,
      errorResponse(id, -32602, "invalid params: missing text"),
    );
    return;
  }
  if (text.length > MAX_REPLY_TEXT_LEN) {
    writeMessage(
      opts.writer,
      errorResponse(id, -32602, "text too long"),
    );
    return;
  }
  const meta: Record<string, string> = {};
  if (chatId) meta.chat_id = chatId;
  const result = await opts.sendReply(text, Object.keys(meta).length ? meta : undefined);
  const ok = result.ok;
  const note = ok ? "ok" : result.error;
  writeMessage(opts.writer, {
    jsonrpc: "2.0",
    id,
    result: replyToolResult(ok, note),
  });
}

/**
 * Emit an inbound channel push to CC. Per CHANNELS-REFERENCE §2 the
 * notification method is `notifications/claude/channel`, params is
 * `{ content, meta? }`, and meta values must be strings.
 */
export function emitChannelPush(
  writer: LineWriter,
  content: string,
  meta: Record<string, string>,
): void {
  // Enforce string-only meta per reference spec §2.
  const sanitized: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string") sanitized[k] = v;
  }
  const note: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: {
      content,
      meta: sanitized,
    },
  };
  writeMessage(writer, note);
}

/**
 * Parse a single stdin line. Returns null on malformed JSON (caller
 * should write a JSON-RPC parse-error response or drop silently).
 */
export function parseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Consume a stdin readable as a stream of newline-delimited JSON-RPC
 * messages. Resolves when stdin hits EOF.
 */
export async function runMcpLoop(
  stdin: AsyncIterable<string | Uint8Array>,
  opts: McpServerOptions,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  let overflowed = false;
  for await (const chunk of stdin) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    // Overflow defense: if buf grows past cap without a newline, emit a
    // JSON-RPC parse error and discard up to the next newline (resync).
    if (buf.length > MAX_STDIN_LINE_BYTES) {
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        if (!overflowed) {
          log.warn("mcp: stdin line exceeded cap, waiting for newline to resync", {
            bufLen: buf.length,
            cap: MAX_STDIN_LINE_BYTES,
          });
          writeMessage(
            opts.writer,
            errorResponse(null, -32700, "parse error: line too long"),
          );
          overflowed = true;
        }
        // Drop the entire buffer so we don't keep accumulating unbounded.
        buf = "";
        continue;
      }
      // Found a newline — discard everything up to and including it.
      if (!overflowed) {
        writeMessage(
          opts.writer,
          errorResponse(null, -32700, "parse error: line too long"),
        );
      }
      buf = buf.slice(nl + 1);
      overflowed = false;
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      await consume(line, opts);
    }
  }
  if (buf.trim() && buf.length <= MAX_STDIN_LINE_BYTES) {
    await consume(buf, opts);
  }
}

async function consume(line: string, opts: McpServerOptions): Promise<void> {
  const parsed = parseLine(line);
  if (parsed === null) {
    if (line.trim().length > 0) {
      writeMessage(
        opts.writer,
        errorResponse(null, -32700, "parse error"),
      );
    }
    return;
  }
  await handleMessage(parsed, opts);
}

export const __test = { REPLY_TOOL, PROTOCOL_VERSION };
