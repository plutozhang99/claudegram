# claudegram v1 — Design Spec & Build Request

**Status**: pre-implementation. Goal of this doc: hand a fresh Claude Code session everything it needs to execute P0 without re-litigating the design discussion.

---

## 1. Why we're doing this

### 1.1 The user problem

When running Claude Code on a Mac, the user wants to **read and reply to sessions from any device** (phone, laptop at a cafe, another room). Public-bot plugins (Telegram / Discord / iMessage bridges) solve the transport but trade away control:

- The bot platform sees every message plaintext.
- A leaked bot token is full impersonation.
- Rate limits, ban policies, and infra availability are outside user control.
- Claude Code's default posture correctly restricts outbound messaging; we need an alternative that's **safe by construction**, not "safe because we trust $VENDOR".

### 1.2 Why fakechat alone isn't enough

[fakechat](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat) is an official plugin that solves one piece: a localhost web UI speaking the Claude Code channel contract via MCP stdio. But:

- No history — tab reload wipes state.
- No auth — anyone with localhost access can read/send.
- No notification — you have to keep the tab open and watch.
- No multi-session — single tab, single session.
- No remote access — it's pure localhost.

### 1.3 Why v0 claudegram (in `legacy/`) isn't what we want either

v0 claudegram is **permission-prompt-focused** (approve/deny file edits, bash, MCP tool calls from Telegram). It has the right **architectural instinct** — daemon singleton + per-session channel server — but:

- Frontend is Telegram → same trust problem as above.
- Scope is permission prompts only, not general message bridging.
- Multi-session lifecycle is correct but the whole thing is tied to Telegram API.

v0 stays archived as reference for the daemon/registry/TTL patterns. v1 keeps the architectural split, replaces the frontend and auth.

---

## 2. Mental model: two components, two lifecycles

This is the **core insight** that drove v1's design.

| | fakechat | claudegram |
|---|---|---|
| **Scope** | Per-session chat channel | Aggregator + UI + auth |
| **Lifetime** | Lives and dies with a Claude Code session | Long-lived server (launchd now, can migrate to NAS/VPS later) |
| **Process** | Spawned by Claude Code as MCP stdio child | Standalone daemon with PID lock |
| **Storage** | None (stateless) | SQLite (messages, sessions, push subscriptions) |
| **Auth** | None (localhost-only, or webhook secret to claudegram) | CF Access in front of all HTTP + WebSocket |
| **Network posture** | Outbound-only (webhook + WebSocket dial-out to claudegram) | Inbound (listens on port, exposed via cloudflared) |
| **Location** | Always on the dev machine | Can be anywhere — localhost, home server, VPS |

**Key consequence**: fakechat never needs an inbound port. It dials WebSocket **out** to claudegram. This means the Mac can be fully behind NAT / corporate firewall / anywhere — only claudegram needs to be reachable.

---

## 3. Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Mac (Claude Code developer machine)                        │
│                                                              │
│  [Claude session A] ─stdio─> [fakechat A] ─┐                │
│  [Claude session B] ─stdio─> [fakechat B] ─┤                │
│  [Claude session C] ─stdio─> [fakechat C] ─┘                │
│                                            │                │
│                    HTTP webhook (inbound msgs to claudegram)│
│                    + reverse WebSocket (claudegram → fakechat)
│                                            │                │
└────────────────────────────────────────────┼────────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────┐
│  claudegram server (local launchd → NAS/VPS later)          │
│                                                              │
│  HTTP API  (POST /ingest, POST /shutdown, etc)              │
│  WebSocket (fakechat-facing)                                │
│  WebSocket (PWA-facing)                                     │
│  SQLite    (messages, sessions, subscribers, push subs)     │
│  Web Push  (VAPID) — later phase                            │
│                                                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                  cloudflared tunnel
                         │
                 Cloudflare Access (SSO + email allowlist)
                         │
                         ▼
                  [PWA on any device]
