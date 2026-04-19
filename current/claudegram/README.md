# claudegram

A localhost PWA that surfaces your Claude Code fakechat conversations in a
mobile-friendly web UI, with live context-window + rate-limit bars, session
management, and bidirectional relay.

- Bun + TypeScript backend, SQLite persistence, WebSocket live updates
- Vanilla ES-module frontend (no framework, no build step), installable PWA
- Fakechat plugin fork sends messages over a reverse WebSocket

**Current state (2026-04-19, pre-P3 hotfix 2):** channel-gated session
registration, lazy fakechat connect, heartbeat-driven stale-connection cleanup,
bulk "Clear offline" in the UI, and info-level statusline logging for easy
diagnosis. See `docs/archive/PROGRESS-PRE-P3-HOTFIX2-2026-04-19.md` for the
change history.

---

## Setup (first time)

```bash
# 1. Install Bun >= 1.1.0
brew install oven-sh/bun/bun

# 2. Install deps
cd current/claudegram && bun install

# 3. Symlink the fakechat fork into ~/.claude/plugins/
ln -sfn "$(pwd)/../fakechat" \
  ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat
```

### Enable the fakechat plugin
In `~/.claude/settings.json`:
```json
{
  "enabledPlugins": { "fakechat@claude-plugins-official": true }
}
```

### Wire fakechat → claudegram + statusline → claudegram
Also in `~/.claude/settings.json` (under `"env"`):
```json
{
  "env": {
    "CLAUDEGRAM_URL": "http://localhost:8788",
    "CLAUDEGRAM_STATUSLINE_URL": "http://localhost:8788/internal/statusline"
  }
}
```

- `CLAUDEGRAM_URL` — fakechat dials `$CLAUDEGRAM_URL/session-socket` on first
  interaction to register the session.
- `CLAUDEGRAM_STATUSLINE_URL` — the bundled `~/.claude/statusline-command.sh`
  fire-and-forgets the raw statusline JSON here so ctx / 5h / 7d bars can
  render in the compose area.

If you don't already have `~/.claude/statusline-command.sh`, grab the one
shipped with this repo (it handles both Claude Code's own CLI statusline
and the claudegram bridge in one script).

---

## Running it

Two terminals:

```bash
# Terminal 1 — claudegram server
cd current/claudegram && bun run dev
# → server_ready { port: 8788 }
```

```bash
# Terminal 2 — Claude Code with fakechat channel
claude --channels plugin:fakechat@claude-plugins-official
```

Then open **http://localhost:8788/** in a browser (and/or install as PWA).

The fakechat web UI also runs per-Claude-Code-session at
`http://localhost:878X` (port picked from 8787..8797; the exact port is
printed to stderr when fakechat boots — look for `fakechat: http://…`).

---

## How sessions appear (important)

> **Claudegram does NOT show a session until the fakechat plugin actually does
> something.** Starting `claude --channels plugin:fakechat@claude-plugins-official`
> is necessary but not sufficient.

The fakechat MCP subprocess boots with Claude Code but connects to claudegram
*lazily*. It dials `/session-socket` and sends the `register` frame on the
first of these events:

1. A user sends a message via the fakechat web UI (`deliver()` path), OR
2. Claude Code calls fakechat's `reply` tool (assistant response path).

**Before any interaction:** the session isn't registered, so it won't appear
in claudegram's session list. This is intentional — it prevents ghost
sessions from Claude Code instances that have fakechat in `.mcp.json` but
weren't launched with `--channels`.

**To make a session appear:** open its fakechat UI (URL printed to stderr
when Claude Code starts), type anything and hit send. The session pops into
claudegram's list immediately.

---

## Troubleshooting

### New Claude Code is running but no session shows up
You haven't interacted yet. See "How sessions appear" above. Open the
fakechat UI for that Claude Code instance and send a message.

### Old sessions showing `connected: false` that I don't want
Click **Clear offline** in the sidebar header — bulk-deletes every session
that's not currently live. Drops their messages too.

