## Project: claudegram pre-P3 hotfix round 2 — channel gating + observability

## Spec Files
- docs/archive/issue_fix_before_p3-2026-04-19.md (original spec, archived)
- docs/archive/PROGRESS-PRE-P3-2026-04-19.md (round 1 archive)

## Current Phase: Phase A.2 — hotfix (COMPLETE)

## Interruption Reason


## Rate Limit State


## Review Roster (Phase 0 设定，项目中途不变)
固定:
- Slot 1 Code Review: typescript-reviewer
- Slot 2 Security Review: security-review skill
- Slot 3 Functional Coverage: functional-coverage skill
条件性:
- Slot 4 DB Review: database-reviewer
- Slot 6 Type Review: type-design-analyzer
- Slot 7 Error Review: silent-failure-hunter

## Active Task
None — all hotfixes complete.

## Completed Tasks (this round)
- [x] F1: `channels` field required in register frame; fakechat sends `['plugin:fakechat@claude-plugins-official']`; claudegram rejects registers without it. Old fakechat clients are schema-rejected BEFORE upsert so no ghost session rows are created.
- [x] F2: info-level logging in statusline route (`statusline_no_cwd_match` on unmatched cwd, `statusline_routed` on successful broadcast) so users can diagnose "why no ctx-window bars" without a debugger.
- [x] F3: `DELETE /api/sessions?offline=true` bulk-delete endpoint + "Clear offline" sidebar button so historical ghost rows can be swept in one call.

## Pending Tasks
None.

## Review Log
| Task | Code Review | Security | Functional | Rounds | Result |
|------|------------|---------|------------|--------|--------|
| F1   | PASS       | PASS    | PASS       | 1      | ✅ COMPLETE |
| F2   | PASS       | PASS    | PASS       | 1      | ✅ COMPLETE |
| F3   | PASS       | PASS    | PASS       | 1      | ✅ COMPLETE |

## Investigation — why round 1 was insufficient

User report (2026-04-19): after deploying round 1 fixes, claudegram still shows
multiple "connected: true" sessions cycling every 60s, plus 5 historical
"connected: false" ghost rows, plus no statusline bars.

**Root cause analysis (from the bun run dev log):**

The log showed this cycle repeating exactly every 60s per session:
```
session_socket_registered 01KPKVRK...
  (60s pass)
session_socket_closed 01KPKVRK...
  (≤1s pass)
session_socket_registered 01KPKVRK...
```

Mapping this to our code: the heartbeat polls every 20s and closes when
`Date.now() - lastPong > 45_000`. With no pong ever arriving, the third tick
(T=60s) is the first one where the condition is true. So a 60s register→close
cycle is *exactly* the signature of a fakechat client that never responds to
the server's ping frame.

Why no pong? Because the user's Claude Code sessions had been started BEFORE
round 1 landed, so their fakechat MCP subprocesses were still running the
pre-round-1 code:
- no pong handler
- no lazy-start (connect is eager)

Round 1's T2 lazy-start only works for NEW fakechat processes. It can't retroactively fix fakechats already running in older Claude Code instances.

The 5 offline rows are the accumulated shrapnel from multiple previous
Claude Code sessions that registered and then exited over the past weeks.
They were never pruned.

The missing statusline bars are a separate, orthogonal issue: no POST was
hitting `/internal/statusline` at all during the session. That endpoint
was silent on the happy path, so there was no way to tell whether requests
were arriving and missing the cwd match versus never arriving in the first
place.

## Key Decisions & Accepted Risks

### F1 — channels field at schema level

Register frame schema now requires a non-empty `channels: string[]` field;
additionally, the `FAKECHAT_CHANNEL` marker must be present in the array.

**Why at schema level (not just a handler check):** old clients omit the
field entirely, so zod fails the discriminated-union parse. This gives us a
single rejection path (`invalid_payload`) that fires BEFORE upsert, so the
DB is never touched for non-fakechat registers. Pre-existing ghost rows are
untouched (handled by F3).

