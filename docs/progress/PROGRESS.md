## Project: Claudegram

## Spec Files
- docs/PRD.md

## Current Phase: Phase 1E — Promote bot/ workspace + .env config (blocks 2A/3A)

## Interruption Reason


## Rate Limit State


## Review Roster (set in Phase 0, do not change mid-project)
固定:
- Slot 1 Code Review: typescript-reviewer agent
- Slot 2 Security Review: security-review skill
- Slot 3 Functional Coverage: functional-coverage skill
条件性 (激活的才列出):
- Slot 6 Type Review: type-design-analyzer agent (TypeScript project)
- Slot 7 Error Review: silent-failure-hunter agent (activated by default)

Teams: available

## Active Task
Phase 1E — Promote grammy/bot to its own workspace `bot/` + add zod-validated env config to daemon
Sub-task progress: not yet started
Relevant files: bot/ (NEW workspace), bot/package.json (NEW), bot/tsconfig.json (NEW), bot/src/index.ts (NEW stub), daemon/package.json (remove grammy), daemon/src/config.ts (NEW zod schema), daemon/src/index.ts (call config.parse on boot), .env.example (NEW), package.json (workspaces)

## Completed Tasks
- [x] Phase 1A: Bun workspace scaffolding + shared TypeScript types — commit: 0066cde — code ✅ sec ✅ func ✅ type ✅ err ✅
- [x] Phase 1B: Daemon HTTP server + PID lock + health check + session registry — commit: 35728e4 — code ✅ sec ✅ func ✅ type ✅ err ✅
- [x] Phase 1C: Decision queue with TTL + long-polling endpoint — commit: 3433d51 — code ✅ sec ✅ func ✅ type ✅ err ✅
- [x] Phase 1D: Cross-component contracts + typed events + AbortSignal cleanup — commit: ecfb9d8 — code ✅ sec ✅ func ✅ type ✅ err ✅

## Pending Tasks (prioritized)
- [ ] Phase 1E: Promote bot/ workspace; daemon zod-validated config from .env [BLOCKING for 2A/3A]
- [ ] Phase 2A: Channel Server MCP stdio + claude/channel/permission + session-scoped yes_all allowlist [READY after 1E — parallel with 3A]
- [ ] Phase 3A: grammy bot in bot/ workspace + 3-button inline keyboard + permission message formatting [READY after 1E — parallel with 2A]
- [ ] Phase 2B: Permission relay (notification receive → daemon POST → long-poll → verdict) [parallel with 3B]
- [ ] Phase 3B: callback_query handling (queue.answer + edit message to "Answered: X") [parallel with 2B]
- [ ] Phase 2C: Auto-register via CLAUDEGRAM_SESSION_NAME, auto-deregister on shutdown
- [ ] Phase 3C: Bot commands (/sessions, /pending, /cancel, /cancel_all)
- [ ] Phase 2D: Unit tests for queue + registry (clears LOW risk before E2E)
- [ ] Phase 4A: E2E test with real Claude Code sessions
- [ ] Phase 4C: Graceful shutdown + error recovery (cancel pendings → notify Telegram → deregister → release PID)
- [ ] Phase 4D: launchd plist + CLI (start/stop/status/configure)

## Deferred to v0.2
- [ ] Phase 4B: Atomic JSON state persistence (architect review: pending decisions cannot survive restart due to TTL state loss; sessions reference dead processes — moved out of v0.1)

## Review Log
| Task | Code Review | Security | Functional | Type | Error | Rounds | Result |
|------|------------|---------|------------|------|-------|--------|--------|
| Phase 1A | PASS | PASS | PASS | PASS | PASS | 2 | ✅ COMPLETE |
| Phase 1B | PASS | PASS | PASS | PASS | PASS | 2 | ✅ COMPLETE |
| Phase 1C | PASS | PASS | PASS | PASS | PASS | 2 | ✅ COMPLETE |
| Phase 1D | NITS→PASS | FINDINGS→PASS | PASS | TIGHTEN→STRONG | FINDINGS→PASS | 2 | ✅ COMPLETE |

