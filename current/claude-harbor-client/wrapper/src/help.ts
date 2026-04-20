/**
 * Usage text for `claude-harbor --help`.
 *
 * Kept short (<= 15 lines of body) per the P0.3 spec. `--help` and
 * `--version` go to stdout because the user asked for that text; all other
 * wrapper diagnostics go to stderr.
 */

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export const HELP_TEXT: string = `claude-harbor ${VERSION} — Claude Code wrapper for the harbor aggregator

Usage:
  claude-harbor start [...args]    Prepends --channels plugin:claude-harbor@local before [...args],
                                   then execs claude. If you pass your own --channels flag or set
                                   HARBOR_NO_CHANNEL=1, no --channels is injected.
  claude-harbor --version, -v      Print version and exit
  claude-harbor --help, -h         Show this help

Environment:
  HARBOR_URL             Harbor server base URL (forwarded to the channel proxy).
  CLAUDE_BIN             Absolute path to the 'claude' executable (overrides PATH).
  HARBOR_CHANNEL_SPEC    Override plugin:<name>@<marketplace> (default above).
  HARBOR_NO_CHANNEL=1    Skip injecting --channels (useful for raw-claude debugging).

Example:
  HARBOR_URL=http://localhost:7823 claude-harbor start --model sonnet
`;
