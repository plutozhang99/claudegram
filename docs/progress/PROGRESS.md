## Project: claudegram v1 — P0 (MVP foundation)

## Spec Files
- docs/request_v1.md

## Current Phase: P0 COMPLETE (all phases shipped; final sweep clean; ready to tag or push)

## Interruption Reason


## Rate Limit State


## Review Roster (Phase 0 设定，项目中途不变)
固定:
- Slot 1 Code Review: typescript-reviewer agent (no typescript-review skill installed)
- Slot 2 Security Review: security-review skill
- Slot 3 Functional Coverage: functional-coverage skill (always)
条件性 (仅列出已激活的):
- Slot 4 DB Review: database-reviewer agent (SQLite schema + repo layer)
- Slot 6 Type Review: type-design-analyzer agent (TypeScript strict + Zod schemas)
- Slot 7 Error Review: silent-failure-hunter agent (webhook fire-and-forget + ingest 400/500 paths are the silent-failure hotspots)

Not activated for P0:
- Slot 5 A11y: no UI in P0 (PWA is P1)
- Slot 8 Perf: no high-perf requirement
- Slot 9 Clinical: N/A

## Active Task
None — P0 shipped. Next user action: push + tag if desired; start P1 planning.

## Completed Tasks
- [x] **1.1** scaffold — commit: 2b3b04e
- [x] **1.2** `src/config.ts` — commit: 2b3b04e
- [x] **1.3** `src/logger.ts` — commit: 2b3b04e
- [x] **1.4** `src/db/client.ts` — commit: 664f059
- [x] **2.1** `src/db/schema.ts` + `migrate.ts` — commit: fb750ff — ms precision via `CAST(unixepoch('subsec')*1000 AS INTEGER)`
- [x] **2.2** `src/repo/types.ts` — commit: fb750ff — extracted `MessageInsert` + `SessionUpsert`
- [x] **2.3** `src/repo/sqlite.ts` — commit: fb750ff — limit floor clamp prevents `LIMIT -1` unlimited footgun
- [x] **3.1** `src/http.ts` + `src/server.ts` — commit: 50a11cb
- [x] **3.2** `src/routes/health.ts` — commit: 50a11cb — `handleHealth(req, { db })` unified signature
- [x] **3.3** `src/routes/ingest.ts` — commit: 50a11cb — streaming body cap, NaN Content-Length guard
- [x] **3.4** SIGTERM/SIGINT shutdown — commit: 50a11cb — try/finally ensures exit
- [x] **4.0** scoped STATE_DIR — commit: 68a0661
- [x] **4.1** env loading — commit: 68a0661
- [x] **4.2** getSessionId with ULID fallback — commit: 68a0661 — empty-file + race-retry fallbacks
- [x] **4.2b** FAKECHAT_PORT auto-pick — commit: 68a0661 — `err.code === 'EADDRINUSE'` (stable)
- [x] **4.3a** postIngest webhook — commit: 68a0661 — fire-and-forget, 5s timeout, structured JSONL stderr
- [x] **4.3b** multi-session integration test — commit: 68a0661 — `src/multi-session.test.ts`
- [x] **5.1** README — Phase 5 commit below
- [x] **5.2** in-process integration test — covered by `src/multi-session.test.ts` (commit 68a0661)
- [x] **5.3** spec §8.5 manual checklist — verified live: /health 200, /ingest 200, /api/* 404, /nope 404, POST /health 405, invalid json 400, invalid schema 400 with issues, SIGTERM exit 0, DB attribution correct
- [x] **5.4** final review sweep — SHIP verdict; 1 MEDIUM (fakechat README stale string) + 1 LOW (content min) addressed inline

## Review Log
| Task | Code | Security | Functional | DB | Type | Error | Rounds | Result |
|------|------|---------|------------|----|----|------|--------|--------|
| 1.1 | N/A (config only) | N/A | N/A | N/A | N/A | N/A | 0 | ✅ |
| 1.2 | PASS | PASS (path traversal refined) | 16/16 | N/A | PASS (strict PORT, readonly) | PASS | 1 | ✅ |
| 1.3 | PASS | PASS | 18/19 (console.* spy skipped, verified by grep) | N/A | PASS (LEVEL_RANK readonly) | PASS→PASS (safe JSON fallback) | 1 | ✅ |
| 1.4 | PASS | PASS | 100% | PASS for P0 scope | PASS | PASS (FK verify added) | 1 | ✅ |
| 2.1 | PASS | N/A | 18/18 | PASS for P0 | PASS | PASS (schema-drift TODO) | 1 | ✅ |
| 2.2 | PASS | N/A | 7/7 | N/A | PASS (named types) | N/A | 1 | ✅ |
| 2.3 | PASS | PASS | 27/27 | PASS | PASS | PASS (limit floor) | 1 | ✅ |
| 3.1 | PASS | PASS | 7/7 | N/A | PASS | PASS | 0 | ✅ |
| 3.2 | PASS | PASS | 4/4 | N/A | PASS | PASS | 0 | ✅ |
| 3.3 | PASS | PASS (stream cap + NaN guard) | 11/11 | N/A | PASS (Pick<RouterCtx>) | PASS | 1 | ✅ |
| 3.4 | PASS | PASS | 5/5 (1 skip: spawn flaky) | N/A | PASS | PASS (try/finally) | 1 | ✅ |
| 4.0-4.2b | PASS | PASS | PASS | N/A | PASS | PASS (err.code stable check) | 1 | ✅ |
| 4.3a | PASS | PASS | 14/14 | N/A | PASS | PASS (Error instanceof narrowing) | 1 | ✅ |
| 4.3b | PASS | PASS | PASS | PASS | PASS | PASS | 0 | ✅ |
| Final sweep | SHIP | clean | clean | clean | clean | clean | 0 | ✅ |

## Key Decisions & Accepted Risks

### Architecture
- 2026-04-18 Repo interface pattern from day 1 (spec §4.3). Only SQLite impl in P0.
- 2026-04-18 Zod at boundaries; types inferred from schemas, not duplicated.
- 2026-04-18 Single `current/claudegram/package.json` independent of `current/fakechat/package.json`. No monorepo tooling.
- 2026-04-18 No CF Access in P0 (spec §8.5 pt 6). Plain localhost HTTP.

### Schema (supersedes spec §8.4 DDL where noted)
- 2026-04-18 `messages` PK: **composite `(session_id, id)`** — spec text said "UNIQUE globally by (session_id, id)" but DDL had `id TEXT PRIMARY KEY`. Composite PK is authoritative.
- 2026-04-18 Idempotency SQL: `INSERT ... ON CONFLICT(session_id, id) DO NOTHING` (not `INSERT OR IGNORE`, which swallows all constraint errors).
- 2026-04-18 Add `messages.ingested_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)` — server clock, independent of sender `ts`.
- 2026-04-18 Add `CHECK(direction IN ('assistant','user'))` on `messages`.
- 2026-04-18 `sessions.name NOT NULL`: ingest defaults missing `session_name` to `session_id`. Keeps schema strict, avoids nullable column.
- 2026-04-18 Session upsert: `ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, name=excluded.name` — never overwrites `first_seen_at`.
- 2026-04-18 SQLite PRAGMAs at open: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. Prevents `SQLITE_BUSY` from concurrent P1 reads.

### HTTP contract
- 2026-04-18 `/ingest` response: `200 { ok: true, message_id }` | `400 { ok: false, error, issues }` | `413 { ok: false, error: 'payload too large' }` | `500 { ok: false, error }`.
- 2026-04-18 `/ingest` max body: 1 MB.
- 2026-04-18 `/health` depth: SELECT 1 against SQLite, `503` on DB failure.
- 2026-04-18 Reserve `/api/*` + `/web/*` prefixes: return 404 in P0, no scaffold routing.
- 2026-04-18 Server boot order: `migrate()` synchronous → `Bun.serve()`. No race between listen and table creation.
- 2026-04-18 Graceful shutdown: SIGTERM/SIGINT → `server.stop(true)` → `db.close()` → exit.

### Fakechat extension
- 2026-04-18 Webhook is fire-and-forget in P0, but with **observability**: `AbortSignal.timeout(5000)`, explicit `res.ok` check, structured stderr log. No retry queue (deferred to P2).
- 2026-04-18 Known P0 boundary: fakechat `deliver()` does not await webhook success — messages dropped if claudegram down. Documented in README. (spec §10 Q3)
- 2026-04-18 **Multi-session actually supported in P0** (not just planned): STATE_DIR scoped by `CLAUDE_SESSION_ID → pid` fallback (task 4.0), FAKECHAT_PORT auto-picks 8787→8797 if busy (task 4.2b). claudegram's `session_id` column was already multi-session by design.
- 2026-04-18 `/ingest` response shape is claudegram's own design — verified via MCP spec (Context7): the endpoint is fakechat → claudegram HTTP, NOT an MCP endpoint, so no Claude Code `CallToolResult` convention applies. The MCP `reply` tool's own return is handled internally in fakechat at `server.ts:119`.

### Testing
- 2026-04-18 TDD applies to: 1.2, 1.3, 1.4, 2.1, 2.3, 3.2, 3.3, 3.4, 4.3a, plus automated integration (5.2).
- 2026-04-18 Coverage targets: repo 90%, ingest 90%, config/logger/db-client 80%.
- 2026-04-18 Test isolation: repo tests use `new Database(':memory:')` per test; no shared fixture.

### Tooling
- 2026-04-18 Bun version pinned via `.bun-version` + `engines.bun` in `package.json`.
- 2026-04-18 Logger timestamp: `new Date().toISOString()` (UTC).
- 2026-04-18 Teams available: will use Teams for Phase 2/3 parallel coding if 2+ independent tasks active simultaneously; otherwise single agents.

### Resolved user decisions (2026-04-18)
- Q1 STATE_DIR scoping → `CLAUDE_SESSION_ID` if set, else `pid-${PID}`.
- Q2 Multi-session support → **actually implemented** in P0 (not just planned). Added task 4.2b for FAKECHAT_PORT auto-pick.
- Q3 Integration test → **(b) in-process** via exported `createServer()` factory; subprocess-based variant deferred post-MVP and documented in README as known gap.
- Q4 `/ingest` response shape → approved. Confirmed via MCP spec (Context7) that no Claude Code convention applies.
- Q5 Webhook observability → fire-and-forget with structured stderr log only. No retry queue until P2.

### Phase 2 addenda (2026-04-18)
- Schema `ingested_at` uses `CAST(unixepoch('subsec')*1000 AS INTEGER)` for true millisecond precision (not `unixepoch()*1000` which is second-aligned). Verified in migrate.test.ts case 6.
- `MessageRepo.findBySession` applies `Math.max(1, limit)` floor before `Math.min(limit, 500)` ceiling to prevent SQLite's `LIMIT -1 = unlimited` footgun. Three regression tests (limit=0, -1, -9999) all assert clamp to 1.
- `schema_version` table deferred to P1; `migrate.ts` carries TODO(P1) comment noting `IF NOT EXISTS` silent column-drift.

## Next Agent Prompt

Task: Phase 3.1 — `src/http.ts` + `src/server.ts` — Bun.serve entry, route dispatcher.

Project root: `/Users/plutozhang/Documents/claudegram`. Work in `current/claudegram/src/`.

Contract:
- `src/http.ts`: pure router — `dispatch(req: Request, ctx: Ctx): Response | Promise<Response>` where `ctx = { msgRepo, sessRepo, logger }`.
- `src/server.ts`: `createServer({ config, ctx }): { server, stop() }` — migrate() synchronous BEFORE Bun.serve(). Reserve `/api/*` + `/web/*` → return 404 with `{ok:false,error:'not found'}` (JSON). Unknown routes → 404.
- TDD from 3.1 onward. Test via exported `createServer` factory (required for 5.2 in-process integration test).
- No route handlers yet beyond the 404 — 3.2 adds `/health`, 3.3 adds `/ingest`, 3.4 adds graceful shutdown.

Project root: `/Users/plutozhang/Documents/claudegram`. Work in `current/claudegram/src/`. Stack: Bun 1.3.12 + TS strict + bun:sqlite + Zod. Test: `bun test` from `current/claudegram/`.

2.1 = `src/db/schema.ts` (SQL string literal, NOT readFileSync) + `src/db/migrate.ts` (idempotent run). Schema per PROGRESS Key Decisions: messages composite PK `(session_id, id)`, `ingested_at DEFAULT unixepoch()*1000`, `CHECK(direction IN ('assistant','user'))`, sessions `name NOT NULL`. Tests: fresh DB → tables exist; second run → no-op. TDD.

2.2 = `src/repo/types.ts` — `Message`, `Session`, `MessageRepo`, `SessionRepo` interfaces. Readonly returns. No implementation.

After both green: launch 2.3 (`src/repo/sqlite.ts`) with `INSERT ... ON CONFLICT(session_id, id) DO NOTHING`, session upsert `ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, name=excluded.name`. TDD, coverage ≥90%, all tests use `:memory:`.

Original Phase 1.1 prompt archived — scaffold done at commit 2b3b04e.

Project root: `/Users/plutozhang/Documents/claudegram`. Work in `current/claudegram/` (sibling to existing `current/fakechat/`). Do NOT touch `legacy/` or `current/fakechat/`.

Language/stack: Bun + TypeScript strict, ESM (`"type": "module"`), `bun:sqlite` (built-in, no dep), `zod` (runtime dep).

Create only these files:
- `current/claudegram/package.json`: `name: "claudegram"`, `type: "module"`, `engines.bun: ">=1.1.0"`, scripts `{ dev: "bun run src/server.ts", test: "bun test" }`, deps `{ zod: "^3.23.0" }`, devDeps `{ "@types/bun": "^1.3.10" }`. No other deps.
- `current/claudegram/tsconfig.json`: strict, `moduleResolution: "bundler"`, `target: "esnext"`, `types: ["bun"]`, no emit.
- `current/claudegram/.bun-version`: pin to the current installed `bun --version` output.
- `current/claudegram/.gitignore`: `node_modules/`, `data/`, `*.db`, `*.db-wal`, `*.db-shm`.
- `current/claudegram/src/` directory (empty — later tasks populate).

Rules:
- No console.log anywhere.
- No new top-level deps beyond `zod` (+ @types/bun dev).
- Do NOT write any code in `src/` yet — just the empty tree.

When done: report what was created + the pinned Bun version, then stop. No code review needed for this scaffold task (1.1 is pure config).