```

---

## 4. Key design decisions (locked in)

### 4.1 Protocol: fakechat ↔ claudegram

| Direction | Protocol | Reason |
|---|---|---|
| fakechat → claudegram (new msg from Claude) | **HTTP POST** to `/ingest` | Simple, stateless, works over any transport |
| claudegram → fakechat (user reply from PWA) | **WebSocket** dialed from fakechat to claudegram | fakechat stays NAT-friendly; no inbound port |

fakechat dials the reverse WebSocket on startup, re-dials on disconnect with exponential backoff, and registers its `session_id` + human name on connect.

### 4.2 Auth: two layers

| Path | Auth |
|---|---|
| PWA ↔ claudegram | **Cloudflare Access** (Google/GitHub SSO + email allowlist at the edge) |
| fakechat ↔ claudegram | **CF Access Service Token** (`CF-Access-Client-Id` + `CF-Access-Client-Secret` headers) |

Both paths terminate at CF Access, so claudegram application code has **zero auth logic** — it trusts the `Cf-Access-Authenticated-User-Email` header (for humans) and the service token identity (for fakechat). No user/password, no JWT, no sessions in claudegram.

This also means "whitelist management" = editing the CF Access policy in the Cloudflare dashboard. No admin UI needed in MVP.

Why not Supabase: Supabase realtime/RLS is great but for this threat model adds a second auth surface to secure. CF Access is sufficient and terminates at the edge. Defer Supabase unless we need its specific features (multi-tenant, RLS).

### 4.3 Storage: SQLite now, abstract for later

- Use `bun:sqlite` (zero-dependency, built-in to Bun).
- Put a `MessageRepo` / `SessionRepo` / `SubscriberRepo` **interface** in front of storage from day one.
- `SqliteMessageRepo` is the only implementation for now.
- Do **not** write Postgres code prematurely. Swap later if/when public multi-tenant deployment happens.

### 4.4 Push strategy

- MVP: **WebSocket + browser `Notification` API** (PWA stays open / installed as PWA).
- Later (P5): **Web Push (VAPID)** for when the PWA process is fully killed.
- The boundary we accept for MVP: if the user force-quits the PWA app on phone OS, they may miss messages until they re-open it. Documented, not hidden.

### 4.5 What fakechat adds (minimal)

fakechat in this repo is a **fork** of the official plugin, extended with:

- Optional `CLAUDEGRAM_URL` + `CLAUDEGRAM_SERVICE_TOKEN_ID` + `CLAUDEGRAM_SERVICE_TOKEN_SECRET` env vars.
- If set: every incoming message (from Claude Code `reply` tool) is **also** POSTed to `${CLAUDEGRAM_URL}/ingest` and fakechat dials a reverse WebSocket to `${CLAUDEGRAM_URL}/session-socket`.
- If unset: fakechat behaves identically to upstream (pure localhost).

No other changes. Keep fakechat small and forkable from upstream easily.

### 4.6 What claudegram is

A new Bun project in `current/claudegram/` with:

- HTTP server (serves PWA static, `/ingest`, `/shutdown`, `/health`).
- Two WebSocket endpoints: `/session-socket` (fakechat-facing) and `/user-socket` (PWA-facing).
- SQLite schema: `messages`, `sessions`, `push_subscriptions` (later).
- PWA: vanilla HTML/JS + service worker + manifest. No framework for MVP.
- CLI (`bun run current/claudegram/cli.ts`): `start | stop | status | logs | install | uninstall` wrapping launchd.
- launchd plist template.
- cloudflared config documentation + example.

---

## 5. What about "the bridge getting killed"?

Honest boundary analysis (the user asked for this explicitly):

| Scenario | Messages lost? | Recovery |
|---|---|---|
| Claude Code session ends | ❌ No (claudegram has the history) | New session registers, fakechat reconnects reverse WS |
| claudegram crashes | ⚠️ Messages in-flight during crash may drop | launchd restarts within seconds; fakechat retries webhook; PWA WebSocket auto-reconnects |
| Mac goes to sleep | ❌ No | On wake, fakechat re-dials; claudegram re-subscribes |
| Mac shuts down | ✅ Yes (Claude Code session also dies; no msg is "in flight") | Manual `claudegram start` on boot |
| cloudflared crashes | ❌ No | launchd restarts; PWA reconnects |
| PWA killed by phone OS | ⚠️ Misses notifications for that window | Fixed by P5 Web Push |
| claudegram machine offline (NAS off, VPS down) | ✅ fakechat webhooks fail, queue client-side until retry succeeds | Retry with exponential backoff; bounded queue in fakechat |

**"Mac off" and "claudegram machine off" are hard limits.** No local-only system can deliver messages when the sending or receiving machine is off. This is the price of not trusting a public bot backend.

### How to stop the bridge cleanly

- `bun run current/claudegram/cli.ts stop` → SIGTERM, graceful shutdown, unloads launchd.
- PWA admin button (authenticated via CF Access) → `POST /shutdown` → same graceful path.
- Fully uninstall: `cli.ts uninstall` removes launchd plist.

---

## 6. Future deployment path (why we design this way)

1. **Stage 1 (MVP)**: claudegram runs on the same Mac as Claude Code, launchd-managed, cloudflared tunnel.
2. **Stage 2**: claudegram migrates to NAS / Raspberry Pi / VPS. Mac keeps fakechat, points `CLAUDEGRAM_URL` to the tunnel hostname. Nothing else changes.
3. **Stage 3 (optional)**: claudegram adds multi-user registration, per-user message isolation via RLS-like filtering. Becomes a self-host SaaS. Requires Postgres (swap the repo impl) and a real auth layer (swap CF Access for OAuth or layer on top).

The **HTTP + WebSocket + repo abstraction + CF Access service token** choices are all in service of making stage 2 a config change, not a rewrite.

---

## 7. Roadmap (P0 → P6)

**P0 — claudegram skeleton + SQLite + fakechat webhook** (MVP foundation)
- `current/claudegram/`: HTTP server, SQLite schema, repo interfaces + SQLite impl, `/ingest` endpoint, `/health`, basic logging.
- `current/fakechat/`: add optional `CLAUDEGRAM_URL` webhook POST on every outgoing message.
- Deliverable: Claude Code → fakechat → claudegram → SQLite. Verify with a DB query.

**P1 — PWA skeleton + WebSocket live push** — see section 12 for frontend strategy.
- `current/claudegram/web/`: `index.html`, `manifest.json`, `sw.js`, `app.js`, `style.css`, `icons/`. Installable PWA.
- `/user-socket` WebSocket: streams new messages to connected PWAs.
- `GET /api/sessions` — list sessions (id, name, last_seen_at, unread_count).
- `GET /api/messages?session_id=...&before=...&limit=...` — history pagination.
- PWA lists sessions in sidebar, shows message history per session, live-appends new messages.
- Deliverable: Open PWA, see history, receive live messages.

**P2 — fakechat reverse WebSocket + user replies**
- fakechat dials `${CLAUDEGRAM_URL}/session-socket`, registers session, listens for user replies.
- claudegram routes PWA replies via in-memory session→socket map.
- Deliverable: Reply from PWA lands in the correct Claude Code session.

**P3 — Notifications**
- Browser `Notification` API on message arrival (tab backgrounded).
- Title bar unread counter.
- Per-session mute toggle.
- Deliverable: PWA notifies even when backgrounded.

**P4 — cloudflared + CF Access deployment**
- `current/claudegram/deploy/cloudflared.yml.example` + step-by-step README.
- CF Access: configure Google SSO + email allowlist + service token for fakechat.
- `cli.ts install` sets up launchd for both claudegram and cloudflared.
- Deliverable: Open PWA from phone (4G), SSO, see live messages.

**P5 — Web Push (VAPID)** — optional, do if PWA-killed case is actually hitting
- Service worker Web Push handler.
- VAPID key generation in `cli.ts install`.
- `push_subscriptions` table + `POST /subscribe` endpoint.
- Fallback: WebSocket first (500ms), then Push if no ACK.

**P6 — Permission prompts** — optional, if we decide to subsume v0's use case
- Channel capability `claude/channel/permission` in fakechat.
- Inline action-button messages in PWA (Yes / Yes-all / No).
- Session-scoped allowlist for `yes_all`.
- Replaces v0 claudegram entirely.

---

## 8. What the next session should build (P0 concrete scope)

Entry point for the fresh `start-project` session:

### 8.1 New files to create

```
current/claudegram/
  package.json              # Bun, @types/node, nothing else heavy
  tsconfig.json
  src/
    server.ts               # entry point
    http.ts                 # Bun.serve setup
    routes/
      ingest.ts             # POST /ingest (from fakechat)
      health.ts             # GET /health
    db/
      schema.sql            # CREATE TABLE messages, sessions
      migrate.ts            # runs schema.sql on boot
    repo/
      types.ts              # Message, Session, MessageRepo, SessionRepo interfaces
      sqlite.ts             # SqliteMessageRepo, SqliteSessionRepo
    config.ts               # env var loading, Zod schema
  README.md                 # how to run (bun run src/server.ts)
