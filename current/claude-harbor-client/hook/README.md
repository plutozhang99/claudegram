# claude-harbor-hook (P0.4)

Tiny binary that Claude Code spawns for each registered hook event. Reads
stdin (the hook payload JSON), and POSTs it to the harbor server at
`${HARBOR_URL}/hooks/<kebab-case-event>`.

## Invocation

Wired up by the installer in `~/.claude/settings.json` as:

```json
{ "type": "command", "command": "claude-harbor-hook SessionStart" }
```

One binary, routed by `argv[0]`.

## Contract

- Reads all of stdin (1 MiB cap). Validates it parses as JSON.
- POSTs raw body to `${HARBOR_URL}/hooks/<event-path>` with a 2 s timeout.
- **Always exits 0.** CC must never see a hook failure.
- All diagnostics go to stderr; stdout is left empty.

## Env

| Var | Default | Purpose |
|---|---|---|
| `HARBOR_URL` | `http://localhost:7823` | Harbor server base URL. Trailing `/` tolerated. |

## Event mapping

| CC hook event (PascalCase) | Server path |
|---|---|
| `SessionStart` | `POST /hooks/session-start` |
| `UserPromptSubmit` | `POST /hooks/user-prompt-submit` |
| `PreToolUse` | `POST /hooks/pre-tool-use` |
| `PostToolUse` | `POST /hooks/post-tool-use` |
| `Stop` | `POST /hooks/stop` |
| `SessionEnd` | `POST /hooks/session-end` |
| `Notification` | `POST /hooks/notification` |

## Test

```bash
bun install
bun test
bunx tsc --noEmit
```
