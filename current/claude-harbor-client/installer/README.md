# claude-harbor-install (P0.4)

Idempotent installer for the `~/.claude/settings.json` entries that claude-harbor
needs: hooks (7 CC events), `statusLine`, and the `allowedChannelPlugins`
entry for `plugin:claude-harbor@local`.

## Usage

```bash
# Install (idempotent — safe to re-run).
claude-harbor-install install

# Preview what would change, don't touch files.
claude-harbor-install install --dry-run

# Custom harbor server URL, custom $CLAUDE_HOME.
claude-harbor-install install --harbor-url http://10.0.0.5:7823 --home /tmp/fake-claude

# Reverse what install did.
claude-harbor-install uninstall
```

## What it writes

`~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-harbor-hook SessionStart" }] }
    ],
    "UserPromptSubmit": [ /* same shape with UserPromptSubmit */ ],
    "PreToolUse":       [ /* ... */ ],
    "PostToolUse":      [ /* ... */ ],
    "Stop":             [ /* ... */ ],
    "SessionEnd":       [ /* ... */ ],
    "Notification":     [ /* ... */ ]
  },
  "statusLine": { "type": "command", "command": "claude-harbor-statusline" },
  "allowedChannelPlugins": [{ "marketplace": "local", "plugin": "claude-harbor" }],
  "channelsEnabled": true
}
```

`~/.claude/claude-harbor-installed.json` — sidecar that records exactly
what was added. `uninstall` reads this sidecar to remove only our
entries; anything the user added is preserved.

A backup copy of the pre-install `settings.json` is created once as
`settings.json.bak-<ISO>` the first time install runs against a
non-empty file with no prior sidecar.

## Safety

- **Atomic writes**: temp file + `rename(2)` in the same directory.
- **Backup**: only created once, on first install against an existing,
  non-empty file. Re-installs do not pile up backups.
- **Sidecar**: precise record of installed entries (with matcher +
  command string). Uninstall only removes entries whose value still
  matches what we wrote — if you've modified one of our entries in the
  interim, uninstall leaves it alone and warns.
- **Malformed settings.json** is detected and refused (exit 1); we
  never overwrite a broken config.
- **User statusLine conflict**: if you already have a different
  `statusLine` in settings.json, we leave it alone and warn. You can
  delete it manually or wait until install can replace it safely.

## Test

```bash
bun install
bun test
bunx tsc --noEmit
```

## Hook + statusLine schema source

Per Claude Code docs
(<https://code.claude.com/docs/en/hooks> and
<https://code.claude.com/docs/en/statusline>):

- `hooks.<EventName>[*].matcher` — empty string / `"*"` / omitted = match all.
- `hooks.<EventName>[*].hooks[*].type` — only `"command"` is supported here.
- `statusLine.type` — `"command"`; `statusLine.command` — shell command.

Per `docs/CHANNELS-REFERENCE.md` §8:

- `allowedChannelPlugins` — array of `{marketplace, plugin}` entries;
  replaces the default allowlist when set.
- `channelsEnabled: true` — required on Team/Enterprise plans; safe on
  personal plans too.
