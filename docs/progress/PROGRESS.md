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

## Next Steps
- [ ] P0.3: `claude-harbor` CLI wrapper — `claude-harbor start [args]` → exec claude with channels
- [ ] P0.4: Install script — writes `~/.claude/settings.json` hooks + statusline + channel plugin; idempotent; includes uninstall

## Notes / Gotchas
- **Dropped features (do not rebuild):** account email identification, CC session_id/model auto-injection into channel tags, remote `/model` slash switch.
- **~/.claude policy:** writes only at install/uninstall time. Runtime NEVER touches it.
- **Session correlation:** hooks and channel subprocess are independent streams from CC; remote correlates by `cwd + parent_pid`. Test both match paths and mismatch (unbound) paths early.
- **Statusline is the only surface for model / ctx-% / rate-limits / cost.** Hooks don't expose them. Design backend accordingly.
- **Wrapper-only contract:** users running raw `claude` get hooks firing but no channel; frontend shows degraded (read-only) sessions. This is deliberate.
- **DESIGN.md is authoritative for UI** — Mistral warm palette, no cool colors, weight 400 only, sharp corners.

## Next Agent Prompt
Kick off P0.3 — claude-harbor CLI wrapper.

> You are implementing Phase P0.3 of claude-harbor. Build a small Bun single-file CLI at `current/claude-harbor/wrapper/` that exposes a `claude-harbor` binary. Command: `claude-harbor start [...args]` — exec the real `claude` binary with the channels plugin activated. Need to: discover the user's `claude` executable via PATH (or `CLAUDE_BIN` env override), pass through all args verbatim, and ensure the channels plugin `claude-harbor-ch` (from `current/claude-harbor/proxy/`) is wired via `claude --channels=plugin:claude-harbor@local` flag (confirm exact flag name via CHANNELS-REFERENCE.md). Also support `claude-harbor --version` and `claude-harbor --help`. Do NOT modify `~/.claude/` from runtime — that's P0.4's install script's job. Tests: version, help, arg passthrough (spawn `echo` as fake `claude`), missing-claude error handling. Keep files <400 lines. No install script, no frontend yet.

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
