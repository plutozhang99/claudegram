# claude-harbor (P0.3)

Thin CLI wrapper around `claude`. Discovers the real `claude` binary, injects
the harbor channel plugin flag, and exec's it with the user's args forwarded
verbatim. All wrapper diagnostics go to stderr; stdout belongs to `claude`.

## What it does

- `claude-harbor start [...args]` — resolves `claude` via `CLAUDE_BIN` (must be
  absolute + executable) or PATH, then spawns `claude` with
  `--channels plugin:claude-harbor@local` **prepended before any user-supplied
  args**, inherited stdio, and propagated exit code. If the user already
  passes their own `--channels <spec>` (or `--channels=<spec>`) in `[...args]`,
  or sets `HARBOR_NO_CHANNEL=1`, the wrapper does **not** inject a second
  `--channels` — user args always win. SIGINT/SIGTERM/SIGHUP are forwarded to
  the child.
- `claude-harbor --version` / `-v` — prints the version, exit 0.
- `claude-harbor --help` / `-h` / no args — prints short usage, exit 0.
- Unknown command — stderr error, exit 2.
- `claude` not found — exit 127 with install hint on stderr.
- `HARBOR_CHANNEL_SPEC` that does not match `plugin:<name>@<marketplace>` —
  exit 2 with a validation error on stderr. The accepted grammar restricts
  name / marketplace to ASCII alphanumerics plus `.`, `_`, `-`.

### Trust model for `CLAUDE_BIN`

The wrapper canonicalizes `CLAUDE_BIN` via `fs.realpathSync` to harden against
simple TOCTOU swaps between our existence check and `Bun.spawn`. This only
helps if the resolved binary's **parent directory is not world-writable**; if
an attacker can swap files in that directory, no CLI-level check can help.
Treat `CLAUDE_BIN` like `PATH` — only point it at directories you control.

## Run / test

```bash
bun install
bun run src/index.ts --help
bun test
bunx tsc --noEmit
```

## Env vars

| Var | Purpose |
|---|---|
| `CLAUDE_BIN` | Absolute path to the `claude` executable (overrides PATH). |
| `HARBOR_URL` | Forwarded to `claude-harbor-ch` proxy (this wrapper does not read it). |
| `HARBOR_CHANNEL_SPEC` | Override the default `plugin:claude-harbor@local`. |
| `HARBOR_NO_CHANNEL=1` | Skip injecting `--channels` (debugging only). |

## Example

```bash
HARBOR_URL=http://localhost:7823 claude-harbor start --model opus
```

## Note on plugin wiring

Per `docs/CHANNELS-REFERENCE.md` §1, `--channels plugin:<name>@<marketplace>`
must be passed at runtime or notifications are silently dropped. The wrapper
injects it on every launch. Registering the plugin in `~/.claude/settings.json`
(`allowedChannelPlugins`) is **P0.4's install-script job** — this wrapper
never touches `~/.claude/` at runtime.
