## Project: claude-harbor

## Spec Files
- `docs/plans/PLAN-claude-harbor.md` — full architecture + phase plan
- `docs/CHANNELS-REFERENCE.md` — CC channel/hook/statusline research (2026-04-19)
- `docs/DESIGN.md` — Mistral warm palette (frontend must follow)
- `docs/archive/PROGRESS-claude-harbor-P0-20260419.md` — completed P0 snapshot

## Plan File
- `docs/plans/PLAN-claude-harbor.md`

## Project Structure
```
/ (repo root)
├── current/
│   ├── claude-harbor-client/   # wrapper, hook, statusline, installer, proxy + install.sh/uninstall.sh
│   └── claude-harbor-server/   # Bun HTTP+WS+SQLite server, tests
├── docs/
│   ├── DESIGN.md, CHANNELS-REFERENCE.md
│   ├── plans/PLAN-claude-harbor.md
│   ├── progress/PROGRESS.md    (this file)
│   └── archive/
└── legacy/                     (pre-V2 code, untouched)
```
Stack: Bun + TypeScript (server + local binaries), Flutter 3.x (frontend — starts P2), SQLite, Web Push later.

## DESIGN.md
YES — `docs/DESIGN.md`. All UI changes must follow the Mistral warm palette. (P1 is backend-only; P2 onward must honor it.)

## Current Phase: P1 — Full hooks & session correlation

## Interruption Reason
<!-- empty -->

## Review Roster (fixed at kickoff)
- Code Review (backend/proxies/hooks): typescript-reviewer
- Code Review (frontend): flutter-reviewer  (unused until P2)
- Security Review: security-reviewer
- Functional Coverage: functional-coverage
- Architecture (phase boundaries): architect

## Inherited P0 State (from archive)
- Server: `/hooks/session-start`, `/statusline`, `/channel/reply`, `/admin/push-message`, `GET /health`, WS `/channel` with cwd+pid correlation + bound/idle state. SQLite schema already has all P1 tables (sessions, messages, tool_events, push_subscriptions).
- Client hook binary: **generic** — reads event name from argv[0], POSTs stdin JSON to `/hooks/<kebab-case-event>`. All 7 events registered by installer.
- Installer: registers 7 hooks + statusline + channel plugin; idempotent; sidecar-tracked.
- Tests: 29 server + 30 proxy + 21 wrapper + 20 hook + 18 statusline + 25 installer. tsc clean everywhere.

## Gaps Identified for P1
1. **Missing 6 hook endpoints** server-side: `/hooks/user-prompt-submit`, `/pre-tool-use`, `/post-tool-use`, `/stop`, `/session-end`, `/notification`. (Only `/session-start` exists.)
2. **Tool event persistence** — schema ready, no write path. Messages persistence only via `/channel/reply`; need UserPromptSubmit → messages (inbound).
3. **State machine** — current: SessionStart→active, WS bind→active, WS close→idle. Missing: SessionEnd→ended, optional idle→ended timeout.
4. **account_hint** — installer never calls `claude auth status --json`; sessions.account_hint always NULL.
5. **Repository layer** — Db class has ad-hoc methods; no dedicated repo abstraction or tests isolated to it (acceptable if covered via endpoint tests).

## Task Breakdown
- **P1.1** Add 6 missing hook endpoints + payload persistence (tool_events, messages inbound). Strict schema validation; reject unknown hook events; size caps; control-char strip on text fields.
- **P1.2** State machine: SessionEnd → sessions.status='ended', sessions.ended_at=now. Keep idle→ended timer optional (off by default, env-flagged).
- **P1.3** Installer captures account_hint via `claude auth status --json` (best-effort — if CLI missing/fails, continue install); POSTs to a new `/sessions/account-hint` admin endpoint OR writes via install-time one-shot. **Decision:** installer POSTs once to `POST /admin/account-hint` with `{account_hint}`; server persists in a singleton row (`install_meta` table) and copies into sessions on SessionStart.
- **P1.4** Tests + review pass.

## What's Done
- [x] **P1.1** 6 hook endpoints (`/hooks/{user-prompt-submit,pre-tool-use,post-tool-use,stop,session-end,notification}`) + payload persistence (messages inbound, tool_events). New modules: `src/http-hooks.ts` (288), `test/server.p1-hooks.test.ts` (610). Db methods: `insertToolEvent`, `markSessionEnded(reason?)`. **Hardening applied:** streaming 64 KiB body cap via `getReader()` + `reader.cancel()`; FK `ON DELETE CASCADE` on messages + tool_events with `PRAGMA foreign_keys=ON`; `safeStringify` wraps all raw-JSON persistence; control-char strip widened to C1 range and applied to `tool_name`, `permission_mode`, `cwd`, `transcript_path` logs; default bind `127.0.0.1`; PLAN §12 Security added; deterministic test pids; warn-once on legacy field fallbacks. Reviews: code ✅ sec ✅ func ✅ (HIGH fixes verified). 72 tests pass, tsc clean.
- [x] **P1.2** SUBSUMED into P1.1 — `handleSessionEnd` sets `status='ended'`, `ended_at`, `ended_reason` via `markSessionEnded`. Optional idle→ended timer intentionally deferred (env-gated design, off by default).

