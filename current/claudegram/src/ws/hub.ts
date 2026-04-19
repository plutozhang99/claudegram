import type { ServerWebSocket } from 'bun';
import type { Message, Session } from '../repo/types.js';

/** Discriminant data placed in the `ws.data` slot at /user-socket upgrade time. */
export interface UserSocketData {
  readonly kind: 'user-socket';
}

export type BroadcastPayload =
  | { readonly type: 'message'; readonly session_id: string; readonly message: Message }
  | { readonly type: 'session_update'; readonly session: Session };

export interface Hub {
  add(ws: ServerWebSocket<unknown>): void;
  remove(ws: ServerWebSocket<unknown>): void;
  broadcast(payload: BroadcastPayload): void;
  readonly size: number;
}

export class InMemoryHub implements Hub {
  private readonly sockets = new Set<ServerWebSocket<unknown>>();

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
