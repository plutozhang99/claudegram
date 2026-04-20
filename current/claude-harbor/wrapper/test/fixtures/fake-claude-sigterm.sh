#!/usr/bin/env bash
# Fake `claude` that traps SIGTERM, writes a marker file, then exits.
# Usage: MARKER=/tmp/foo ./fake-claude-sigterm.sh [args...]
#
# Prints `READY` on stdout AFTER the trap is installed so the test can
# deterministically wait for the trap to be live before sending SIGTERM —
# avoids racy sleep-based timing.
MARKER="${MARKER:?MARKER env var required}"
trap 'echo sigterm > "$MARKER"; exit 143' TERM
printf 'READY\n'
# Sleep long enough that the test has time to send SIGTERM. Use a poll
# loop instead of `sleep N` so signals are delivered promptly on macOS.
for _ in $(seq 1 200); do
  sleep 0.1 &
  wait $!
done
exit 0
