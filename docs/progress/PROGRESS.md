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
<!-- empty -->


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
- [x] **P2.3** Session list screen — commit `73b4430` — flutter ✅ func ✅
  - `SessionListScreen` (ConsumerWidget) with loading (SkeletonList), error (RETRY invalidates + awaits `.future`), empty ("NO ACTIVE SESSIONS" + Courier command hint), data (RefreshIndicator + ListView.separated). Responsive 16/32/64 padding, max-width 960. AppBar "HARBOR".
  - `SessionTile` (StatelessWidget): project basename (`path.basename` w/ em-dash fallback on empty sessionId), model display, 12×12 zero-radius status dot (active/idle/ended/unbound palette) w/ Tooltip + Semantics for non-color indicator, context bar (kCream track + kMistralOrange fill, clamped 0..100), 5h/7d row from `session.rateLimits`, Courier cost (shows $0.00, hides on null). InkWell w/ `overlayColor` WidgetStateProperty (kCream hover/pressed/focused) and `customBorder` zero-radius so ink clips sharp. `ConstrainedBox minHeight: 72` for ≥48dp tap target. `Semantics(button: true)` + `MergeSemantics` content.
  - `SessionDetailPlaceholder` bridge until P2.4.
  - `SectionLabel` promoted to `lib/widgets/`; showcase keeps re-export.
  - Renamed `_skeleton_tile.dart` → `skeleton_tile.dart` (public API filename convention).
  - 71 tests pass (3 new: cost-zero, 5h/7d hidden, 5h/7d rendered). `flutter analyze` clean. No cool colors / bold weights / rounded corners; DESIGN.md compliance verified by reviewer grep.
- [x] **P2.2** Flutter data layer — commit `aa0c95d` — flutter ✅ sec ✅ func ✅
  - Immutable models (`Session`, `Message`, `Statusline`, `RateLimits`/`RateWindow`) with strict `fromJson` on required fields + defensive coercion on optional.
  - `HarborApiClient` (listSessions / getSession+counts / listMessages pagination / postChannelReply) with structured `Uri.replace`, 10 s timeout, `HarborApiException` truncating body.
  - `HarborLiveService` with `sealed HarborEvent` hierarchy (`SessionCreated|Updated|Ended`, `MessageCreated`, `StatuslineUpdated`, `SubscribedAck`, `ConnectionStateChanged`), exponential backoff 2→30 s with `_reconnectPending` debounce (reset ONLY after decoded+emitted event), 45 s heartbeat watchdog, malformed frames caught so subscription survives, unknown events logged.
  - `SessionRepository.watchList` merges REST with live events (created=upsert, updated=replace, ended=patch via injected clock, statusline=patch latest_*), re-fetches on reconnect to close ended-during-gap race, stable sort `latestStatuslineAt desc nulls-last, startedAt desc, sessionId desc`, cancel-during-init leak fixed.
  - `MessageRepository.watchInbox` filters `MessageCreated` by `sessionId`.
  - Riverpod providers: `harborBaseUri` (throws on non-http(s) scheme with override hint), `harborWsUri` (scheme swap + fragment clear), api client + live service with `unawaited()` start/stop, session/message repos, `sessionListProvider` / `sessionDetailProvider` / `messageInboxProvider`.
  - 51 tests pass, `flutter analyze` clean.
- [x] **P2.1** Flutter scaffold + Mistral theme — commit `e84123f` — flutter ✅ func ✅
  - `current/claude-harbor-frontend/` web-only Flutter 3.x, Riverpod 2.5 root, flutter_lints 6, SDK `>=3.4.0 <4.0.0`.
  - Mistral theme: 13 color tokens (`kMistralOrange`, `kMistralFlame`, `kBlockOrange`, `kSunshine900/700/500/300`, `kBlockGold`, `kBrightYellow`, `kWarmIvory`, `kCream`, `kMistralBlack`, `kInputBorder`), `mistralGoldenShadows` 5-layer amber cascade, `mistralLightTheme` with EVERY `ColorScheme` role pinned warm (secondary, tertiary, inverse*, shadow/scrim, outlineVariant, surfaceTint — no cool M3 seed leak), weight-400 TextTheme at 82/56/48/32/30/24/16/14, `fontFamily: 'Arial'`, `BorderRadius.zero` everywhere, dark-solid/cream/ghost button variants themed.
  - Diagnostic `PaletteShowcase` with 14 color swatches (Pure White border, dark swatches flip label to ivory), Mistral block gradient, golden-shadow card, button row. Responsive 24/64 padding via `LayoutBuilder`.
  - All text resolved via `Theme.of(context).textTheme` so Arial inherits. `Opacity` widgets replaced by `Color.withValues(alpha:)`.
  - `flutter analyze` clean, `flutter test` 1/1 pass. No cool colors, no bold weights, no rounded corners (verified by reviewer grep).