### Two sessions cycling online/offline every 60 seconds
An older Claude Code instance is still running with a pre-hotfix fakechat
that has no pong handler. The heartbeat closes them every 60s
(20s ping × 3 firings = 60s > 45s timeout) and they reconnect forever.
Fix: close that Claude Code window and start a new one — the new fakechat
subprocess will have the current code.

### No ctx-window / rate-limit bars
Check the `bun run dev` output:

- **No `statusline_*` entries at all** → Claude Code's statusline hook isn't
  POSTing. Verify `CLAUDEGRAM_STATUSLINE_URL` is set in the shell that
  launches `claude` (see Setup). Make sure `~/.claude/statusline-command.sh`
  has the POST block (grep it for `CLAUDEGRAM_STATUSLINE_URL`).
- **`statusline_no_cwd_match` entries** → POSTs are arriving but fakechat
  hasn't registered that cwd yet. Send one message in the fakechat UI to
  trigger the lazy register, then the next statusline tick will match.
- **`statusline_routed` entries** → happy path. If bars still don't show,
  force-reload the PWA (service worker cache — Shift+Reload in Chrome) and
  make sure the right session is selected in the sidebar.

### Sidebar won't open on mobile
Fixed in hotfix 1. If you still see it broken, hard-refresh the PWA to pick
up the latest service worker (the cache version bumps per release).

---

## P1 Features

| Feature | Details |
|---|---|
| **PWA** | Vanilla ES-module SPA served at `/`; sidebar session list + live message pane; installable (manifest + service worker) |
| **WebSocket** | Live event stream at `/user-socket` — pushes `message` and `session_update` events as new messages arrive |
| **REST API** | `GET /api/sessions`, `GET /api/messages`, `GET /api/me` |
| **Ingest** | `POST /ingest` persists messages and broadcasts to all connected WS clients |

---

## Running the bridge locally

These steps wire claudegram to a real Claude session via the fakechat plugin.

1. **Install the fakechat fork** — replace the upstream plugin directory with a symlink to this repo's `current/fakechat/`:
   ```bash
   # Backup and replace the upstream plugin
   ln -sfn /path/to/claudegram/current/fakechat \
     ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat
   ```
   Enable it in `~/.claude/settings.json` under `"enabledPlugins"`:
   ```json
   { "enabledPlugins": ["claude-plugins-official:fakechat"] }
   ```

2. **Set the bridge URL** in the shell that runs `claude`:
   ```bash
   export CLAUDEGRAM_URL=http://localhost:8788
   ```

3. **Start claudegram**:
   ```bash
   cd current/claudegram && bun run dev
   ```
   The server logs `server_ready { port: 8788 }` to stderr when ready.
   (Use `bun run dev`, not `bun run src/server.ts` — the former sets the correct working directory for static assets.)

4. **Start Claude** with the fakechat channel:
   ```bash
   claude --channels plugin:fakechat@claude-plugins-official
   ```
   Without `--channels`, fakechat does not spawn and no messages will flow through claudegram.

Open `http://localhost:8788/` in a browser to see the PWA.

---

## Live statusline in the compose row (optional)

claudegram can surface Claude Code's live statusline (model name, context-window %, 5h and 7d rate-limit %) directly under the message input of the currently selected session. No polling, no parsing `claude /status` — we reuse the same stdin JSON Claude Code already pipes into your configured statusline script.

**How the bridge works:**

