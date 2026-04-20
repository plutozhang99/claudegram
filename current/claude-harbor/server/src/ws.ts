/**
 * WebSocket handlers. Bound to Bun.serve's `websocket` hooks.
 *
 * Flow:
 *   open       → start handshake timer (closes with 4004 if no handshake)
 *   message    → expect first frame as {parent_pid, cwd, ts}; correlate
 *   close      → unbind socket from session if bound
 */

import type { WebSocketHandler } from "bun";
import type { Db } from "./db.ts";
import {
  type HarborWs,
  type WsData,
  bindSocket,
  unbindSocket,
  findPendingMatch,
} from "./correlate.ts";
import { corrWindowMs, log } from "./config.ts";

function parseHandshake(raw: string | Buffer): {
  parent_pid: number;
  cwd: string;
  ts: number;
} | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const obj = JSON.parse(text) as Record<string, unknown>;
    const parent_pid = obj.parent_pid;
    const cwd = obj.cwd;
    const ts = obj.ts;
    if (typeof parent_pid !== "number" || !Number.isFinite(parent_pid)) return null;
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
    return { parent_pid, cwd, ts };
  } catch {
    return null;
  }
}

export function buildWsHandler(db: Db): WebSocketHandler<WsData> {
  return {
    open(ws: HarborWs) {
      // Close if no handshake within the correlation window.
      const timer = setTimeout(() => {
        if (!ws.data.channel_token) {
          try {
            ws.close(4004, "no matching session");
          } catch {
            // ignore
          }
        }
      }, corrWindowMs());
      timer.unref?.();
      ws.data.handshake_timer = timer;
    },

    message(ws: HarborWs, raw) {
      if (ws.data.channel_token) {
        // Post-handshake frames are not consumed in P0.1.
        return;
      }
      const hs = parseHandshake(raw as string | Buffer);
      if (!hs) {
        try {
          ws.close(4000, "bad handshake");
        } catch {
          // ignore
        }
        return;
      }
      const match = findPendingMatch({
        cwd: hs.cwd,
        parent_pid: hs.parent_pid,
        now: Date.now(),
      });
      if (!match) {
        try {
          ws.close(4004, "no matching session");
        } catch {
          // ignore
        }
        return;
      }
      const ok = bindSocket(match.channel_token, ws);
      if (!ok) {
        try {
          ws.close(4010, "already bound");
        } catch {
          // ignore
        }
        return;
      }
      ws.data.channel_token = match.channel_token;
      ws.data.session_id = match.session_id;
      if (ws.data.handshake_timer) {
        clearTimeout(ws.data.handshake_timer);
        ws.data.handshake_timer = undefined;
      }
      db.setSessionStatus(match.session_id, "active");
      try {
        ws.send(
          JSON.stringify({
            type: "bound",
            session_id: match.session_id,
            channel_token: match.channel_token,
          }),
        );
      } catch (err) {
        log.warn("ws: bound ack failed", { err: String(err) });
      }
      log.info("ws: bound", {
        session_id: match.session_id,
        cwd: hs.cwd,
        pid: hs.parent_pid,
      });
    },

    close(ws: HarborWs) {
      if (ws.data.handshake_timer) {
        clearTimeout(ws.data.handshake_timer);
        ws.data.handshake_timer = undefined;
      }
      const token = ws.data.channel_token;
      if (token) {
        unbindSocket(token, ws);
        if (ws.data.session_id) {
          db.setSessionStatus(ws.data.session_id, "idle");
        }
      }
    },
  };
}
