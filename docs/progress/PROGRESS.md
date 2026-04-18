## Project: claudegram v1 — P1 (PWA skeleton + WebSocket live push)

## Spec Files
- docs/request_v1.md
- docs/archive/PROGRESS-P0-2026-04-18.md (P0 reference, shipped)

## Current Phase: P1.2 + P1.3 — API routes + WebSocket broadcast hub (parallel)

## Interruption Reason


## Rate Limit State


## Review Roster (P1 roster; A11y newly activated — PWA UI arrives in this phase)
固定:
- Slot 1 Code Review: typescript-reviewer agent (no typescript-review skill installed)
- Slot 2 Security Review: security-review skill
- Slot 3 Functional Coverage: functional-coverage skill (always)
条件性 (仅列出已激活的):
- Slot 4 DB Review: database-reviewer agent
- Slot 5 A11y Review: a11y-architect agent (PWA shell only — P1.5/1.6)
- Slot 6 Type Review: type-design-analyzer agent
- Slot 7 Error Review: silent-failure-hunter agent

Not activated for P1:
- Slot 8 Perf: no high-perf requirement (single-user PWA)
- Slot 9 Clinical: N/A

## Active Task
P1.2 + P1.3 dispatched in parallel after P1.1 shipped (R2 PASS).

## Completed Tasks
- [x] **P1.1** schema evolution + repo extensions — 2 rounds — code ✅ sec ✅ func ✅ db ✅ type ✅ err ✅

## Pending Tasks (prioritized)

### P1.2 — API routes  (in progress)
- [ ] **1.2a** `src/routes/api/sessions.ts` — `GET /api/sessions` → `{ sessions: SessionListItem[] }`
- [ ] **1.2b** `src/routes/api/messages.ts` — `GET /api/messages?session_id=X&before=MID&limit=N` — Zod query validation, 400 on invalid, empty array on unknown session
- [ ] **1.2c** `src/routes/api/me.ts` — `GET /api/me` — read `Cf-Access-Authenticated-User-Email` header; fallback `local@dev` when absent
- [ ] **1.2d** wire into `http.ts` dispatcher (GET-only methods, 405 otherwise)

### P1.3 — WebSocket broadcast hub  (in progress)
- [ ] **1.3a** `src/ws/hub.ts` — `Hub` interface + in-memory `Set<ServerWebSocket>` impl with `add` / `remove` / `broadcast(payload)`; safe JSON.stringify once per broadcast
- [ ] **1.3b** `src/server.ts` — extend Bun.serve with `websocket` handler; upgrade at `/user-socket` only
- [ ] **1.3c** `src/routes/ingest.ts` — on success emit `{type:'message', session_id, message}` via hub; also `{type:'session_update', session}` after upsert
- [ ] **1.3d** WS lifecycle: open logs, close removes from hub, message events ignored in P1 (reserved for P2)

### P1.4 — Static file serving  (queued after P1.2)
- [ ] **1.4a** `src/routes/static.ts` — serve from `web/` dir; path traversal guard via resolved absolute-path prefix check; content-type map (html, js, css, json, png, svg, webmanifest); 404 on miss
- [ ] **1.4b** wire `/` → `web/index.html`, `/web/*` → static handler into dispatcher

### P1.5 — PWA shell (HTML/CSS/manifest/sw)  (depends on 1.4 plumbing; content independent)
- [ ] **1.5a** `web/index.html` — sidebar + message pane + compose, `<script type="module" src="/web/js/index.js">`, semantic landmarks for a11y
- [ ] **1.5b** `web/style.css` — port fakechat bubble/chip/compose styling; CSS Grid + `@media (max-width: 640px)` responsive
- [ ] **1.5c** `web/manifest.json` — name, short_name, start_url `/`, display `standalone`, 192 + 512 icons, theme_color
- [ ] **1.5d** `web/sw.js` — versioned cache name, cache app shell (`/`, `/web/js/*`, `/web/style.css`, `/web/manifest.json`), no API caching, skipWaiting + clientsClaim
- [ ] **1.5e** `web/icons/icon-192.png` + `icon-512.png` — minimal single-color placeholder; spec quality gate: PWA installable on Chrome

