/**
 * Shared types for the stdio MCP proxy.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: T;
  readonly error?: JsonRpcError;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** WS handshake first-frame shape (proxy -> server). */
export interface WsHandshake {
  readonly parent_pid: number;
  readonly cwd: string;
  readonly ts: number;
}

/** WS bound ack (server -> proxy). */
export interface WsBound {
  readonly type: "bound";
  readonly session_id: string;
  readonly channel_token: string;
}

/** WS inbound push (server -> proxy). */
export interface WsPush {
  readonly type: "push";
  readonly content: string;
  readonly meta?: Record<string, string>;
}

/** Callback signature the MCP handler uses to deliver outbound replies. */
export type SendReply = (
  content: string,
  meta?: Record<string, string>,
) => Promise<{ ok: true } | { ok: false; error: string }>;
