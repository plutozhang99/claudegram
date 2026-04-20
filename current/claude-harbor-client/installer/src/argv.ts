/**
 * Tiny argv parser for the installer CLI. Deliberately minimal — we
 * don't pull in a flag library for one command with three flags.
 *
 * Recognized shapes:
 *   --flag             boolean = true
 *   --flag value
 *   --flag=value
 *
 * Unknown flags are returned in `unknown` for the caller to reject.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly flags: Readonly<Record<string, string | true>>;
  readonly positional: readonly string[];
  readonly unknown: readonly string[];
}

const KNOWN_STRING_FLAGS = new Set(["--harbor-url", "--home"]);
const KNOWN_BOOL_FLAGS = new Set(["--dry-run"]);
const ALL_KNOWN = new Set([
  ...KNOWN_STRING_FLAGS,
  ...KNOWN_BOOL_FLAGS,
  "--help",
  "-h",
  "--version",
  "-v",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const unknown: string[] = [];
  let command: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith("--") || arg === "-h" || arg === "-v") {
      // Split on '=' if present.
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!ALL_KNOWN.has(name)) {
        unknown.push(arg);
        i += 1;
        continue;
      }
      if (KNOWN_BOOL_FLAGS.has(name) || name === "-h" || name === "--help" || name === "-v" || name === "--version") {
        flags[name] = true;
        i += 1;
        continue;
      }
      // String flag.
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
        i += 1;
        continue;
      }
      const nextVal = argv[i + 1];
      if (nextVal === undefined || nextVal.startsWith("-")) {
        // Missing value → record as unknown so caller can error out.
        unknown.push(`${arg} (missing value)`);
        i += 1;
        continue;
      }
      flags[name] = nextVal;
      i += 2;
      continue;
    }
    // First non-flag is the command; remainder are positional.
    if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
    i += 1;
  }
  return { command, flags, positional, unknown };
}