**Fakechat always sends the field** — it's a channel-capable plugin by
construction; the fact that it's running at all inside Claude Code's MCP
subprocess tree implies it's registered as a channel server, so the marker
is always correct.

**Interaction with T2 (lazy-start):**
- New fakechat + channels active → deliver/reply triggers connect → register with channels array → accepted
- New fakechat + no channels → never connects (T2 lazy-start) → no register ever
- Old fakechat (any) → connects eagerly → sends register WITHOUT channels → zod-rejected, no upsert
- The 60s cycle continues for old clients (reconnect loop) but produces no DB rows and no ghost sessions in the API response.

### F2 — statusline observability

Two new info-level log entries:
- `statusline_no_cwd_match` — a POST arrived but cwdRegistry doesn't have that cwd. Strong hint that fakechat is out of sync with Claude Code's statusline cwd field, or that fakechat hasn't registered yet.
- `statusline_routed` — successful broadcast with session_id, model, ctx_pct. Makes the happy path visible without needing debug-level logging.

### F3 — bulk-delete endpoint

`DELETE /api/sessions?offline=true` iterates `sessRepo.findAll()` and deletes
every session that is NOT in `sessionRegistry`. Unscoped `DELETE /api/sessions`
(without the query param) returns 400 to prevent accidental mass-deletion.

Each deleted row broadcasts `session_deleted` so connected PWAs update
reactively. UI button ("Clear offline") in the sidebar header calls the
endpoint after a confirmation prompt.

### Accepted risks

**Old fakechat reconnect loop wastes bandwidth.** Old clients now register →
get invalid_payload → connection stays open → heartbeat times out at 60s →
connection closes → old client reconnects → repeat. This is noisy in the
log but produces no ghost sessions. The correct fix for the loop is for the
user to restart their old Claude Code instances, which will pick up the new
fakechat code. We don't forcibly close on schema failure because schema
errors can also be transient in principle.

**No auto-detection of `--channels` from fakechat side.** Fakechat always
sends the fakechat channel marker whenever it does connect. It does NOT
inspect whether `--channels plugin:fakechat@claude-plugins-official` is
actually on; that's what T2's lazy-start covers. This is pragmatic because
MCP doesn't expose channel-subscription info to the server cleanly.

## Tests added
- `session-socket.test.ts`: register without channels → invalid_payload, no upsert, no registry call
- `session-socket.test.ts`: register with wrong channel → invalid_payload + ws.close(1008) + warn log
- `claudegram-client.test.ts`: register frame includes `channels: ['plugin:fakechat@claude-plugins-official']`
- `sessions.test.ts`: bulk-delete deletes only offline rows
- `sessions.test.ts`: bulk-delete broadcasts session_deleted per row
- `sessions.test.ts`: unscoped bulk DELETE → 400

## Test totals
- claudegram: 369 pass / 1 skip / 0 fail (was 365; +4 new)
- fakechat: 48 pass / 0 fail (existing test updated, no new)

## What the user should do to see the fix

1. **Pull + restart claudegram** (`bun run dev`). My changes in session-socket.ts and statusline.ts take effect.
2. **Click "Clear offline" in the sidebar header** to sweep the 5 historical ghost rows.
3. **Restart Claude Code** (close all windows, start fresh). Each new fakechat subprocess will pick up the new lazy-start + channels field code.
   - Old Claude Code windows left open will keep reconnect-looping every 60s but will NOT create ghost sessions anymore.
4. **For statusline bars** — check the claudegram server log after a few seconds of Claude Code activity:
   - No entries → Claude Code's statusline hook isn't configured to POST to `http://localhost:PORT/internal/statusline`. Add a statusline command to `~/.claude/settings.json` that pipes its stdin JSON to `curl -X POST http://localhost:PORT/internal/statusline -d @-`.
   - `statusline_no_cwd_match` entries → cwd mismatch. The hook is hitting claudegram but fakechat hasn't registered that cwd. Trigger any user/assistant message in fakechat first so fakechat connects.
   - `statusline_routed` entries → happy path; bars should appear in the compose area for the matching session.

## Next Agent Prompt
Phase A.2 complete. Ready to commit + archive.
