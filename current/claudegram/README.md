# claudegram

P1: Full-stack PWA — HTTP ingest + SQLite store + WebSocket live updates + installable PWA UI (vanilla ES modules, no framework, no build step). Localhost only. No auth in P1.

**Verified 2026-04-19:** full smoke test run against a live daemon (curl + WebSocket client + real browser). All routes, WS broadcasts, static assets, path-traversal guards, and extension allowlist behave as specced.

---

## P1 Features

| Feature | Details |
|---|---|
| **PWA** | Vanilla ES-module SPA served at `/`; sidebar session list + live message pane; installable (manifest + service worker) |
| **WebSocket** | Live event stream at `/user-socket` — pushes `message` and `session_update` events as new messages arrive |
| **REST API** | `GET /api/sessions`, `GET /api/messages`, `GET /api/me` |
| **Ingest** | `POST /ingest` persists messages and broadcasts to all connected WS clients |

---

## Quick start

1. Install [Bun](https://bun.sh) >= 1.1.0.
2. Install dependencies:
   ```bash
   cd current/claudegram && bun install
   ```
3. Start the server:
   ```bash
   bun run src/main.ts
   ```
   Default port: **8788**. The server logs `server_ready { port: 8788 }` to stderr when ready.
4. Verify:
   ```bash
   curl http://localhost:8788/health
   # {"ok":true}
   ```

---

## Running the PWA

Open `http://localhost:8788/` in a browser after starting the server.

**What works in P1:**
- Session list (left panel) — live-updating as new messages arrive
- Message history per session with infinite scroll / pagination
- Live message feed via WebSocket — new messages appear without refresh

**Deferred to P2:**
- Sending replies from the browser (P2 bidirectional relay)
- Notifications / Web Push (P5)
- Cloudflare Access auth (P4)

---

## WebSocket contract

Connect to `ws://localhost:8788/user-socket`. The server pushes JSON text frames for each broadcast event.

Reference: `docs/request_v1.md §12.6` (full event spec).

| Event `type` | Shape | When sent |
|---|---|---|
| `message` | `{ type, session_id, message: { id, direction, ts, content, session_id, ingested_at } }` | After every successful POST /ingest |
| `session_update` | `{ type, session: { id, name, status, last_read_at, first_seen_at, last_seen_at } }` | After every successful POST /ingest (reflects latest session state) |

Client-to-server messages are **ignored** in P1 — the socket is receive-only.

---

## Env vars

| Variable | Default | Description |
|---|---|---|
| `CLAUDEGRAM_PORT` | `8788` | HTTP listen port (1–65535) |
| `CLAUDEGRAM_DB_PATH` | `./data/claudegram.db` | SQLite file path. Directory is auto-created; `..` segments are rejected. |
| `CLAUDEGRAM_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error` |
| `TRUST_CF_ACCESS` | `false` | Set `true` only when running behind Cloudflare Access (P4+). When true, `/api/me` reads the `Cf-Access-Authenticated-User-Email` header instead of returning `local@dev`. |

---

## HTTP API

| Method | Path | Status codes | Notes |
|---|---|---|---|
| `GET` | `/health` | 200 / 503 | `SELECT 1` health probe; 503 if SQLite unreachable |
| `POST` | `/ingest` | 200 / 400 / 413 / 500 | 1 MiB body cap, streaming enforced; broadcasts to WS clients |
| `GET` | `/api/sessions` | 200 / 500 | List all sessions ordered by `last_seen_at` DESC; includes `unread_count` |
| `GET` | `/api/messages` | 200 / 400 / 500 | `?session_id=X[&before=<msg_id>][&limit=N]`; paginated, newest-first |
| `GET` | `/api/me` | 200 / 405 | Returns `{ ok, email }` — `local@dev` unless TRUST_CF_ACCESS is set |
| `WS` | `/user-socket` | — | WebSocket live event stream (see WebSocket contract above) |
| `GET` | `/` | 200 | React PWA entry point |

---

## `/ingest` contract

### Request body (JSON)

```json
{
  "session_id": "...",
  "session_name": "...(optional)",
  "message": {
    "id": "...",
    "direction": "user",
    "ts": 1234567890000,
    "content": "..."
  }
}
```

`direction` is `"user"` or `"assistant"`. `ts` is epoch milliseconds. `session_name` defaults to `session_id` when omitted.

### Response shapes

| Status | Body |
|---|---|
| 200 | `{"ok":true,"message_id":"..."}` |
| 400 | `{"ok":false,"error":"invalid json"}` or `{"ok":false,"error":"invalid payload","issues":[...]}` |
| 413 | `{"ok":false,"error":"payload too large"}` |
| 500 | `{"ok":false,"error":"internal error"}` |

---

## Architecture — "bridge killed" trade-off matrix

Key decisions and accepted trade-offs. Source: spec §5.

| Feature | Stance | Rationale |
|---|---|---|
| Webhook retry queue | Not implemented; fire-and-forget with structured stderr log | P2 concern. Adds complexity; P1 is localhost + trusted client. |
| Auth (CF Access) | Not in server in P1; `TRUST_CF_ACCESS=false` default | CF Access wired in P4. `local@dev` fallback for local use. |
| Schema versioning | Skipped; `IF NOT EXISTS` silently hides column drift | Known gap; P2 concern. |
| Partial-ingest rollback | No transaction around session upsert + message insert | Orphan session possible on insert failure; documented as known gap. |
| Integration test isolation | In-process `createServer` factory + port 0 (not subprocess) | Subprocess variant is flaky in CI; run manually. |
| JSON depth-bomb hardening | `JSON.parse` is unhardened | Acceptable for localhost + trusted client. |
| Messages lost when claudegram crashes | In-flight messages during crash may drop | launchd restarts within seconds; fakechat retries webhook. |
| Messages lost when claudegram machine is offline | fakechat webhooks fail and drop | P2 adds bounded retry queue in fakechat. |
| WS reply path | Server ignores client→server frames in P1 | P2 will add bidirectional relay. |

---

## P1 scope boundary

In scope:
- HTTP ingest endpoint (`POST /ingest`) with WS broadcast
- SQLite persistence (sessions + messages)
- REST API (`/api/sessions`, `/api/messages`, `/api/me`)
- WebSocket live event stream at `/user-socket`
- React PWA at `/` (session list + message history + live updates)
- fakechat fork: optional `CLAUDEGRAM_URL` webhook, stable `session_id`, multi-session via `CLAUDE_SESSION_ID`

Out of scope (deferred):
- Sending replies from the browser (P2 bidirectional relay)
- Auth via CF Access (P4)
- Webhook retry queue (P2)
- Schema migrations beyond idempotent `CREATE IF NOT EXISTS` (P2)
- cloudflared tunnel / launchd CLI (P4)
- Web Push / VAPID (P5)

---

## Known gaps (P2 follow-ups)

- `schema_version` table — column drift is silently hidden by `IF NOT EXISTS`
- Partial-ingest transaction — session upsert and message insert are not atomic; orphan session possible
- Webhook retry queue — messages drop if claudegram is unreachable when fakechat POSTs
- `JSON.parse` depth limit — no protection against depth-bomb payloads (acceptable at P1 scope)
- Subprocess-based SIGTERM integration test — currently `.skip` due to CI flakiness; run manually
- WS reply path — client→server frames are silently ignored; P2 will add bidirectional relay

---

## Tests

```bash
bun test              # run all tests (unit + integration)
bun test --watch      # re-run on file changes
bunx tsc --noEmit     # TypeScript type check (must exit 0)
bun test --coverage   # coverage report
```

Integration tests (`src/integration.test.ts`, `src/integration-api.test.ts`) boot a real in-process server on an ephemeral port (port 0) and exercise the full request path — no mocks.

---

## Generate icons

```bash
bun run generate-icons
```

Generates all PWA icon sizes from the source SVG into `web/icons/`.

---

## Local development

---

## Observability

Logs are JSONL written to **stderr**. Every line includes `level`, `msg`, `time` (ISO-8601 UTC), plus arbitrary fields.

Named error events to watch:
- `ingest_failed` — repo error during session upsert or message insert (includes `session_id`, `message_id`, `err`)
- `shutdown_error` — error during graceful shutdown

---

## Manual multi-session verification (spec §8.5 pt 6 equivalent)

To confirm that two fakechat processes with distinct sessions both land in claudegram with correct attribution:

1. Start claudegram:
   ```bash
   cd current/claudegram && bun run src/main.ts
   # Observes: server_ready { port: 8788 }
   ```

2. In two separate terminals, start two fakechat instances:
   ```bash
   # Terminal A
   cd current/fakechat && CLAUDE_SESSION_ID=alice CLAUDEGRAM_URL=http://localhost:8788 bun server.ts

   # Terminal B
   cd current/fakechat && CLAUDE_SESSION_ID=bob CLAUDEGRAM_URL=http://localhost:8788 bun server.ts
   ```

   (Note: fakechat auto-picks port 8788/8789 because claudegram is on 8788.)

3. Open each fakechat UI in a separate browser tab (URLs printed to stderr on startup).

4. Type a message in each. Verify claudegram log shows two ingest events with distinct `session_id`s.

5. Inspect the SQLite DB:
   ```bash
   sqlite3 current/claudegram/data/claudegram.db "SELECT id, name FROM sessions;"
   sqlite3 current/claudegram/data/claudegram.db "SELECT session_id, id, direction, content FROM messages ORDER BY ts;"
   ```

   Expected: two session rows (`alice`, `bob`); each message correctly attributed to its session.