```

### 8.2 Fakechat edits

In `current/fakechat/server.ts`, add:

- Read env vars `CLAUDEGRAM_URL`, `CLAUDEGRAM_SERVICE_TOKEN_ID`, `CLAUDEGRAM_SERVICE_TOKEN_SECRET` (all optional).
- In the `reply` tool handler and `deliver()` (user→assistant direction), if `CLAUDEGRAM_URL` set, `fetch()` POST to `${CLAUDEGRAM_URL}/ingest` with the message payload. Fire-and-forget, log errors to stderr, do not block the reply.
- Include a stable `session_id` (derive from `process.env.CLAUDE_SESSION_ID` if available, else a ULID generated at startup stored in `STATE_DIR/session_id`).

### 8.3 Ingest payload schema (wire format)

```typescript
// POST /ingest
{
  session_id: string        // ULID or Claude Code-provided
  session_name?: string     // human-readable, from fakechat plugin instance name
  direction: 'assistant' | 'user'  // who sent it
  message_id: string        // fakechat's local msg id
  text: string
  reply_to?: string
  file?: { name: string, path: string }  // absolute path on sender's machine
  ts: number                // epoch millis
}
```

claudegram inserts into `messages`, upserts `sessions` (last_seen_at).

### 8.4 SQLite schema (P0)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,           -- session_id
  name TEXT NOT NULL,            -- human name
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'ended'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,           -- fakechat-local message_id; UNIQUE globally by (session_id, id)
  session_id TEXT NOT NULL REFERENCES sessions(id),
  direction TEXT NOT NULL,       -- 'assistant' | 'user'
  text TEXT NOT NULL,
  reply_to TEXT,
  file_name TEXT,
  file_path TEXT,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts DESC);
```

