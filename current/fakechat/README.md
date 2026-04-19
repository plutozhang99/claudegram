# fakechat

Simple UI for testing the channel contract without an
external service. Open a browser, type, messages go to your Claude Code
session, replies come back.


## Setup

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install fakechat@claude-plugins-official
```

**Relaunch with the channel flag** — the server won't connect without this. Exit your session and start a new one:

```sh
claude --channels plugin:fakechat@claude-plugins-official
```

The server prints the URL to stderr on startup:

```
fakechat: http://localhost:8787
```

Open it. Type. The assistant replies in-thread.

Set `FAKECHAT_PORT` to change the port. If unset, fakechat auto-picks the first free port
in 8787..8797. If set explicitly, no fallback is attempted.

## Claudegram integration (optional)

All variables below are optional. When none are set, fakechat behaves identically to the
upstream/standalone version — no webhook calls, no extra headers.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FAKECHAT_PORT` | _(empty)_ | If unset, auto-picks the first free port in 8787..8797. If set explicitly, uses that port (no fallback). |
| `CLAUDEGRAM_URL` | _(empty)_ | When set, enables full claudegram integration: reverse WebSocket + `/ingest` POSTs. Unset = no claudegram connection, identical to standalone mode. |
| `CLAUDEGRAM_SERVICE_TOKEN_ID` | _(empty)_ | Cloudflare Access client ID. When set alongside `CLAUDEGRAM_SERVICE_TOKEN_SECRET`, outbound requests include `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. |
| `CLAUDEGRAM_SERVICE_TOKEN_SECRET` | _(empty)_ | Cloudflare Access client secret (see above). |
| `CLAUDEGRAM_OUTBOUND_QUEUE_CAP` | `100` | Max messages held in the bounded retry queue while claudegram is unreachable. Oldest entry is dropped when the cap is reached. |
| `CLAUDE_SESSION_ID` | `pid-<PID>` | Scopes the state directory to a specific session — allows multiple parallel fakechat instances without colliding. If unset, falls back to `pid-<PID>`. |

State is written to `~/.claude/channels/fakechat/<SESSION_SCOPE>/` where `SESSION_SCOPE`
is `CLAUDE_SESSION_ID` (if set) or `pid-<PID>`.

### Reverse-WS lifecycle

When `CLAUDEGRAM_URL` is set, fakechat dials `ws[s]://<CLAUDEGRAM_URL>/session-socket` on startup and sends a `register` frame:

```json
{ "type": "register", "session_id": "...", "session_name": "..." }
```

On disconnect, fakechat reconnects with exponential backoff (250 ms base, 8 s cap, ±20% jitter). Reconnect resets the attempt counter on a successful open.

When claudegram forwards a PWA reply, fakechat receives:

```json
{ "type": "reply", "text": "...", "client_msg_id": "...", "origin": "pwa" }
```

### Retry queue semantics

Messages POSTed to `/ingest` that fail with a network error, HTTP 429, or HTTP 5xx are placed in a bounded FIFO queue (default cap: 100). When the cap is reached, the oldest entry is dropped and a single `warn` log is emitted per overflow burst (suppressed on subsequent drops until the queue drains below cap). On the next successful POST, fakechat drains the queue in order; a drain failure stops the drain (item stays at the front). HTTP 4xx responses (except 429) bypass the queue — the server rejected the payload and a retry would not help.

### Echo-dedup contract

When fakechat receives an inbound `reply` frame with `origin:'pwa'`, it does **not** POST that message back to `/ingest`. This prevents the PWA reply from appearing as a duplicate `{type:'message'}` broadcast to all connected PWAs. claudegram adds `origin:'pwa'` to every forwarded reply for exactly this purpose.

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send to the UI. Takes `text`, optionally `reply_to` (message ID) and `files` (absolute path, 50MB). Attachment shows as `[filename]` under the text. |
| `edit_message` | Edit a previously-sent message in place. |

Inbound images/files save to `~/.claude/channels/fakechat/<SESSION_SCOPE>/inbox/` and the path
is included in the notification. Outbound files are copied to `<SESSION_SCOPE>/outbox/` and
served over HTTP.

## Not a real channel

There's no history, no search, no access.json, no skill. Single browser tab,
fresh on every reload. This is a dev tool, not a messaging bridge.
