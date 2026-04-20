/**
 * Tiny in-process EventBus used to fan out server-side events (hooks,
 * statusline, replies, session lifecycle) to any subscriber — currently
 * the frontend WS at `WS /subscribe`.
 *
 * Characteristics:
 *   - Single-process, in-memory only. No persistence or cross-node fanout.
 *   - Synchronous dispatch. Each listener runs in its own try/catch so a
 *     buggy subscriber cannot take the bus (or other subscribers) down.
 *   - Listener errors are logged and swallowed.
 */

import type { MessageRow, SessionRow } from "./db.ts";
import type { PublicSessionRow } from "./db-queries.ts";
import { log } from "./config.ts";

/** Shape of the latest statusline snapshot broadcast to subscribers. */
export interface StatuslineBroadcast {
  latest_model: string | null;
  latest_model_display: string | null;
  latest_ctx_pct: number | null;
  latest_ctx_window_size: number | null;
  latest_limits_json: string | null;
  latest_cost_usd: number | null;
  latest_version: string | null;
  latest_permission_mode: string | null;
  latest_statusline_at: number | null;
}

/**
 * Discriminated union of all events published on the bus.
 *
 * Security: `session.created` / `session.updated` carry a `PublicSessionRow`
 * — the `channel_token` column is intentionally stripped before broadcast.
 * Producers MUST convert via `toPublicSessionRow()` before `emit()`.
 */
export type HarborEvent =
  | { type: "session.created"; session_id: string; session: PublicSessionRow }
  | { type: "session.updated"; session_id: string; session: PublicSessionRow }
  | { type: "session.ended"; session_id: string }
  | { type: "message.created"; session_id: string; message: MessageRow }
  | {
      type: "statusline.updated";
      session_id: string;
      statusline: StatuslineBroadcast;
    };

export type EventType = HarborEvent["type"];
export type EventHandler = (ev: HarborEvent) => void;

/** Hard cap on total subscribers (allSubs + typed) to bound memory. */
export const EVENT_BUS_MAX_SUBSCRIBERS = 32;

/**
 * Event bus. Use `subscribeAll` for fan-out listeners (frontend WS).
 * `subscribeType` is available for listeners that only care about a
 * subset — currently unused, kept for future extension.
 */
export class EventBus {
  private readonly allSubs: Set<EventHandler> = new Set();
  private readonly typeSubs: Map<EventType, Set<EventHandler>> = new Map();

  private totalSubscriberCount(): number {
    let n = this.allSubs.size;
    for (const bucket of this.typeSubs.values()) n += bucket.size;
    return n;
  }

  subscribeAll(handler: EventHandler): () => void {
    if (this.totalSubscriberCount() >= EVENT_BUS_MAX_SUBSCRIBERS) {
      throw new Error("event-bus: subscriber cap exceeded");
    }
    this.allSubs.add(handler);
    return () => {
      this.allSubs.delete(handler);
    };
  }

  subscribeType(type: EventType, handler: EventHandler): () => void {
    if (this.totalSubscriberCount() >= EVENT_BUS_MAX_SUBSCRIBERS) {
      throw new Error("event-bus: subscriber cap exceeded");
    }
    let bucket = this.typeSubs.get(type);
    if (!bucket) {
      bucket = new Set();
      this.typeSubs.set(type, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket!.delete(handler);
    };
  }

  emit(ev: HarborEvent): void {
    // Snapshot subscribers before iterating so listeners that unsubscribe
    // themselves mid-dispatch don't perturb the iteration.
    const all = Array.from(this.allSubs);
    for (const h of all) {
      try {
        h(ev);
      } catch (e) {
        log.warn("event-bus: subscriber threw", {
          type: ev.type,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const bucket = this.typeSubs.get(ev.type);
    if (!bucket) return;
    const typed = Array.from(bucket);
    for (const h of typed) {
      try {
        h(ev);
      } catch (e) {
        log.warn("event-bus: typed-subscriber threw", {
          type: ev.type,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /** Test helper — clear all subscribers. */
  __reset(): void {
    this.allSubs.clear();
    this.typeSubs.clear();
  }

  /** Test helper — expose subscriber count. */
  subscriberCount(): number {
    let n = this.allSubs.size;
    for (const bucket of this.typeSubs.values()) n += bucket.size;
    return n;
  }
}

/**
 * Process-global EventBus. Single-user single-process topology means one
 * shared bus is fine; tests can reset it via `__resetBus`. Handlers pass
 * this reference explicitly where possible; hook handlers reach for it
 * via `getBus()` to keep their existing signatures stable.
 */
let _bus: EventBus = new EventBus();

export function getBus(): EventBus {
  return _bus;
}

/** Test helper — swap out the bus with a fresh instance. */
export function __resetBus(): void {
  _bus.__reset();
  _bus = new EventBus();
}

/**
 * Extract the "statusline" shape subset of a SessionRow for broadcasting.
 */
export function extractStatuslineBroadcast(row: SessionRow): StatuslineBroadcast {
  return {
    latest_model: row.latest_model,
    latest_model_display: row.latest_model_display,
    latest_ctx_pct: row.latest_ctx_pct,
    latest_ctx_window_size: row.latest_ctx_window_size,
    latest_limits_json: row.latest_limits_json,
    latest_cost_usd: row.latest_cost_usd,
    latest_version: row.latest_version,
    latest_permission_mode: row.latest_permission_mode,
    latest_statusline_at: row.latest_statusline_at,
  };
}