### 8.5 Verification for P0 done

1. `bun run current/claudegram/src/server.ts` starts HTTP server on `CLAUDEGRAM_PORT` (default 8788).
2. With `CLAUDEGRAM_URL=http://localhost:8788` set, running fakechat via Claude Code and issuing `reply` causes a row to appear in the SQLite DB.
3. `curl http://localhost:8788/health` returns `{ ok: true }`.
4. Session rows created on first ingest; `last_seen_at` updated on subsequent messages.
5. Zod validates `/ingest` payload; 400 on malformed.
6. No CF Access wiring yet — P0 is plain HTTP on localhost. CF Access comes in P4.

### 8.6 Out of scope for P0 (do not build yet)

- Reverse WebSocket (P2)
- PWA (P1)
- Notifications (P3)
- cloudflared/CF Access (P4)
- launchd/CLI (P4)
- Web Push (P5)
- Permission prompts (P6)

---

## 9. Build conventions (per user's global rules)

Per `~/.claude/rules/`:

- **TypeScript strict**, explicit types on public APIs.
- **Zod at boundaries** — `/ingest` validated with a Zod schema, type inferred from it.
- **Immutability** — spread for updates, `Readonly<>` on function params.
- **No `any`** — use `unknown` + narrowing.
- **Small files** — 200–400 lines typical.
- **TDD** — write tests first for repo + ingest handler.
- **80%+ coverage** on repo layer and ingest handler minimum.
- **No console.log** — use a simple logger (stderr with timestamp).
- **No hardcoded secrets** — all config via env + Zod schema.
- **Commit format**: `feat: ...`, `fix: ...`, `chore: ...`, etc. Attribution disabled globally.