### P1.6 — PWA JS modules  (depends on 1.2, 1.3)
- [ ] **1.6a** `web/js/ws.js` — connect to `/user-socket`; exponential backoff (250ms → 8s cap); typed emitter
- [ ] **1.6b** `web/js/store.js` — in-memory session map + per-session message array; hydrate from `/api/sessions` + `/api/messages`
- [ ] **1.6c** `web/js/render.js` — session list render, active session highlight, message list render, append-on-message
- [ ] **1.6d** `web/js/notify.js` — P3-stub
- [ ] **1.6e** `web/js/index.js` — boot sequence

### P1.7 — Integration + docs
- [ ] **1.7a** `src/integration.test.ts` — E2E: boot server → connect WS client → POST /ingest → assert WS receives events
- [ ] **1.7b** `GET /api/sessions` integration test
- [ ] **1.7c** `GET /api/messages` integration test
- [ ] **1.7d** README update

## Review Log
| Task | Code | Sec | Func | DB | A11y | Type | Err | Rounds | Result |
|------|------|-----|------|----|------|------|-----|--------|--------|
| P1.1 R1 | PASS w/ MINOR (H1 stubs, M composite cursor, M transaction, M NaN) | PASS w/ MINOR (M cursor, L NaN) | PASS | PASS w/ MINOR (M transaction, M composite cursor) | N/A | PASS w/ MINOR | FAIL w/ MINOR (M transaction, M NaN) | 1 | ⚠️→R2 |
| P1.1 R2 | PASS (all fixes verified) | N/A (re-review not needed) | PASS | PASS | N/A | N/A | N/A | 2 | ✅ COMPLETE |

## Key Decisions & Accepted Risks

### Architecture (P1)
- 2026-04-18 **unread_count computation**: `count(direction='assistant' AND ts > sessions.last_read_at)`. P1 has no `mark_read` yet (P2 adds it), so `last_read_at` stays 0 by default and unread grows monotonically. Accepted: UX shows "N messages since boot" until P2 lands.
- 2026-04-18 **Schema evolution without version table**: P0 deferred `schema_version` to P1. For P1's additive-only change, `PRAGMA table_info` detection used. Tech debt, introduce schema_version when P2 adds destructive migrations.
- 2026-04-18 **Composite `(ts, id)` cursor** (added R2): pagination filters on `(ts < cursor.ts OR (ts = cursor.ts AND id < cursor.id))` with `ORDER BY ts DESC, id DESC`. Prevents skip/duplicate on duplicate timestamps.
- 2026-04-18 **NaN guard on limit** (added R2): `Number.isFinite(candidate)` check before clamp in both `findBySession` and `findBySessionPage`.
- 2026-04-18 **Migration transaction** (added R2): ALTER statements now wrapped in BEGIN/COMMIT with ROLLBACK on throw.
- 2026-04-18 **API cursor format**: `before=MID` (message_id) per spec §12.6.
- 2026-04-18 **`has_more` via limit+1 fetch**: avoids second COUNT query.
- 2026-04-18 **WebSocket hub scope**: single global in-memory `Set<ServerWebSocket>`. P1 broadcasts to all PWA clients; P2 adds per-session filtering when fakechat reverse-WS lands.
- 2026-04-18 **`/api/me` header source**: `Cf-Access-Authenticated-User-Email`; fallback `local@dev` when absent (before CF Access P4).
- 2026-04-18 **Static file root**: `current/claudegram/web/`. Resolve via `path.resolve` + prefix check.
- 2026-04-18 **No framework, no build step**: vanilla ESM per spec §12.3.

### Process
- 2026-04-18 Teams: single agents for P1 (review surface fits without coordination overhead).
- 2026-04-18 TDD applies to: 1.1, 1.2a-c, 1.3a + 1.3c, 1.4a, 1.7a-c.
- 2026-04-18 Coverage targets: repo 90%, API routes 85%, WS hub 85%, static resolver 80%, frontend JS covered by integration only.
- 2026-04-18 Orchestrator skipped mandatory architect (opus) pass per user directive "skip model check follow the plan and keep moving".

## Next Agent Prompt

P1.2 + P1.3 dispatched as two parallel agents (see orchestrator history). File surfaces are orthogonal:
- P1.2: new files in `src/routes/api/`, extends `src/http.ts` dispatcher
- P1.3: new file `src/ws/hub.ts`, extends `src/server.ts` (Bun.serve websocket handler) and `src/routes/ingest.ts` (broadcast on success); does NOT touch `src/http.ts`
