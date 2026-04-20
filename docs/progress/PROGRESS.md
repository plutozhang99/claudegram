## Project: claude-harbor

## Spec Files
- `docs/plans/PLAN-claude-harbor.md` — full architecture + phase plan
- `docs/DESIGN.md` — Mistral warm palette (MUST follow for all UI)
- `docs/CHANNELS-REFERENCE.md` — CC channel/hook/statusline research
- `docs/archive/PROGRESS-claude-harbor-P0-20260419.md` — P0 snapshot
- `docs/archive/PROGRESS-claude-harbor-P1-20260419.md` — P1 snapshot (hooks + correlation + account_hint)

## Plan File
- `docs/plans/PLAN-claude-harbor.md`

## Project Structure
```
/ (repo root)
├── current/
│   ├── claude-harbor-client/     # wrapper, hook, statusline, installer, proxy
│   ├── claude-harbor-server/     # Bun HTTP+WS+SQLite server (P1 done)
│   └── claude-harbor-frontend/   # Flutter PWA (NEW — P2 target)
├── docs/
└── legacy/                       (pre-V2, untouched)
```
Stack: Bun + TypeScript (server + local binaries), Flutter 3.x Web PWA (P2), SQLite, Web Push later (P3).

## DESIGN.md
YES — `docs/DESIGN.md` (Mistral warm palette). All UI work in P2 MUST follow it:
- Warm Ivory `#fffaeb` backgrounds, Cream `#fff0c2` surfaces, Mistral Orange `#fa520f` brand, Mistral Black `#1f1f1f` text.
- Single weight 400, size drives hierarchy. Near-zero border-radius. Amber-tinted shadows `rgba(127,99,21,...)`.
- No cool colors. No bold weights. No rounded corners.

## Current Phase: P2 — Flutter frontend scaffold

## Interruption Reason
rate-limit-5h — opus sub-agent hit its 5h limit mid-P2.0 (resets 3am America/Toronto on 2026-04-20). Implementation is on disk, 3 WS fan-out tests are still failing; resume by dispatching a sonnet fix agent against the 3 failures, then run reviews.

## Review Roster (fixed at kickoff)
- Code Review (backend): typescript-reviewer
- Code Review (frontend): flutter-reviewer
- Security Review: security-reviewer
- Functional Coverage: functional-coverage
- Architecture (phase boundaries): architect

## Server API Surface Before P2 (from Explore 2026-04-20)
**Already exists:**
- `POST /channel/reply` (frontend→server outbound), `POST /statusline`, `GET /health`
- `POST /hooks/*` (7 endpoints, local-only), `POST /admin/*` (token/loopback-gated)
- `WS /channel` (for `claude-harbor-ch` stdio proxy — not for frontend)
- SQLite: `sessions`, `messages`, `tool_events`, `push_subscriptions`, `install_meta`

**Gaps for Flutter:**
- ❌ `GET /sessions` — list
- ❌ `GET /sessions/:id` — detail + latest statusline
- ❌ `GET /sessions/:id/messages` — paginated history
- ❌ WS subscribe route for live session/message updates
- ❌ CORS headers (same-origin strategy preferred — serve Flutter from same Bun)
- ❌ Static file serving for Flutter web bundle

## Task Breakdown

### P2.0 — Server API prep for frontend (typescript-reviewer)
- `GET /sessions?status=active|idle|ended|all&limit=&offset=` → list rows with latest_* snapshot cols.
- `GET /sessions/:session_id` → full session row + most recent statusline fields + counts.
- `GET /sessions/:session_id/messages?before=&limit=` → messages paginated desc-by-id. Include direction, content, meta_json, created_at.
- `WS /subscribe` (frontend-facing) → server pushes events: `session.updated`, `session.created`, `session.ended`, `message.created` (per session), `statusline.updated`. Simple broadcast to all subscribers (single-user assumption). Same loopback/token gating.
- Static file serving: serve `current/claude-harbor-frontend/build/web/**` at `/`, fall through to 404 if missing. If no bundle yet, return a stub index.
- CORS: same-origin preferred; add permissive CORS ONLY when loopback-bound AND dev-mode env (`HARBOR_DEV=1`). Default = no CORS.
- Tests: new endpoints, subscribe WS broadcast, static fallthrough.
- Keep all source files ≤400 lines. Extract `src/http-sessions.ts` + `src/ws-subscribe.ts`.

### P2.1 — Flutter project scaffold + theme (flutter-reviewer)
- Init Flutter 3.x project at `current/claude-harbor-frontend/` (targets: web default; mobile added P4).
- State mgmt: **Riverpod 2.x** (standard, testable).
- HTTP: `dio` or `http`. WebSocket: `web_socket_channel`.
- Theme module `lib/theme/mistral_theme.dart` with full palette + typography + shadow tokens from DESIGN.md.
- Placeholder home screen rendering palette swatches to verify theme.
- `flutter analyze` clean; `flutter test` with a single smoke test.

