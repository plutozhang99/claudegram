## Project: Frontend CSP Fix (self-host CanvasKit + drop Roboto CDN)

## Spec Files
- Verbal: Frontend console errors — CSP blocks `gstatic.com/flutter-canvaskit/*` (CanvasKit JS/WASM) and `fonts.gstatic.com/*` (Roboto woff2). Dev harness: `./dev.sh`. Fix by self-hosting (Plan A).

## Plan File
- Inline below (small fix, no separate PLAN-*.md).

## Project Structure
- `scripts/build-frontend.sh` — runs `flutter build web --release --base-href /`
- `scripts/dev.sh` — calls build-frontend.sh then starts Bun server
- `current/claude-harbor-frontend/` — Flutter web app (lib/, web/, pubspec.yaml)
- `current/claude-harbor-server/src/http-static.ts:251` — CSP: `connect-src 'self' ws: wss:; ...; script-src 'self' 'wasm-unsafe-eval'`
- Build output: `current/claude-harbor-frontend/build/web/` (contains `canvaskit/` locally already)

## DESIGN.md
- Yes — `docs/DESIGN.md`. Typography: Arial + system-ui stack. NOT Roboto. All UI changes must follow it.

## Current Phase: csp-fix

## Interruption Reason
<!-- empty -->

## Review Roster (fixed at kickoff)
- Code Review: typescript-reviewer (for build-frontend.sh + any ts) + flutter-reviewer (for Dart changes)
- Security Review: security-reviewer (CSP posture, no CDN re-enable)
- Functional Coverage: functional-coverage (rebuild + console clean + app renders)

## What's Done
- [x] T1+T2+T3: `scripts/build-frontend.sh` now passes `--no-web-resources-cdn`; rebuild produces local `build/web/canvaskit/{canvaskit.js,canvaskit.wasm}` (7.1 MB wasm). `flutter_bootstrap.js` has `"useLocalCanvasKit":true`; gstatic URL is a dead ternary branch (no runtime fetch). `fontFamily: 'Arial'` was already in `lib/theme/mistral_theme.dart:256` and propagates cleanly through theme. — code ✅ sec ✅ func ✅ — commit [pending]
- [x] T4+T5: Reviews done. Server runtime verified: `GET /` → 200 + strict CSP; `GET /canvaskit/canvaskit.wasm` → 200 `application/wasm`.

## Next Steps
- [ ] F1 (follow-up, needs user decision): Flutter's fontFallbackManager still embeds `https://fonts.gstatic.com/s/` for missing-glyph fallback (CJK/emoji/extended Latin). With strict CSP this will render tofu for non-Latin user content. Options: (a) bundle local Noto fallback font(s); (b) allowlist `fonts.gstatic.com` in CSP font-src/connect-src (breaks internal-net posture); (c) accept Latin-only rendering.

## Notes / Gotchas
- `lockdown-install.js` SES warnings are from browser extensions (MetaMask/etc) — not our code. Ignore.
- Do NOT relax CSP to allow `www.gstatic.com` / `fonts.gstatic.com`; preserving internal-net same-origin posture is a project invariant.
- Flutter 3.41+ removed `--web-renderer`; renderer is per-platform auto.
- `--no-web-resources-cdn` is a `flutter build web` flag that rewrites `flutter_bootstrap.js` to load CanvasKit from app's own `canvaskit/` path.
- For Dart font change: look for `MaterialApp` / `ThemeData` in `lib/main.dart` or a theme file; set `fontFamily: 'Arial'`. Arial exists as a system font in all major browsers; Flutter Web will resolve it via the browser without a network fetch.

## Next Agent Prompt
<!-- T1+T2 combined brief below, dispatched to opus coder -->

## Orchestrator Rules (for future sessions)
On restart, still follow:
1. Orchestrator only — never write code/docs yourself
2. After every sub-agent delivery, run code + security + functional reviews, then have a sub-agent fix all findings
3. Commit as soon as a task clears review — do not wait for the user
4. Auto-advance until the context window is near its limit; no need to ask for approval each step
5. Keep PROGRESS.md live
6. When all tasks are done, move PROGRESS.md to docs/archive/PROGRESS-[name]-[YYYYMMDD].md