Suggested agents to invoke:
- `planner` at session start to flesh out P0 implementation plan.
- `tdd-guide` before writing ingest handler + repo.
- `code-reviewer` after P0 diff is complete.
- `security-reviewer` before the first commit that adds `/ingest` (untrusted input boundary).

---

## 10. Open questions to resolve during P0

(None are blockers — flag and proceed with the default.)

1. **`session_id` source of truth**: Claude Code does set `CLAUDE_SESSION_ID`? If yes, use it. If no, generate ULID on fakechat startup and persist to `~/.claude/channels/fakechat/session_id`. Default: try env first, fall back to generated.
2. **Ingest idempotency**: Two fakechat webhooks for the same `message_id` should no-op, not double-insert. Use `INSERT OR IGNORE` keyed on `(session_id, id)`.
3. **Back-pressure**: If claudegram is down, fakechat's webhook POST will fail. For P0, log and drop (no client-side queue). P2+ adds a small bounded retry queue when adding reverse WebSocket.

---

## 11. Handoff note to the next session

You are picking this up in a fresh Claude Code session via `start-project`. The work:

- Everything in sections **8.1 – 8.5** is P0.
- Section **8.6** is explicitly out of scope — don't scope-creep.
- Section **12** (frontend strategy) is the spec for P1 — don't start it in P0, but read it so P0's HTTP routing anticipates it (serve `web/` as static, reserve `/api/*` paths).
- Read `legacy/daemon/src/` for inspiration on Bun HTTP patterns + PID lock (section 4.3 of `legacy/README.md`) but **don't import legacy code**; it's archived.
- Read `current/fakechat/server.ts` to understand the existing plugin shape before extending it. The `HTML` constant at the bottom (lines 212–295) is what you'll crib visual idioms from in P1.
- Start with `planner` agent. Hand it this whole file. Then `tdd-guide` for the repo + ingest handler.

Section 5 (the "bridge killed" matrix) is important for setting user expectations in the P0 README — surface those trade-offs honestly.

---

## 12. Frontend strategy (P1)

### 12.1 Reuse vs rewrite: honest assessment

`current/fakechat/server.ts` embeds an ~80-line HTML string (lines 212–295) — a single-tab, single-session chat UI. Evaluating what's reusable for claudegram's PWA:

| fakechat frontend asset | Reuse for claudegram? |
|---|---|
| Message bubble format (`[HH:MM:SS] who: text`) | ✅ Copy the CSS + markup verbatim |
| Attachment chip + download link rendering | ✅ Copy verbatim |
| textarea + attach button + send compose box | ✅ Copy layout and styling |
| WebSocket `onmessage` → `add(m)` append pattern | ✅ Borrow the pattern |
| Single-tab, single-session design | ❌ Rewrite — claudegram aggregates N sessions |
| `msgs` object as sole message store (in-memory) | ❌ Replace with "paginate from `/api/messages` + live-append from WebSocket" |
| HTML as a string literal inside `server.ts` | ❌ Split into real static files (manifest.json + sw.js must be served at their own paths) |
| No Notification API, no service worker, not installable | ❌ All new |

**Verdict**: borrow fakechat's visual language (~150 lines of CSS + single-message rendering helper) but write the PWA shell from scratch. Attempting to evolve fakechat's HTML in-place is a rewrite hiding behind a diff.

### 12.2 Directory layout (P1)

