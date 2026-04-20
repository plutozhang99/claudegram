#!/usr/bin/env bun
/**
 * claude-harbor-install CLI entrypoint.
 *
 * Usage:
 *   claude-harbor-install install   [--dry-run] [--harbor-url URL] [--home DIR]
 *   claude-harbor-install uninstall [--dry-run] [--home DIR]
 *   claude-harbor-install --version, -v
 *   claude-harbor-install --help, -h
 *
 * Exits:
 *   0 on success (including `--dry-run`).
 *   1 on config error (malformed settings.json, malformed sidecar, etc.).
 *   2 on CLI usage error (unknown command/flag, missing value).
 */

import { parseArgs } from "./argv.ts";
import { HELP_TEXT, VERSION } from "./help.ts";
import { runInstall } from "./install.ts";
import { runUninstall } from "./uninstall.ts";

export async function main(argv: readonly string[]): Promise<number> {
  // Global --help / --version shortcut (no command).
  if (argv.length === 0) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const parsed = parseArgs(argv);

  if (parsed.flags["--help"] || parsed.flags["-h"] || parsed.command === "help") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.flags["--version"] || parsed.flags["-v"] || parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (parsed.unknown.length > 0) {
    process.stderr.write(
      `claude-harbor-install: unknown argument(s): ${parsed.unknown.join(", ")}\n`,
    );
    return 2;
  }
  if (parsed.positional.length > 0) {
    process.stderr.write(
      `claude-harbor-install: unexpected positional arg(s): ${parsed.positional.join(", ")}\n`,
    );
    return 2;
  }

  const dryRun = parsed.flags["--dry-run"] === true;
  const home = typeof parsed.flags["--home"] === "string"
    ? parsed.flags["--home"]
    : undefined;
  const harborUrl = typeof parsed.flags["--harbor-url"] === "string"
    ? parsed.flags["--harbor-url"]
    : undefined;

  if (parsed.command === "install") {
    return runInstall({ home, harborUrl, dryRun }).code;
  }
  if (parsed.command === "uninstall") {
    return runUninstall({ home, dryRun }).code;
  }

  process.stderr.write(
    `claude-harbor-install: unknown command '${parsed.command}'. Run with --help.\n`,
  );
  return 2;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
