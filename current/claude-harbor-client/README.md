# claude-harbor-client

Local-side pieces of claude-harbor. Install these on every machine where you
run Claude Code. They talk to a central
[`claude-harbor-server`](../claude-harbor-server/) over HTTP + WebSocket.

---

## Packages

| Package | Binary | Role |
|---|---|---|
| [`wrapper/`](./wrapper/) | `claude-harbor` | Launcher. Finds `claude`, prepends `--channels plugin:claude-harbor@local`, execs it. |
| [`proxy/`](./proxy/) | `claude-harbor-ch` | Stdio MCP channel plugin. Spawned by CC; maintains the WS to the server. |
| [`hook/`](./hook/) | `claude-harbor-hook` | Registered by the installer as CC hook command. Forwards stdin JSON to `${HARBOR_URL}/hooks/<event>`. |
| [`statusline/`](./statusline/) | `claude-harbor-statusline` | Registered as CC statusline command. Forwards stdin to `${HARBOR_URL}/statusline`, prints the returned line. |
| [`installer/`](./installer/) | `claude-harbor-install` | Writes / removes the `~/.claude/settings.json` entries. |

All packages are independent; none import from each other. The contract
between them is the HTTP + WS protocol exposed by the server.

---

## Prerequisites

- [Bun](https://bun.sh) 1.3+ on PATH.
- A running [`claude-harbor-server`](../claude-harbor-server/) reachable
  from this machine. Note its base URL — you'll set it as `HARBOR_URL`.
- Claude Code already installed (`claude --version` should work).

---

## Install

### 1. Install dependencies for each package

```bash
for pkg in wrapper proxy hook statusline installer; do
  (cd "$pkg" && bun install)
done
```

### 2. Link the CLIs onto PATH

```bash
for pkg in wrapper hook statusline installer; do
  (cd "$pkg" && bun link)
done

for pkg in claude-harbor claude-harbor-hook claude-harbor-statusline claude-harbor-install; do
  bun link "$pkg"
done
```

Confirm:

```bash
claude-harbor --version
claude-harbor-install --help
```

If `command not found`, add Bun's global bin dir to PATH:

```bash
export PATH="$(bun pm -g bin):$PATH"
```

### 3. Export `HARBOR_URL`

The hook, statusline, and channel proxy all read `HARBOR_URL` at runtime.
Put it in your shell profile so every CC invocation inherits it:

```bash
# ~/.zshrc or ~/.bashrc
export HARBOR_URL=http://<server-host>:7823
```

### 4. Write CC settings entries

```bash
claude-harbor-install install --harbor-url http://<server-host>:7823
```

This is **idempotent** — safe to re-run. It writes to
`~/.claude/settings.json`:

- 7 hook entries (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  Stop, SessionEnd, Notification) pointing at `claude-harbor-hook`
- A `statusLine` entry pointing at `claude-harbor-statusline`
- `allowedChannelPlugins: [{marketplace:"local", plugin:"claude-harbor"}]`
- `channelsEnabled: true`

A sidecar (`~/.claude/claude-harbor-installed.json`) records exactly what
was added so uninstall is precise. The first install against an existing
non-empty `settings.json` makes a timestamped backup
(`settings.json.bak-<ISO>-<rand>`).

Preview without writing:

```bash
claude-harbor-install install --harbor-url http://<server-host>:7823 --dry-run
```

---

## Usage

Launch CC through the wrapper:

```bash
claude-harbor start                  # → exec claude --channels plugin:claude-harbor@local
claude-harbor start --model opus     # args forward verbatim
claude-harbor start -c               # continue last session
```

The wrapper:

- Discovers `claude` via `CLAUDE_BIN` (must be absolute + executable) or
  PATH.
- Prepends `--channels plugin:claude-harbor@local` unless you already pass
  your own `--channels` or set `HARBOR_NO_CHANNEL=1`.
- Inherits stdio, forwards SIGINT/SIGTERM/SIGHUP, propagates the child's
  exit code.
- Logs only to stderr. `claude`'s stdout is left untouched.

Everything else behaves like plain `claude`.

---

## Uninstall

```bash
claude-harbor-install uninstall
```

Removes only the entries the sidecar records as ours — anything you've
added or modified is left alone (with a stderr warning).

Unlink the CLIs:

```bash
for pkg in claude-harbor claude-harbor-hook claude-harbor-statusline claude-harbor-install; do
  bun unlink "$pkg" || true
done
```

---

## Environment

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `HARBOR_URL` | hook, statusline, proxy, installer | `http://localhost:7823` | Server base URL. `http://` or `https://` only. |
| `CLAUDE_BIN` | wrapper | *(unset)* | Absolute path to `claude`. Overrides PATH lookup. |
| `HARBOR_CHANNEL_SPEC` | wrapper | `plugin:claude-harbor@local` | Overrides the `--channels` spec the wrapper injects. |
| `HARBOR_NO_CHANNEL=1` | wrapper | — | Skip injecting `--channels` (debugging only). |

---

## Tests

```bash
for pkg in wrapper proxy hook statusline installer; do
  echo "=== $pkg ==="
  (cd "$pkg" && bun test && bunx tsc --noEmit)
done
```

Current count: 21 + 30 + 20 + 18 + 25 = **114 tests** across the client
packages.

---

## Troubleshooting

**`claude-harbor: command not found`** — Bun's global bin isn't on PATH.
`export PATH="$(bun pm -g bin):$PATH"`.

**Hooks don't reach the server** — confirm `HARBOR_URL` is exported in the
shell that launched `claude-harbor start` (CC inherits the wrapper's env).
Hit `curl $HARBOR_URL/health` to sanity-check reachability.

**Statusline says `claude-harbor: offline`** — the 500 ms timeout was
missed, or the server returned non-200. Check server logs; try
`curl -X POST -H 'Content-Type: application/json' -d '{}' $HARBOR_URL/statusline`.

**Channel shows "unbound" in the frontend** — the WS handshake didn't
correlate within `HARBOR_CORR_WINDOW_MS`. Firewall between this machine
and the server? Clock skew? Did you launch via `claude-harbor` (not raw
`claude`)?

**Uninstall refuses** — sidecar missing / malformed, or `settings.json`
malformed. Fix by hand, re-run.

---

## Known limitations

- No auth / TLS between this machine and the server (P0 scope). Keep
  traffic on a trusted network or terminate TLS at a reverse proxy in front
  of the server.
- Local-filesystem channel-plugin discovery is the main open integration
  item — see `../../docs/plans/PLAN-claude-harbor.md` §11. The installer
  writes the schema `CHANNELS-REFERENCE.md` documents; adjust if CC rejects
  it on your version.