## Key Decisions & Accepted Risks
- 2026-04-16 Decision: Two-component split (Daemon + Channel Server). Daemon is singleton holding grammy bot; Channel Server is per-session MCP stdio. Rationale: Telegram Bot API only allows one getUpdates consumer per token.
- 2026-04-16 Decision: Session registration via CLAUDEGRAM_SESSION_NAME env var (auto on startup), not MCP tool.
- 2026-04-16 Decision: HTTP long-polling for GET /api/decisions/:id (blocks until answered or 30s timeout).
- 2026-04-16 Decision: Separate TTL — unanswered expiry (5min), answered result retention (+30s). Rationale: prevents race between Telegram callback and channel server poll.
- 2026-04-16 Decision: Atomic JSON writes (write temp → rename).
- 2026-04-16 Decision: Daemon includes PID lock — atomic O_EXCL open, EPERM/ESRCH/NaN handling.
- 2026-04-16 Decision: F3 (custom decisions) deferred to v0.2; keep `type: DecisionType` discriminator in API for forward compat.
- 2026-04-16 Decision: Phases 2 and 3 run in parallel after Phase 1D+1E complete.
- 2026-04-16 Decision: moduleResolution: Bundler + module: Preserve (Bun-compatible).
- 2026-04-16 Decision: Session idle state derived at query time from lastActiveAt (not stored as status field).
- 2026-04-16 Risk accepted (MEDIUM): acquirePidLock uses recursion with no depth limit. Accepted: localhost-only daemon on user's own filesystem; adversarial filesystem scenario out of scope for v1.
- 2026-04-16 Decision: touch() must be wired in Phase 1C (on decision create/poll) to update session lastActiveAt. ✅ done.
- 2026-04-16 Risk closed: No unit tests for Phase 1C queue/routes — addressed by Phase 2D (NEW).
- 2026-04-16 Decision: MAX_POLLERS_PER_REQUEST=5 cap on concurrent long-poll connections per requestId. Returns current state immediately when cap reached.
- 2026-04-16 Decision (architect): Phase 4B atomic persistence moved from v0.1 to v0.2.
- 2026-04-16 Decision (architect): F2 three buttons restored via session-scoped allowlist in Channel Server (Set<PermissionCategory>).
- 2026-04-16 Decision (architect): Phase 1D added shared/protocol.ts with PERMISSION_OPTION_IDS, PERMISSION_CATEGORIES, CALLBACK_DATA_PREFIX, encode/parseCallbackData (Result-returning after Round 1 fix; UTF-8 byte budget; UUID-validated requestId).
- 2026-04-16 Decision (architect): DecisionQueue exposes typed EventEmitter (created/answered/expired/cancelled); _emit wraps emit in try/catch so listener throws never crash daemon.
- 2026-04-16 Decision (architect): Long-poll route wires AbortSignal with leak-free cleanup (settled flag + detachAbort across all resolution paths).
- 2026-04-16 Decision (architect): Phase 1E promotes bot to its own workspace `bot/`; grammy dep moves out of daemon/package.json. Daemon adds zod-validated config from Bun's built-in .env loader (fail-fast at boot).
- 2026-04-16 Decision (architect): Phase 2D adds queue+registry unit tests before Phase 4A E2E.
- 2026-04-16 Decision: env var names — TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWLIST (comma-separated user IDs), CLAUDEGRAM_PORT (default 3582), CLAUDEGRAM_DAEMON_URL (default http://localhost:3582). User configures via .env.example template (created in Phase 1E).
- 2026-04-16 Decision: bot ↔ daemon coupling — in-process EventEmitter on DecisionQueue (not HTTP, not polling). Bot subscribes to 'created' to send Telegram messages, holds Map<RequestId, {chatId, messageId}> for callback_query lookup.
- 2026-04-16 Decision: Phase 3B grammy middleware order — (1) allowlist filter → (2) idempotency dedup (60s in-memory cache of callback_query.id) → (3) decision-state check via queue.answer() returning VALIDATION_ERROR.
- 2026-04-16 Decision: Phase 4C graceful shutdown order — close HTTP server → cancel all pendings (emits 'cancelled' event → bot edits messages) → wait ≤2s for Telegram edits → bot.stop() → queue.destroy() → release PID lock → exit(0).
- 2026-04-16 Decision (Phase 1D Round 1): MutableDecision is now a discriminated union mirroring Decision; state transitions use explicit field construction (not spread) to satisfy variant narrowing.
- 2026-04-16 Decision (Phase 1D Round 1): MAX_TTL_SECONDS=3600 clamp inside queue.create() as defense-in-depth (route layer also enforces zod max).
- 2026-04-16 Decision (Phase 1D Round 1): @claudegram/shared package is Bun-only — no compiled dist/index.js. package.json exports has 'bun' condition pointing at source TS; documented in package.json '//' field. If a Node consumer is ever needed, build dist and switch 'default'.
- 2026-04-16 Note (deferred to Phase 3B/2D test): _resolvePollers has an early-return if decision missing from map — unreachable in normal flow but worth a unit test.

## Next Agent Prompt
Project: Claudegram at /Users/plutozhang/Documents/claudegram
Language: TypeScript, Bun runtime
Task: Phase 1E — Promote bot to its own workspace `bot/` + add zod-validated env config to daemon. Blocking prerequisite for Phase 2A/3A.

Files to create/modify:
1. CREATE bot/package.json:
   - name: "@claudegram/bot"
   - private: true
   - type: "module"
   - main / exports pointing to src/index.ts (Bun-only, mirror shared/package.json pattern)
   - dependencies: grammy (latest), @claudegram/shared (workspace:*)
   - devDependencies: typescript, @types/node, bun-types
2. CREATE bot/tsconfig.json — extend root tsconfig, composite: true, outDir dist, references to shared
3. CREATE bot/src/index.ts — minimal stub: export `startBot(queue, registry, config)` async function that returns a typed handle (start/stop). Bot internals come in Phase 3A; for 1E just create a stub that imports grammy Bot, exposes typed signatures, and exits cleanly. Must compile.
4. UPDATE root package.json — add "bot" to workspaces array
5. UPDATE daemon/package.json — REMOVE grammy from dependencies (it now lives in bot/). Add @claudegram/bot as workspace dep ("@claudegram/bot": "workspace:*"). Add zod ("^3.x") if not already present.
6. CREATE daemon/src/config.ts — zod schema:
   ```
   const ConfigSchema = z.object({
     TELEGRAM_BOT_TOKEN: z.string().min(1),
     TELEGRAM_ALLOWLIST: z.string().transform(s => s.split(',').map(p => Number(p.trim()))).pipe(z.array(z.number().int().positive()).min(1)),
     CLAUDEGRAM_PORT: z.coerce.number().int().min(1).max(65535).default(3582),
     CLAUDEGRAM_DAEMON_URL: z.string().url().default('http://localhost:3582'),
   })
   export type Config = z.infer<typeof ConfigSchema>
   export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config
   ```
   loadConfig: parse env via ConfigSchema; on failure, log a clear human-readable message listing missing/invalid vars then process.exit(1). Do NOT throw — fail fast at boot.
7. UPDATE daemon/src/index.ts — call `loadConfig()` BEFORE acquirePidLock or any other startup work. Pass config object to subsequent setup. (Bot start integration comes in Phase 3A — for 1E just call loadConfig, log "config loaded" stderr line, continue with existing startup.)
8. CREATE .env.example at project root — template with all 4 vars, comments explaining each:
   ```
   # Telegram bot token from @BotFather (https://t.me/BotFather)
   TELEGRAM_BOT_TOKEN=

   # Comma-separated Telegram user IDs allowed to interact with the bot
   # (find your ID by messaging @userinfobot)
   TELEGRAM_ALLOWLIST=

   # Daemon HTTP port (default 3582)
   CLAUDEGRAM_PORT=3582

   # Daemon base URL for channel servers to connect to (default http://localhost:3582)
   CLAUDEGRAM_DAEMON_URL=http://localhost:3582
   ```
9. UPDATE .gitignore to ensure `.env` (without `.example`) is ignored — verify if not already.

Run:
- `bun install` — must succeed (grammy will be downloaded into bot/node_modules via .bun)
- `bunx tsc -b` — must pass with zero errors across all 4 workspaces (shared, daemon, channel-server, bot)
- Test config loader: `cd /Users/plutozhang/Documents/claudegram && TELEGRAM_BOT_TOKEN=test TELEGRAM_ALLOWLIST=12345 bun -e "import('./daemon/src/config').then(({loadConfig}) => console.log(loadConfig()))"` — should print parsed config
- Test config rejection: `cd /Users/plutozhang/Documents/claudegram && bun -e "import('./daemon/src/config').then(({loadConfig}) => loadConfig())"` — should exit 1 with error message about missing TELEGRAM_BOT_TOKEN

Constraints:
- No `any` types; immutable updates; Result<T> pattern for fallible code
- Bot stub must export typed signatures so Phase 3A can fill in implementation without breaking imports
- Config errors must list ALL invalid fields (use ZodError.errors), not just the first one
- Don't import bot from daemon/src/index.ts yet (Phase 3A wires the actual bot startup) — but daemon must successfully build with @claudegram/bot as a dep
- Don't commit — orchestrator handles git after reviews pass

Output (your final report):
- Files created (paths)
- Files modified (paths + 1-line description each)
- Bot stub public API signature
- Config loader: error message format on failure (sample output)
- bunx tsc -b result
- Both env tests above: success/failure outputs
