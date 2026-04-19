import type { ServerWebSocket } from 'bun';
import type { Message, Session } from '../repo/types.js';

/** Discriminant data placed in the `ws.data` slot at /user-socket upgrade time. */
export interface UserSocketData {
  readonly kind: 'user-socket';
}

export type BroadcastPayload =
  | { readonly type: 'message'; readonly session_id: string; readonly message: Message }
  | { readonly type: 'session_update'; readonly session: Session };

export type TryAddResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'cap_exceeded' };

export interface Hub {
  /** @deprecated Use tryAdd for cap-aware addition. */
  add(ws: ServerWebSocket<unknown>): void;
  tryAdd(ws: ServerWebSocket<unknown>): TryAddResult;
  remove(ws: ServerWebSocket<unknown>): void;
  broadcast(payload: BroadcastPayload): void;
  readonly size: number;
}

export class InMemoryHub implements Hub {
  private readonly sockets = new Set<ServerWebSocket<unknown>>();
  private readonly maxConnections: number;

  constructor(maxConnections = 256) {
    this.maxConnections = maxConnections;
  }

  /**
   * Cap-aware add. Returns `{ ok: true }` on success or
   * `{ ok: false, reason: 'cap_exceeded' }` when at capacity.
   */
  tryAdd(ws: ServerWebSocket<unknown>): TryAddResult {
    if (this.sockets.size >= this.maxConnections) {
      return { ok: false, reason: 'cap_exceeded' };
    }
    this.sockets.add(ws);
    return { ok: true };
  }

  /**
   * @deprecated Prefer tryAdd() for cap-aware addition.
   * Kept for backward compatibility — does not enforce cap.
   */
  add(ws: ServerWebSocket<unknown>): void {
    this.sockets.add(ws);
  }

  remove(ws: ServerWebSocket<unknown>): void {
    this.sockets.delete(ws);
  }

  get size(): number {
    return this.sockets.size;
  }

  broadcast(payload: BroadcastPayload): void {
    const text = JSON.stringify(payload);
    for (const ws of this.sockets) {
      try {
        ws.send(text);
      } catch {
        // dead sockets are cleaned on close — best-effort delivery
      }
    }
  }
}
