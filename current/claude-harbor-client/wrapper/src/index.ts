#!/usr/bin/env bun
/**
 * claude-harbor CLI entrypoint.
 *
 * `main` receives argv already sliced in the entrypoint — that is,
 * `argv[0]` is the subcommand (e.g. `start`, `--help`, `--version`), not
 * the Bun binary or the script path. The top-level block below performs
 * that slicing via `process.argv.slice(2)` before calling `main`.
 *
 * Dispatches on argv[0]:
 *   start [...args]          → runStart
 *   --version | -v           → print version to stdout, exit 0
 *   --help | -h | (no args)  → print help to stdout, exit 0
 *   anything else            → stderr error, exit 2
 *
 * All wrapper diagnostic output goes to stderr. Only `--help` and
 * `--version` use stdout because the user explicitly asked for that text.
 */

import { HELP_TEXT, VERSION } from "./help.ts";
import { runStart } from "./start.ts";

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (cmd === "start") {
    const result = await runStart({ argv: rest });
    return result.code;
  }

  process.stderr.write(
    `claude-harbor: unknown command '${cmd}'. Run 'claude-harbor --help'.\n`,
  );
  return 2;
}

// Only run when invoked directly (not when imported from tests).
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