- [x] **P2.0** Server API prep — commit `c9b4e4d` — code ✅ sec ✅ func ✅
  - `GET /sessions`, `/sessions/:id`, `/sessions/:id/messages` with `PublicSessionRow` projection (channel_token stripped). Token remains only for `WS /channel` bind, `POST /channel/reply` constant-time auth, and `GET /admin/session/:id` (admin-gated).
  - `WS /subscribe` admin-gated, snapshot replay (100-row + 256 KiB cap), fans out `session.created|updated|ended`, `message.created`, `statusline.updated` via in-process `EventBus` with 32-subscriber cap and 1 MB per-socket backpressure close.
  - Static serve at `/` with SPA fallthrough and CSP/nosniff/referrer-policy HTML headers; JSON stub when bundle missing.
  - CORS: disabled by default; `HARBOR_DEV=1` + loopback → GET-only, specific-origin (no `*`), `content-type` allow-header only.
  - `start()` refuses non-loopback bind without `HARBOR_ADMIN_TOKEN` (escape hatch: `HARBOR_ALLOW_UNSAFE_BIND=1`). `pending` map capped at 1000 with oldest-eviction warn. `getMessageById` scoped by session_id. `requireJsonContentTypeIfPresent` on statusline/reply/admin POSTs.
  - Tests: 139 pass / 0 fail, tsc clean. Round-1 security BLOCK on C1 (channel_token leak) closed in round-2.

