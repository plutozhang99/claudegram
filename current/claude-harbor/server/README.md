# claude-harbor server (P0.1)

Minimal Bun + TypeScript remote server: HTTP hooks + statusline + WS channel + SQLite.

## Requirements

- Bun 1.3+

## Run

```bash
bun install
bun run src/index.ts          # start (port from HARBOR_PORT, default 7823)
bun run --watch src/index.ts  # dev with auto-reload
```

## Test

```bash
bun test
```

## Env

| Var | Default | Purpose |
|---|---|---|
| `HARBOR_PORT` | `7823` | HTTP + WS port |
| `HARBOR_DB_PATH` | `./data/harbor.db` | SQLite file |
| `HARBOR_CORR_WINDOW_MS` | `10000` | WS handshake / pending-correlation window |
| `HARBOR_ADMIN_TOKEN` | *(unset)* | Shared secret for `/admin/*` routes. See "Admin auth" below. |

## Endpoints

- `POST /hooks/session-start` — `{session_id, cwd, pid, transcript_path, ts}` -> `{channel_token}`. Body capped at 64 KiB.
- `POST /statusline` — full CC statusline JSON -> `{line, matched}`. Body capped at 64 KiB.
- `POST /admin/push-message` — `{session_id, content, meta?}` -> sends channel notification over bound WS. Admin-gated.
- `GET  /admin/session/:id` — debug view of the persisted session row. Admin-gated.
- `WS /channel` — first frame `{parent_pid, cwd, ts}`; correlates to pending session by `cwd+pid` within the correlation window. Handshake frames capped at 4 KiB.

## Admin auth

P0 is internal-net only; there is no global auth on `/hooks/*` or `/statusline`.
The two `/admin/*` routes are gated as follows:

- When `HARBOR_ADMIN_TOKEN` is set, callers MUST send header
  `X-Harbor-Admin-Token: <token>`. Constant-time compared.
  Missing / wrong → `401`.
- When `HARBOR_ADMIN_TOKEN` is unset, admin routes are loopback-only:
  only requests from `127.0.0.1` / `::1` are served; anything else → `403`.

For any real deployment, set `HARBOR_ADMIN_TOKEN` to a random high-entropy
value.
