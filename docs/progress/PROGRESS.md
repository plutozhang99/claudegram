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

## Next Steps
- [ ] P0.2: `claude-harbor-ch` stdio MCP proxy — connects to remote, forwards notifications + reply
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
Kick off P0.2 — claude-harbor-ch stdio MCP proxy.

> You are implementing Phase P0.2 of claude-harbor. The remote server is live at `current/claude-harbor/server/` (see its README). Build a stdio MCP server binary at `current/claude-harbor/proxy/` (Bun single-file) that CC spawns as a channel plugin. Read PLAN sections 2–4 and CHANNELS-REFERENCE.md for exact channel MCP frame shapes. The proxy must: (1) speak MCP stdio to CC, (2) open a WebSocket to the remote `/channel`, (3) send handshake `{parent_pid: process.ppid, cwd: process.cwd(), ts}`, (4) forward inbound admin-push frames to CC as `notifications/claude/channel`, (5) forward CC `reply` tool calls upstream via a new remote endpoint (you will add `POST /channel/reply` on the server side). Tests with `bun:test`: handshake success, inbound forwarding, reply forwarding, graceful shutdown on stdin EOF. NO install script, NO CLI wrapper yet.

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
