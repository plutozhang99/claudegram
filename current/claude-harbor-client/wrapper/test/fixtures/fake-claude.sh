#!/usr/bin/env bash
# Fake `claude` binary for wrapper tests. Prints each argv on its own line,
# prefixed with "ARG:", then exits 0. If FAKE_EXIT is set, exits with that
# code instead.
for a in "$@"; do
  printf 'ARG:%s\n' "$a"
done
exit "${FAKE_EXIT:-0}"