- fakechat registers its `process.cwd()` on `/session-socket`. Claudegram keeps an in-memory `cwd → session_id` map.
- `~/.claude/statusline-command.sh` fire-and-forget POSTs the raw stdin JSON to `$CLAUDEGRAM_STATUSLINE_URL` after emitting its normal stdout (used for Claude Code's own statusline — nothing there changes).
- Claudegram's `POST /internal/statusline` (loopback-only) extracts `model`, `context_window.used_percentage`, and `rate_limits.{five_hour,seven_day}.used_percentage`, looks up the session by `cwd`, and broadcasts a `statusline` frame to connected PWAs.

**Setup (one-time):**

1. Make sure `~/.claude/statusline-command.sh` contains the POST block (already appended by this repo — check the top of the script for `CLAUDEGRAM_STATUSLINE_URL`). If you have a custom script, add:
   ```sh
   if [ -n "$CLAUDEGRAM_STATUSLINE_URL" ]; then
     (printf '%s' "$input" | curl -s --max-time 0.5 \
        -H 'Content-Type: application/json' --data-binary @- \
        "$CLAUDEGRAM_STATUSLINE_URL" >/dev/null 2>&1 &) 2>/dev/null
   fi
   ```

2. Export the endpoint URL in the shell that launches `claude`:
   ```bash
   export CLAUDEGRAM_STATUSLINE_URL=http://127.0.0.1:8788/internal/statusline
   ```

3. Start claudegram + Claude as usual (see "Running the bridge locally" above).

**What you'll see:** once fakechat is connected and Claude Code has fired the statusline at least once, the compose row of the active session shows `model · ctx░░░░░░░░░░N% · 5h░░…N% · 7d░░…N%` with colour-coded bars (green < 70%, amber < 90%, red ≥ 90%). The layout wraps onto two rows on narrow mobile viewports.

**Multi-session:** each claudegram session tracks its own snapshot, keyed by the cwd of the fakechat process that registered it. Switch sessions in the sidebar and the bars update.

**Edge cases:**
- Two `claude` processes in the same cwd → last POST wins (rare; not special-cased).
- Fakechat running without `cwd` in its register frame → that session's bars stay hidden. Upgrade fakechat.
- Unset `CLAUDEGRAM_STATUSLINE_URL` → feature is fully inert; Claude Code's own statusline is unaffected.

---

## Message UI niceties

- **Markdown in Claude replies.** Assistant messages are piped through a small safe renderer (`web/js/markdown.js`) that handles fenced code blocks, inline code, bold/italic, ordered/unordered lists, ATX headings, and links. User messages are still shown as plain escaped text — we only format what Claude emits, not what you type. Link URLs are restricted to `http(s)://`, `mailto:`, and same-origin paths; `javascript:` / `data:` schemes are dropped.
- **"Claude is thinking" indicator.** After you hit send, a three-dot typing bubble appears at the tail of the transcript until the next assistant message arrives for that session. State is ephemeral (lives in the tab) — a page refresh clears it, and delivery failures (error frame, no-fakechat) drop the bubble immediately.
- **Assistant label.** Messages from Claude Code are now labelled `Claude` in the bubble meta row.

---

## Unread count now clears across refreshes

Previously the PWA cleared unread counts locally on session select but never notified the server, so a page refresh re-hydrated the old count from the DB. The frontend now sends a `mark_read` WS frame on session selection (and on incoming assistant messages for the active session), advancing `last_read_at` server-side. Refreshing the page now shows the same cleared state.

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

> **P2 note**: `session_update` frames now also carry `unread_count` (added in P2). See the P2 outbound-frames table below for the full shape.

Client-to-server messages are **ignored** in P1 — the socket is receive-only.

---

## P2 WebSocket protocol

P2 adds bidirectional relay: a separate `/session-socket` endpoint for fakechat (reverse dial), and inbound frames on `/user-socket` for PWA→fakechat communication.

### `/session-socket` — fakechat reverse WebSocket

fakechat dials claudegram as a WebSocket client; claudegram is the server. The connection carries forwarded PWA replies to the fakechat process.

**Auth gate** (pre-upgrade): when `TRUST_CF_ACCESS=true`, the upgrade request must include both `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers (non-empty). Missing or empty → HTTP 401 before upgrade. Shape check only; cryptographic verification happens at the Cloudflare Access edge in P4.

**Inbound frame** (fakechat → claudegram, after connect):
```json
{ "type": "register", "session_id": "...", "session_name": "...(optional)" }
```
Registers the fakechat process as the handler for `session_id`. A second `register` frame for the same `session_id` evicts the prior connection (normal on restart).

**Outbound frames** (claudegram → fakechat):
```json
{ "type": "reply", "text": "...", "client_msg_id": "...", "origin": "pwa" }
```
Forwarded when a PWA sends a `reply` frame on `/user-socket`. The `origin:'pwa'` tag lets fakechat skip the echo re-post to `/ingest` (see dedup below).

**Error frames** (claudegram → fakechat):
```json
{ "type": "error", "reason": "invalid_payload" | "internal_error" }
```

---

### `/user-socket` — inbound frames (PWA → claudegram)

In addition to the P1 receive-only stream, the PWA now sends frames to claudegram:

**`reply` frame** — relay a PWA message to fakechat:
```json
{ "type": "reply", "session_id": "...", "text": "...", "client_msg_id": "...", "reply_to": "...(optional)" }
```
- `client_msg_id`: correlation ID echoed in the error frame on failure; required.
- On success: forwarded to fakechat with `origin:'pwa'`; no ack sent back.
- On failure: error frame sent back to the PWA.

**`mark_read` frame** — advance the session read pointer:
```json
{ "type": "mark_read", "session_id": "...", "up_to_message_id": "..." }
```
- Advances `last_read_at` monotonically (SQL: `MAX(COALESCE(last_read_at,0), message.ts)`).
- Triggers a `{type:'session_update'}` broadcast to all connected PWAs.

**Inbound bad-frame policy**: an error frame is sent on each malformed frame; after N consecutive bad frames (default 5, configurable via `WS_INBOUND_MAX_BAD_FRAMES`), the socket is closed with code 1003.

---

### `/user-socket` — outbound frames (claudegram → PWA)

| Frame type | Shape | When sent |
|---|---|---|
| `message` | `{ type, session_id, message: { id, direction, ts, content, session_id, ingested_at } }` | After successful POST /ingest |
| `session_update` | `{ type, session: { id, name, status, last_read_at, unread_count, first_seen_at, last_seen_at } }` | After POST /ingest or mark_read |
| `error` | `{ type:"error", reason, session_id?, client_msg_id?, up_to_message_id? }` | On relay or mark_read failure |

**Error reasons**: `session_not_connected` (no fakechat registered), `send_failed` (socket write failed or buffer full), `unknown_message` (mark_read target not found), `invalid_payload` (bad frame), `internal_error` (DB error).

---

### Origin-tag echo dedup

When the PWA sends a `reply` frame, claudegram forwards it to fakechat tagged with `origin:'pwa'`. fakechat's `claudegram-client` checks this tag and skips the `/ingest` POST — preventing the message from being re-broadcast as a new `{type:'message'}` event. Without the tag, fakechat would echo every PWA reply back as a duplicate broadcast.

---

## P2 Env vars

| Variable | Default | Description |
|---|---|---|
| `TRUST_CF_ACCESS` | `false` | When `true`, `/session-socket` upgrades require `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers. Also gates `/api/me` email read. |
| `WS_OUTBOUND_BUFFER_CAP_BYTES` | `1048576` (1 MB) | Max `bufferedAmount` before outbound frames are dropped with a `send_failed` / `buffer_full` result. |
| `WS_INBOUND_MAX_BAD_FRAMES` | `5` | Consecutive malformed frames before the user-socket is closed with code 1003. |
| `MAX_PWA_CONNECTIONS` | `256` | Maximum concurrent `/user-socket` connections. Requests past cap get HTTP 503 pre-upgrade. |
| `MAX_SESSION_CONNECTIONS` | `64` | Maximum concurrent `/session-socket` registrations. Requests past cap get HTTP 503 pre-upgrade; `register` frames past cap get an `internal_error` close. |

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

Integration tests boot a real in-process server on an ephemeral port (port 0) and exercise the full request path — no mocks:

- `src/integration.test.ts` — P1 WebSocket broadcast: `/ingest` → WS fan-out, `ingested_at` timestamp, multi-client fan-out.
- `src/integration-api.test.ts` — P1 REST API: `/api/sessions`, `/api/messages`, `/api/me`, `/health`.
- `src/integration-p2-relay.test.ts` — P2 relay E2E: PWA reply → fakechat forward (2.6a), `mark_read` unread_count drop (2.6b), echo-dedup proof that claudegram does not broadcast unfound `/ingest` (2.6c), `session_not_connected` error frame.

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
