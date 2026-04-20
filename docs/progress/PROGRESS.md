## Project: claude-harbor

## Spec Files
- `docs/plans/PLAN-claude-harbor.md` — full architecture + phase plan
- `docs/CHANNELS-REFERENCE.md` — CC channel/hook/statusline research (2026-04-19)
- `docs/DESIGN.md` — Mistral-inspired warm amber/orange palette (frontend must follow)

## Plan File
- `docs/plans/PLAN-claude-harbor.md`

## Project Structure
```
/ (repo root; will be renamed to claude-harbor after session reopen)
├── current/
│   └── claude-harbor/        ← new code goes here (empty skeleton)
├── legacy/
│   ├── <pre-existing V0 dirs: bot, daemon, channel-server, shared, …>
│   └── V1-claudegram-2026-04-19/   ← archived former claudegram + fakechat
├── docs/
│   ├── DESIGN.md             (Mistral warm palette — untouched)
│   ├── CHANNELS-REFERENCE.md (2026-04-19 CC surface research)
│   ├── plans/PLAN-claude-harbor.md
│   ├── progress/PROGRESS.md  (this file)
│   └── archive/
```

Tech stack: Bun + TypeScript (remote + local binaries), Flutter 3.x (frontend), SQLite, Web Push, FCM (later).

## DESIGN.md
YES — `docs/DESIGN.md`. All UI changes must follow the Mistral warm palette (ivory/cream/amber/orange, Arial-like type at weight 400, near-zero border-radius, golden multi-layer shadows).

## Current Phase: P0 — Bootstrap

## Interruption Reason
<!-- empty -->

## Review Roster (fixed at kickoff)
- Code Review (backend/proxies/hooks): typescript-reviewer
- Code Review (frontend): flutter-reviewer
- Security Review: security-reviewer
- Functional Coverage: functional-coverage
- Architecture (phase boundaries): architect

## What's Done
- [x] V1 archival — commit 7d95aca
- [x] New skeleton `current/claude-harbor/` scaffolded
- [x] PLAN-claude-harbor.md written
- [x] PROGRESS.md rewritten
- [x] Remote set to `git@github.com-self:plutozhang99/claude-harbor.git`
- [x] **P0.1** Remote Bun server — HTTP `/hooks/session-start`, `/statusline`, `/admin/push-message`, WS `/channel`, SQLite. 19 tests pass, tsc clean. Reviews: code ✅ sec ✅ func ✅ (P1 hardening flagged: auth+TLS per spec scope)
- [x] **P0.2** Stdio MCP proxy (`current/claude-harbor/proxy/`) — MCP handshake, WS handshake + bound ack, inbound forwarding to `notifications/claude/channel`, outbound `reply` tool -> `POST /channel/reply`. Server-side adds: `POST /channel/reply` endpoint, `insertMessage` on Db, `channel_token` in bound-ack frame. Reviews: code ✅ sec ✅ func ✅. Final: 29 server tests, 30 proxy tests, tsc clean. Hardening: inbound content/meta caps + control-char strip, token redaction in logs, constant-time token compare, HARBOR_URL scheme allowlist, stdin line cap (1 MiB), reconnect rate cap. Follow-up: `correlate.ts:78` still logs 8-char token prefix on ws-bind-refused — P1 cleanup.
- [x] **P0.3** CLI wrapper (`current/claude-harbor/wrapper/`) — `claude-harbor start [args]` exec's real `claude --channels plugin:claude-harbor@local [args]`. `CLAUDE_BIN` + PATH discovery (realpath canonicalization, relative-PATH entries rejected). SIGINT/SIGTERM/SIGHUP forwarding with pre-spawn handler registration. `HARBOR_CHANNEL_SPEC` override regex-validated. Reviews: code ✅ sec ✅ func ✅. 21 wrapper + 29 server + 30 proxy tests, all tsc clean.

## Next Steps
- [ ] P0.4: Install script — writes `~/.claude/settings.json` hooks + statusline + channel plugin; idempotent; includes uninstall

## Notes / Gotchas
- **Dropped features (do not rebuild):** account email identification, CC session_id/model auto-injection into channel tags, remote `/model` slash switch.
- **~/.claude policy:** writes only at install/uninstall time. Runtime NEVER touches it.
- **Session correlation:** hooks and channel subprocess are independent streams from CC; remote correlates by `cwd + parent_pid`. Test both match paths and mismatch (unbound) paths early.
- **Statusline is the only surface for model / ctx-% / rate-limits / cost.** Hooks don't expose them. Design backend accordingly.
- **Wrapper-only contract:** users running raw `claude` get hooks firing but no channel; frontend shows degraded (read-only) sessions. This is deliberate.
- **DESIGN.md is authoritative for UI** — Mistral warm palette, no cool colors, weight 400 only, sharp corners.

## Next Agent Prompt
Kick off P0.4 — install/uninstall script.

> You are implementing Phase P0.4 of claude-harbor. Build a Bun CLI at `current/claude-harbor/installer/` with two commands: `install` and `uninstall`. Read PLAN §§3, 7 and all of CHANNELS-REFERENCE.md for the exact `~/.claude/settings.json` hook/statusline/channels shapes. On install: (1) write hook entries (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd, Notification) pointing at a `claude-harbor-hook` binary (which you will also create — a tiny Bun script that POSTs stdin JSON to `${HARBOR_URL}/hooks/<event>`), (2) wire statusline to a `claude-harbor-statusline` binary (POSTs stdin, echoes returned line), (3) register the channel plugin `claude-harbor@local` per CHANNELS-REFERENCE §8 with `allowedChannelPlugins`. All writes must be idempotent (diff-and-merge, not clobber). Include `--dry-run`. Uninstall reverses exactly what install added. Backup the existing settings.json to settings.json.bak before first write. Keep all files <400 lines. Tests: install against a tmp $CLAUDE_HOME asserts idempotency, uninstall leaves file byte-identical to pre-install. No frontend, no hook/statusline POST bodies beyond pass-through.

## Orchestrator Rules (for future sessions)
On restart, still follow:
1. Orchestrator only — never write code/docs yourself; delegate to sub-agents.
2. After every sub-agent delivery, run code + security + functional reviews in PARALLEL as independent sub-agents, then have another sub-agent fix all findings. Max 3 review rounds before escalation.
3. Commit as soon as a task clears review — do not wait for user approval each time.
4. Auto-advance until context window is near its limit; no approval needed per step.
5. Keep this PROGRESS.md live — update at task start, task end, review result, commit.
6. When all P0–P4 tasks done, move `docs/progress/PROGRESS.md` to `docs/archive/PROGRESS-claude-harbor-[YYYYMMDD].md`.
7. Model routing: opus for coding/review/arch, sonnet for docs, haiku for commits/read-only exploration.
8. Reviews always parallel, never collapsed into one agent.