### P2.2 — Data layer: models + API client + WS subscribe (flutter-reviewer)
- Models: `Session`, `Message`, `Statusline`, `RateLimits`. Immutable (freezed or hand-rolled copyWith).
- Repository: `SessionRepository`, `MessageRepository` backed by REST. `LiveUpdateService` wrapping `/subscribe` WS with reconnect + heartbeat.
- Riverpod providers. Unit tests with mock HTTP.

### P2.3 — Session list screen (flutter-reviewer)
- Live-updating list sorted by `latest_statusline_at` desc.
- Each tile: project_dir basename, model display, ctx% bar, cost, status dot (green/amber/gray), 5h/7d limits condensed.
- Empty state + loading skeletons (Mistral warm tones).
- Pull-to-refresh on mobile, click tile → detail route.

### P2.4 — Session detail screen (flutter-reviewer)
- Two-pane (desktop) / stacked (mobile) responsive layout.
- Chat pane: message list with direction styling (inbound/outbound), tool_event markers collapsed, timestamp grouping.
- Metadata pane: model, ctx% ring, 5h/7d limit bars, cost, cwd, status, account_hint.
- Compose box → `POST /channel/reply` using `channel_token` from session detail response.
- Disabled compose if session `status='unbound'` or `'ended'`.

### P2.5 — Build + same-origin serve wiring (typescript-reviewer + flutter-reviewer)
- Script to run `flutter build web --release` and have Bun serve the bundle.
- Smoke: server up → open `http://127.0.0.1:PORT/` → session list loads, WS updates arrive, chat reply round-trips.
- Update README with P2 dev workflow.

## What's Done
- [~] **P2.0 (PARTIAL)** Server API prep — code landed, 3 WS fan-out tests failing, reviews pending.
  - New src files: `http-sessions.ts` (5.9K), `ws-subscribe.ts` (4.1K), `event-bus.ts` (4.7K), `http-static.ts` (5.5K), `db-queries.ts` (4.0K), `http-admin.ts` (4.7K), `http-reply.ts` (4.6K) — split from the old monolithic `http.ts`.
  - Modified: `src/http.ts`, `src/db.ts`, `src/http-hooks.ts`, `src/index.ts`, `src/correlate.ts`.
  - New test files: `server.p2-sessions.test.ts`, `server.subscribe.test.ts`, `server.static.test.ts`, `server.cors.test.ts`.
  - Results: `bun tsc --noEmit` ✅ clean; `bun test` = 123 pass / 3 fail.
  - **Failing tests** (all timeouts, `server.subscribe.test.ts`): "creating a session fans out session.created", "/statusline fans out statusline.updated", "/hooks/session-end fans out session.ended". Likely missing emit calls on EventBus from the corresponding handlers, OR subscriber set not receiving because bus instance is not shared.
  - Not committed yet. Fix first → reviews → commit.

## Next Steps
- [ ] **P2.0 FIX** Diagnose the 3 WS fan-out failures; dispatch sonnet sub-agent (opus 5h quota exhausted until 3am Toronto)
- [ ] **P2.0 REVIEWS** After green: typescript-reviewer + security-reviewer + functional-coverage in parallel; fix-round ≤3; commit with haiku
- [ ] **P2.1** Flutter scaffold + Mistral theme
- [ ] **P2.2** Data layer (models, REST, WS subscribe)
- [ ] **P2.3** Session list screen
- [ ] **P2.4** Session detail screen
- [ ] **P2.5** Build integration + smoke test

## Notes / Gotchas
- **DESIGN.md is binding** — no cool colors, no bold weights, no rounded corners. Reviewers must flag violations.
- **Same-origin strategy** preferred over CORS — serve Flutter from same Bun port; frontend uses relative URLs.
- **channel_token, not session_id**, is what `POST /channel/reply` accepts. Frontend must carry token through detail screen.
- **No auth yet** — P2 is still single-user internal-network. Loopback bind by default (PLAN §12). Flag widening for P5.
- **CC channel NOT frontend WS** — `WS /channel` is for stdio proxy. New `WS /subscribe` is the frontend one. Keep routes distinct.
- **P2 blocks P3 (Web Push)** — don't start P3 until frontend shell exists to install the service worker.