## Next Steps
- [ ] **P2.4** Session detail screen (two-pane responsive chat + metadata)
- [ ] **P2.5** Build integration + smoke test
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
> **P2.3 RESUME — re-dispatch reviewers.** P2.3 session list screen is implemented and on disk at `current/claude-harbor-frontend/` but uncommitted (see "P2.3 IMPL DONE" block above for the file list). 68/68 tests pass, `flutter analyze` clean. Both previous parallel reviewers (flutter-reviewer + functional-coverage) hit quota before producing output.
>
> Re-run the two reviewers in parallel (opus for flutter-reviewer, sonnet for functional-coverage). Briefs are in the prior turn of this conversation, but if restarting fresh, the essentials:
> - **flutter-reviewer (opus):** DESIGN.md compliance blockers (cool colors / bold weights / rounded corners / inline TextStyle bypassing Arial), Flutter idioms (ConsumerWidget vs StatefulWidget, ref.invalidate vs ref.refresh on StreamProvider, RefreshIndicator wiring, path.basename safety, InkWell hover cleanup), null-safety (substring guard when sessionId < 8 chars), a11y (Semantics on status dot + tile), tests pattern (overrideWith on sessionListProvider). Files: `lib/main.dart`, `lib/screens/session_list_screen.dart`, `lib/screens/session_detail_placeholder.dart`, `lib/screens/sessions/{session_tile,_skeleton_tile}.dart`, `lib/widgets/section_label.dart`, plus the 2 new test files. Output severity-ranked findings with verdict PASS | PASS-with-MEDIUM | BLOCK.
> - **functional-coverage (sonnet):** per-deliverable checklist from the P2.3 block in this file: main.dart home swap, AppBar title, loading/error/empty/data branches, responsive padding, session tile (title/model/status dot/ctx bar/5h-7d/cost/hover/border), skeleton tile, detail placeholder, 2 test files, pubspec path dep.
>
> After reviews: consolidate findings into one fix pass (opus), run narrow round-2 re-check, commit with haiku, then proceed to P2.4.
>
> --- (historical P2.1 implementation prompt preserved for archival) ---
>
> **P2.1 — Flutter scaffold + Mistral theme.** Initialize a new Flutter project at `current/claude-harbor-frontend/` (web target first; mobile platforms wait for P4). Read `docs/plans/PLAN-claude-harbor.md` §9 P2, `docs/DESIGN.md` (full — it is binding), and `docs/progress/PROGRESS.md` "P2.1" spec. No data layer yet (P2.2), no screens yet (P2.3), no build integration yet (P2.5).
>
> Deliverables:
> - `flutter create --platforms=web --org dev.harbor claude-harbor-frontend` at `current/claude-harbor-frontend/`. Remove scaffolded iOS/Android/macOS/linux/windows dirs — web-only for now.
> - `pubspec.yaml`: Flutter SDK constraint `>=3.22.0`, dart `>=3.4.0`, add `flutter_riverpod: ^2.5.1` as only app dep. Dev: `flutter_lints: ^4.0.0`.
> - `lib/theme/mistral_theme.dart` exporting a `ThemeData mistralLightTheme` with Material 3 seeded from `Color(0xFFfa520f)` then overridden:
>   - ColorScheme: primary `#fa520f`, onPrimary `#ffffff`, surface `#fffaeb` (Warm Ivory), onSurface `#1f1f1f`, surfaceContainer `#fff0c2` (Cream), outline `hsl(240,5.9%,90%)`.
>   - Scaffold bg `#fffaeb`. `useMaterial3: true`.
>   - `TextTheme` with weight 400 everywhere: display 82px / letterSpacing -2.05 / height 1.00; headline 56/48/32; title 30/24; body/label 16px @ 1.5; caption 14px @ 1.43.
>   - Button styling: sharp corners (`RoundedRectangleBorder(BorderRadius.zero)`), no elevation on ElevatedButton, dark solid variant (`#1f1f1f` bg, white text, 12px padding), cream variant (`#fff0c2` bg, black text).
>   - CardTheme with `BorderRadius.zero`, background `#fffaeb`, and a 5-layer golden shadow (tokens exposed as `mistralGoldenShadows` list, since Flutter's BoxShadow doesn't chain the way CSS does — consumer code picks the outermost layer or composes multiple BoxShadows in a Container).
>   - Export const tokens: `kMistralOrange`, `kMistralFlame`, `kMistralBlack`, `kWarmIvory`, `kCream`, `kSunshine700`, `kBrightYellow`, etc.
> - `lib/main.dart` bootstraps `ProviderScope(child: MaterialApp(theme: mistralLightTheme, home: const PaletteShowcase()))`. No routing yet.
> - `lib/screens/palette_showcase.dart` — a diagnostic Scaffold rendering: (1) color swatch row (all 11 named tokens with hex labels), (2) Mistral block gradient row (yellow→amber→orange→flame→mistral orange, sharp corners, no gaps), (3) one card with the golden shadow showcasing a 32px title + 16px body, (4) all three button variants (dark solid, cream surface, ghost). This is the visual check that the theme is wired.
> - `analysis_options.yaml` extending `package:flutter_lints/flutter.yaml`; set `prefer_const_constructors: true`.
> - `test/theme_test.dart` — one smoke test: instantiates `MaterialApp(theme: mistralLightTheme, home: const PaletteShowcase())`, pumps, and asserts at least one `Text` widget renders. (Ensures the theme compiles and doesn't crash.)
> - Add `current/claude-harbor-frontend/.gitignore` with standard Flutter ignores (build/, .dart_tool/, .flutter-plugins*, ephemeral, etc).
>
> Constraints:
> - NO cool colors (blue/green/purple). NO bold weight (>400). NO rounded corners (all radii = 0).
> - Font: use system Arial stack via `TextTheme.fontFamily: 'Arial'` with fallback — no custom font asset yet.
> - All new files ≤400 lines.
> - No screens or models beyond the showcase. No API client. No WS. No routing.
> - Do NOT `flutter run` — just ensure `flutter analyze` is clean and `flutter test` passes.
> - Do NOT touch the server, installer, wrapper, hook binary, statusline binary, or MCP proxy.
>
> Acceptance:
> - `cd current/claude-harbor-frontend && flutter analyze` — no warnings/errors.
> - `flutter test` — at least the one smoke test passes.
> - Report: files created, pubspec deps, `flutter analyze` output, `flutter test` output, any deviations from spec.
>
> After you finish, orchestrator runs flutter-reviewer + security-reviewer (minimal for a scaffold) + functional-coverage in parallel, fixes findings, then commits with haiku.
>
> --- (historical P2.0 implementation prompt preserved for archival) ---
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