```
current/claudegram/web/
├── index.html        # PWA shell: sidebar (sessions) + messages pane + compose
├── manifest.json     # name, icons, start_url, display: standalone
├── sw.js             # service worker — MVP: offline shell cache; P5: add Push handler
├── app.js            # main logic (~300–500 lines vanilla JS)
├── style.css         # bubble/chip/compose styling ported from fakechat
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

Served directly by claudegram's HTTP server (same origin as `/api/*` and WebSocket). CF Access terminates at the edge, so every request — static asset, API, WebSocket — is already authenticated by the time it hits claudegram.

### 12.3 Framework: none (for MVP)

Vanilla JS until ~500 lines becomes unmaintainable. If P3 (notifications, unread counters, mute toggles, session routing) pushes complexity over the threshold, reach for **Preact** or **Svelte** via ESM import (no build step). **Do not** introduce React + Next.js — the runtime cost, hydration model, and build complexity are wrong for a personal PWA serving one user.

Keep `app.js` structured by concern:
- `ws.js` — WebSocket connect/reconnect with exponential backoff, event emitter.
- `store.js` — in-memory session + message cache, hydrated from `/api/sessions` + `/api/messages`.
- `render.js` — DOM updates (session list, message list, compose).
- `notify.js` — Notification API wrapper, permission flow, per-session mute state in localStorage.
- `index.js` — boot + wiring.

Even without a bundler, splitting into ES modules (`<script type="module" src="/web/index.js">`) keeps the files small and testable.

### 12.4 PWA essentials

- **`manifest.json`**: `"display": "standalone"`, `"start_url": "/"`, 192 + 512 icons. Without this, iOS Safari won't treat it as installable and Web Push (P5) is blocked.
- **`sw.js` (MVP)**: only caches the app shell (`/`, `/index.html`, `/app.js`, `/style.css`, `/manifest.json`). No API caching — message data must be live. Use `workbox`-less hand-written fetch handler (~30 lines). Versioned cache name so shell updates invalidate cleanly.
- **Installability**: test on iOS Safari (Add to Home Screen) and Android Chrome (install prompt). iOS 16.4+ supports Web Push only after install.

### 12.5 UI shape (P1 target)

```
┌──────────────┬────────────────────────────────────────────┐
│ Sessions     │ #api-refactor  (active · last 2m ago)      │
│              │ ─────────────────────────────────────────── │
│ ● api-       │ [09:12:04] bot: working on migration…      │
│   refactor   │ [09:12:34] you: skip the v2 table          │
│   (2 unread) │ [09:15:01] bot: done. tests pass.          │
│              │                                            │
│ ○ test-suite │                                            │
│   (5m)       │                                            │
│              │                                            │
│ ○ docs-pass  │                                            │
│   (1h)       │                                            │
│              │                                            │
│              │ ┌─────────────────────────────────┐ [attach]│
│              │ │ reply…                          │ [send]  │
│              │ └─────────────────────────────────┘         │
└──────────────┴────────────────────────────────────────────┘
```

Mobile: sidebar collapses to a hamburger / session picker. Desktop: persistent sidebar. CSS Grid + a `@media (max-width: 640px)` breakpoint handles both without a framework.

### 12.6 HTTP + WebSocket contract for the frontend (P1 wire format)

```typescript
// GET /api/sessions
// → { sessions: Array<{ id: string; name: string; last_seen_at: number; unread_count: number; status: 'active' | 'ended' }> }

// GET /api/messages?session_id=SID&before=MID&limit=50
// → { messages: Message[]; has_more: boolean }

// GET /api/me
// → { email: string }   // read from Cf-Access-Authenticated-User-Email header; for local dev, a stub value

// WebSocket /user-socket
// Server → Client events:
//   { type: 'message'; session_id: string; message: Message }
//   { type: 'session_update'; session: Session }
// Client → Server (P2+):
//   { type: 'reply'; session_id: string; text: string; reply_to?: string }
//   { type: 'mark_read'; session_id: string; up_to_message_id: string }
```

Zod schemas for both directions. P0 only needs to anticipate these routes exist (reserve `/api/*` path prefix, reserve `/web/*` for static); the P1 session builds them.

### 12.7 What's NOT in P1

- Per-session mute (P3)
- Rich file previews / image inlining in-feed (P3)
- Web Push / offline message sync (P5)
- Permission-prompt action buttons (P6)
- Admin UI for CF Access allowlist (never — use CF dashboard)