## Next Agent Prompt
> **P2.0 FIX PASS.** Use **sonnet** (opus weekly quota is out until 3am Toronto). Read `docs/progress/PROGRESS.md` "What's Done → P2.0 (PARTIAL)" section. In `current/claude-harbor-server/`: three tests in `test/server.subscribe.test.ts` are timing out — "creating a session fans out session.created", "/statusline fans out statusline.updated", "/hooks/session-end fans out session.ended". Diagnose: (a) verify `src/event-bus.ts` is a shared singleton (or passed through `createServer` context) — not two separate instances between handlers and WS; (b) verify `src/http-hooks.ts::handleSessionStart` (or wherever `createSession` is called) emits `session.created`; (c) verify `/statusline` handler in `http.ts` or `http-reply.ts` emits `statusline.updated`; (d) verify `handleSessionEnd` emits `session.ended`; (e) verify `src/ws-subscribe.ts` actually subscribes to those events and forwards over the WS. Fix with the minimum diff. All 126 tests must pass; `bun tsc --noEmit` must stay clean. Do NOT touch the installer, wrapper, hook binary, statusline binary, or MCP proxy. Do NOT scaffold Flutter. Report the root cause in one sentence and the diff in bullet points.
>
> **After tests are green:** Orchestrator (me) will run parallel typescript-reviewer + security-reviewer + functional-coverage, fix findings, then commit. Do not run reviews yourself.
>
> --- (historical P2.0 implementation prompt preserved below for archival) ---
>
> Implement P2.0 for claude-harbor. Read `docs/plans/PLAN-claude-harbor.md`, `docs/progress/PROGRESS.md` (Server API Surface + P2.0 section), and the existing `current/claude-harbor-server/src/http.ts`, `src/db.ts`, and `src/http-hooks.ts` first.
>
> Add these endpoints to the server (new modules `src/http-sessions.ts` for REST, `src/ws-subscribe.ts` for the frontend WS + event bus):
> 1. `GET /sessions?status=&limit=&offset=` — list rows. Default status=all. limit default 50, cap 200. Return `{ sessions: SessionRow[], total: number }`.
> 2. `GET /sessions/:session_id` — single row with all latest_* cols and a `counts: { messages, tool_events }` object. 404 if not found.
> 3. `GET /sessions/:session_id/messages?before=<id>&limit=` — messages desc by id. limit default 100, cap 500. Return `{ messages: MessageRow[], next_before: number|null }`.
> 4. `WS /subscribe` — frontend live channel. On connect: send snapshot-free ack `{ type: "subscribed" }`. Server broadcasts events to all open subscribers: `{ type: "session.created"|"session.updated"|"session.ended"|"message.created"|"statusline.updated", session_id, payload }`. Add a tiny EventBus in `src/event-bus.ts`; wire existing hook handlers (`http-hooks.ts`) + `/channel/reply` + `/statusline` to emit.
> 5. Static file serve: if `current/claude-harbor-frontend/build/web/index.html` exists, serve it + its assets at `/` with correct MIME types. Otherwise return a JSON stub `{ frontend: "not built yet" }` on GET `/`.
> 6. CORS: no headers by default. When `HARBOR_DEV=1` AND bind is `127.0.0.1`, allow `Access-Control-Allow-Origin: *` on GET routes ONLY. Never on POST.
>
> Constraints: keep each file ≤400 lines. Extract helpers as needed. All new routes must use `safeStringify`, control-char strip, 64 KiB streaming body cap, `checkAdminAuth` where appropriate (only `WS /subscribe` — same gate as `/admin/*`). Add tests in `test/server.p2-sessions.test.ts` and `test/server.subscribe.test.ts` covering: list filters, pagination, 404, WS event fan-out, static fallthrough, CORS dev-mode behavior, CORS disabled by default. Run `bun test` and `bun tsc --noEmit` — both must pass. Do NOT touch installer, wrapper, hook, statusline, or proxy binaries. Do NOT start the Flutter work — that's P2.1.

## Orchestrator Rules (for future sessions)
On restart, still follow:
1. Orchestrator only — never write code/docs yourself; delegate to sub-agents.
2. After every sub-agent delivery, run code + security + functional reviews in PARALLEL as independent sub-agents, then have another sub-agent fix all findings. Max 3 review rounds before escalation.
3. Commit as soon as a task clears review — do not wait for user approval each time.
4. Auto-advance until context window is near its limit; no approval needed per step.
5. Keep this PROGRESS.md live — update at task start, task end, review result, commit.
6. When P2 phase tasks all done, update PROGRESS.md for P3 (do not archive unless all project phases done).
7. Model routing: opus for coding/review/arch, sonnet for docs, haiku for commits/read-only exploration.
8. Reviews always parallel, never collapsed into one agent.
9. **DESIGN.md violations (cool colors / bold weights / rounded corners) are HIGH-severity blocking findings** — frontend code that violates must be fixed before review passes.
