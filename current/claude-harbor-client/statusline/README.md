# claude-harbor-statusline (P0.4)

Binary that Claude Code invokes to render its terminal status bar. Reads
stdin (the CC statusline JSON), POSTs it to `${HARBOR_URL}/statusline`,
and echoes the server-returned `line` string to stdout.

## Contract

- Reads stdin (128 KiB cap), validates it parses as JSON, POSTs to
  `${HARBOR_URL}/statusline` with a **500 ms** timeout.
- Prints the server's `line` to stdout (one trailing newline).
- On any failure — network, timeout, bad JSON, non-200 — prints
  `claude-harbor: offline` to stdout. Never errors out of the CC UI.
- Always exits 0.
- stderr receives one-line diagnostic on failures; stdin is never
  echoed back.

Registered via the installer under `settings.json > statusLine`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-harbor-statusline"
  }
}
```

## Env

| Var | Default | Purpose |
|---|---|---|
| `HARBOR_URL` | `http://localhost:7823` | Harbor server base URL. |

## Test

```bash
bun install
bun test
bunx tsc --noEmit
```
