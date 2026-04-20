# claude-harbor-server

Remote aggregator for live Claude Code sessions. One process, HTTP + WebSocket
+ SQLite. Runs on any box reachable from the machines where CC runs — a home
server, a small VPS, or a Docker host.

Paired client: [`../claude-harbor-client/`](../claude-harbor-client/).

---

## What it does

| Surface | Purpose |
|---|---|
| `POST /hooks/<event>` | Persists CC hook payloads (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd, Notification). `/hooks/session-start` also mints a `channel_token`. |
| `POST /statusline` | Persists the latest CC statusline snapshot per session; echoes a formatted line. |
| `POST /channel/reply` | Records outbound messages from CC to the user (emitted via CC's `reply` tool). |
| `WS /channel` | Two-way channel to the CC-side MCP proxy. First frame is the correlation handshake (`{parent_pid, cwd, ts}`); subsequent frames deliver inbound pushes. |
| `POST /admin/push-message` | Injects a message into a live session over WS. Admin-gated. |
| `GET  /admin/session/:id` | Debug view of a session row. Admin-gated. |
| `GET  /health` | Liveness probe. |

All session state lives in SQLite (`sessions`, `messages`, `tool_events`,
`push_subscriptions`). See [`src/schema.ts`](./src/schema.ts).

---

## Requirements

- [Bun](https://bun.sh) 1.3+ (for local dev), **or** Docker 24+ for
  containerised deployment.

---

## Run (local / Bun)

```bash
bun install
HARBOR_ADMIN_TOKEN=$(openssl rand -hex 32) bun run start
```

The server listens on `:7823` by default. With no `HARBOR_ADMIN_TOKEN` set,
the admin routes (`/admin/*`) are restricted to loopback (`127.0.0.1`,
`::1`).

Dev mode with auto-reload:

```bash
bun run dev
```

Tests + typecheck:

```bash
bun test
bunx tsc --noEmit
```

---

## Run (Docker)

```bash
# 1. Create .env with a token.
echo "HARBOR_ADMIN_TOKEN=$(openssl rand -hex 32)" > .env

# 2. Build + start.
docker compose up -d

# 3. Check.
docker compose logs -f harbor
curl http://localhost:7823/health
```

- SQLite persists in the `harbor-data` named volume.
- Override the host port by setting `HARBOR_HOST_PORT` in `.env` (default
  `7823`).
- The image runs as unprivileged user `harbor:harbor` and ships a
  `HEALTHCHECK` that hits `/health` every 30 s.

Rebuild after code changes:

```bash
docker compose build --no-cache harbor && docker compose up -d
```

Stop + remove (keeps the data volume):

```bash
docker compose down
```

Nuke everything, including the DB:

```bash
docker compose down -v
```

---

## Environment

| Var | Default | Purpose |
|---|---|---|
| `HARBOR_PORT` | `7823` | HTTP + WS listen port. |
| `HARBOR_DB_PATH` | `./data/harbor.db` (Bun) / `/app/data/harbor.db` (Docker) | SQLite file. |
| `HARBOR_ADMIN_TOKEN` | *(unset)* | Shared secret for `/admin/*`. Required for any non-loopback admin caller. |
| `HARBOR_CORR_WINDOW_MS` | `10000` | WS handshake + pending-session correlation window. |

---

## Admin auth

- **`HARBOR_ADMIN_TOKEN` set** — callers MUST send header
  `X-Harbor-Admin-Token: <token>`. Constant-time compared. Missing /
  mismatch → `401`.
- **`HARBOR_ADMIN_TOKEN` unset** — admin routes are loopback-only;
  anything else → `403`. Intended for local development.

For any deployment beyond a single home LAN, set `HARBOR_ADMIN_TOKEN` to a
high-entropy value and terminate TLS at a reverse proxy (nginx, Caddy,
Traefik). P0 does not ship its own TLS or authn layer.

---

## Data & backups

SQLite is a single file. Back it up with `sqlite3 harbor.db ".backup
/path/to/snapshot.db"` or a filesystem-level copy while the server is
stopped. If you're running Docker, the volume lives under
`/var/lib/docker/volumes/claude-harbor-server_harbor-data/` on the host
(or inspect via `docker volume inspect claude-harbor-server_harbor-data`).

---

## Architecture notes

- **Correlation model.** SessionStart hooks and channel WS connections are
  two independent streams from CC. The server matches them by
  `(cwd + parent_pid)` within `HARBOR_CORR_WINDOW_MS`. If the channel
  socket never appears, the session stays "unbound" (read-only in the
  frontend). See [`src/correlate.ts`](./src/correlate.ts).
- **Body / frame caps.** HTTP request bodies are capped at 64 KiB; WS
  frames at 4 KiB. Outbound reply `content` + `meta` further capped to
  protect the SQLite row size.
- **Stateless HTTP, stateful WS.** All durable state is in SQLite; the
  only in-memory structures are the pending-session queue and the
  `channel_token → WebSocket` map.

---

## Tests

29 tests across 3 files — `bun test` to run. Covers session-start, the full
statusline field pipeline, `/channel/reply`, WS correlation happy-path +
timeout, admin auth modes, and body-size caps.

---

## Known P0 limits

- No built-in TLS.
- No global auth on `/hooks/*` or `/statusline`. Put the server on a
  trusted network or front it with TLS + IP allowlist.
- Single-user model. Multi-user / multi-project is P5.
