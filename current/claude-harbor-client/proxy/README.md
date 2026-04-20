# claude-harbor-proxy (P0.2)

Stdio MCP channel proxy. Spawned by Claude Code as a channel plugin; speaks
MCP over stdio to CC and a WebSocket to the harbor server.

## Responsibilities

- MCP handshake over stdio: `initialize`, `notifications/initialized`,
  `tools/list`, `tools/call` (single `reply` tool).
- Opens WS to `${HARBOR_URL}/channel`; first frame is
  `{parent_pid, cwd, ts}`. Waits for `{type:"bound", session_id, channel_token}`
  ack.
- Forwards inbound pushes (`{type:"push", content, meta?}` or the
  legacy admin-push shape) to CC as `notifications/claude/channel`.
- Outbound: CC `reply` tool call -> POST `${HARBOR_URL}/channel/reply`
  with `{channel_token, content, meta?}`.

## Why a separate package

Keeps the proxy dependency-free relative to the server and independently
deployable as a single-file binary. Both packages share no code — the
correlation contract is just a WS frame schema.

## Run

```bash
bun install
HARBOR_URL=http://localhost:7823 bun run src/index.ts
```

## Test

```bash
bun test
```

## Env

| Var | Default | Purpose |
|---|---|---|
| `HARBOR_URL` | `http://localhost:7823` | Harbor server base URL (http → ws) |

## Notes

- stdout is reserved for MCP frames; logs go to stderr as JSON lines.
- WS reconnect: 3 attempts with 500ms / 1s / 2s backoff, then exits 1.
- `reply` tool schema follows CHANNELS-REFERENCE §3: `{chat_id, text}`.
