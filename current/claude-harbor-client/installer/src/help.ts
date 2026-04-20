/** Help + version strings for the installer CLI. */

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export const HELP_TEXT: string = `claude-harbor-install ${VERSION} — wire ~/.claude/settings.json for claude-harbor

Usage:
  claude-harbor-install install [--dry-run] [--harbor-url <url>] [--home <path>]
                                 Install hook, statusline and channel-plugin
                                 entries into settings.json. Idempotent.
  claude-harbor-install uninstall [--dry-run] [--home <path>]
                                 Remove the entries previously installed.
  claude-harbor-install --version, -v
  claude-harbor-install --help, -h

Flags:
  --dry-run        Print the planned diff and exit without writing.
  --harbor-url URL Default harbor server URL (recorded in the sidecar for
                   your reference; hook/statusline binaries read HARBOR_URL
                   from env at runtime).
  --home PATH      Override \$CLAUDE_HOME (defaults to ~/.claude). Useful
                   for tests and non-default installations.

Notes:
  A backup of settings.json is created as settings.json.bak-<ISO> once,
  on the first install run. A sidecar claude-harbor-installed.json records
  the exact entries written so uninstall can revert them precisely.
`;