- [x] **P1.3** account_hint install flow. Server: `install_meta` singleton table (CHECK id=1), `Db.setAccountHint/getAccountHint`, `POST /admin/account-hint` (reuses `checkAdminAuth` gate; 512-char cap + control-char strip + null clear), `createSession` copies hint from `install_meta` at insert time (immutable per session). Installer: `--account-hint auto|skip|manual:<value>` flag, `claude auth status --json` best-effort spawn with 3s timeout, 2s POST timeout, full best-effort delivery (ENOENT/timeout/nonzero/bad-JSON/no-field/POST-failure all survived), uninstall clears. **Hardening:** stdout read concurrent with proc.exited (deadlock fix), `stderr: ignore`, explicit catch logging (no bare `catch {}`), `redactHint` control-char strip on 3-char head window (prevents log injection), POST error reason captured + sanitized + truncated. Reviews: code ✅ sec ✅ func ✅. 90 server + 55 installer tests pass, tsc clean.

## Next Steps
- **P1 complete.** Archiving PROGRESS. P2 (Flutter frontend scaffold) starts fresh when user kicks it off.

## Notes / Gotchas
- **Hook payload shapes vary** — see `docs/CHANNELS-REFERENCE.md` for CC-provided fields per event. Persist raw payload JSON plus a few extracted columns; don't over-normalize.
- **tool_events schema expects `tool_input_json` + `tool_output_json`.** PreToolUse only has input, PostToolUse has both. Keep output nullable.
- **Best-effort everywhere** — hooks are fire-and-forget from CC's POV; 2xx fast, never block CC.
- **account_hint is install-time only** — do NOT touch `~/.claude/` at runtime (policy).
- **No Flutter yet** — P1 is backend + installer only.

## Next Agent Prompt
> Implement P1.1 for claude-harbor. Read `docs/plans/PLAN-claude-harbor.md` §§5,8, `docs/CHANNELS-REFERENCE.md`, and `docs/progress/PROGRESS.md` first. Add 6 HTTP endpoints to `current/claude-harbor-server/src/http.ts`:
> - `POST /hooks/user-prompt-submit` → insert `messages` row with direction='inbound', content=payload.prompt (or equivalent), meta_json=full raw payload. Also insert tool_events-style audit row? NO — user prompts are messages, not tool events.
> - `POST /hooks/pre-tool-use` → insert `tool_events` row (hook_event='PreToolUse', tool_name, tool_input_json, tool_output_json=NULL, permission_mode).
> - `POST /hooks/post-tool-use` → insert `tool_events` row (hook_event='PostToolUse', tool_name, tool_input_json, tool_output_json, permission_mode).
> - `POST /hooks/stop` → no-op write (insert lightweight row into tool_events hook_event='Stop' with null tool_name, OR just 204). Pick one consistently.
> - `POST /hooks/session-end` → update sessions.status='ended', sessions.ended_at=now. If unknown session_id, 404.
> - `POST /hooks/notification` → insert tool_events row (hook_event='Notification', tool_name=null, tool_input_json=payload).
> All endpoints: payload-size cap (64 KiB), session_id required, unknown session_id returns 404, malformed JSON returns 400, control chars stripped from string fields before persist, token redaction in logs. Validate all inputs through a shared zod/hand-rolled schema layer in `src/schema.ts` (extend existing). Extract tool_events + messages repository methods into `src/db.ts`. Add tests covering each new endpoint (happy path, unknown session, malformed payload, oversized payload) into a new file `test/server.p1-hooks.test.ts`. Keep all source files ≤400 lines. Run `bun test` and `bun tsc --noEmit` — both must pass. Report the full list of new endpoints, new Db methods, new test names, and line counts per touched file. Do NOT touch the installer, wrapper, proxy, or client binaries in this task.

## Orchestrator Rules (for future sessions)
On restart, still follow:
1. Orchestrator only — never write code/docs yourself; delegate to sub-agents.
2. After every sub-agent delivery, run code + security + functional reviews in PARALLEL as independent sub-agents, then have another sub-agent fix all findings. Max 3 review rounds before escalation.
3. Commit as soon as a task clears review — do not wait for user approval each time.
4. Auto-advance until context window is near its limit; no approval needed per step.
5. Keep this PROGRESS.md live — update at task start, task end, review result, commit.
6. When P1 phase tasks all done, update PROGRESS.md for P2 (do not archive unless all project phases done).
7. Model routing: opus for coding/review/arch, sonnet for docs, haiku for commits/read-only exploration.
8. Reviews always parallel, never collapsed into one agent.
