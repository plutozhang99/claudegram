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
| `CLAUDEGRAM_URL` | _(empty)_ | When set, inbound messages are POSTed to `${CLAUDEGRAM_URL}/ingest` as fire-and-forget (Phase 4.3a — not yet implemented). Unset = no webhook. |
| `CLAUDEGRAM_SERVICE_TOKEN_ID` | _(empty)_ | Cloudflare Access client ID. When set alongside `CLAUDEGRAM_SERVICE_TOKEN_SECRET`, outbound requests include `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. |
| `CLAUDEGRAM_SERVICE_TOKEN_SECRET` | _(empty)_ | Cloudflare Access client secret (see above). |
| `CLAUDE_SESSION_ID` | `pid-<PID>` | Scopes the state directory to a specific session — allows multiple parallel fakechat instances without colliding. If unset, falls back to `pid-<PID>`. |

State is written to `~/.claude/channels/fakechat/<SESSION_SCOPE>/` where `SESSION_SCOPE`
is `CLAUDE_SESSION_ID` (if set) or `pid-<PID>`.

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
