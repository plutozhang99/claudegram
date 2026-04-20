/**
 * `claude-harbor-install uninstall` flow.
 *
 *  1. Resolve $CLAUDE_HOME (override via --home).
 *  2. Read the sidecar (`claude-harbor-installed.json`). If missing, we
 *     have nothing to do — print a hint and exit 0.
 *  3. Read settings.json. If malformed JSON, refuse to touch (exit 1).
 *  4. For every key path the sidecar recorded, remove it ONLY if it's
 *     still byte-for-byte the value we installed. If the user has
 *     modified it, leave it alone and emit a WARNING on stderr.
 *  5. Write settings.json atomically, delete sidecar.
 *
 * `--dry-run`: compute the diff and print it; no files touched.
 */

import { existsSync, unlinkSync } from "node:fs";
import {
  readJsonFile,
  resolveClaudeHome,
  settingsPath,
  sidecarPath,
  writeJsonAtomic,
} from "./fs.ts";
import { mergeUninstall } from "./merge.ts";
import type { Sidecar } from "./types.ts";

export interface UninstallOptions {
  readonly home?: string;
  readonly dryRun?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (msg: string) => void;
  readonly stderr?: (msg: string) => void;
}

export interface UninstallResult {
  readonly code: number;
}

const DEFAULT_STDOUT = (m: string): void => {
  process.stdout.write(`${m}\n`);
};
const DEFAULT_STDERR = (m: string): void => {
  process.stderr.write(`${m}\n`);
};

/**
 * Runtime type-guard for a v1 sidecar. Every required field must be
 * present with the right shape — otherwise we refuse to proceed,
 * because uninstall decisions depend on trustworthy provenance data.
 *
 * Required fields (see types.ts): version=1, installed_at (string),
 * settings_path (string), harbor_url (string), hooks (object), and
 * channel_plugin / statusLine / set_channels_enabled presence.
 */
function isSidecar(value: unknown): value is Sidecar {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.installed_at !== "string") return false;
  if (typeof v.settings_path !== "string") return false;
  if (typeof v.harbor_url !== "string") return false;
  if (!("hooks" in v) || typeof v.hooks !== "object" || v.hooks === null) {
    return false;
  }
  // statusLine is nullable — field must be present, value null or object.
  if (!("statusLine" in v)) return false;
  if (v.statusLine !== null && (typeof v.statusLine !== "object" || Array.isArray(v.statusLine))) {
    return false;
  }
  // channel_plugin is nullable — field must be present, value null or object.
  if (!("channel_plugin" in v)) return false;
  if (
    v.channel_plugin !== null &&
    (typeof v.channel_plugin !== "object" || Array.isArray(v.channel_plugin))
  ) {
    return false;
  }
  if (typeof v.set_channels_enabled !== "boolean") return false;
  return true;
}

export function runUninstall(opts: UninstallOptions): UninstallResult {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? DEFAULT_STDOUT;
  const stderr = opts.stderr ?? DEFAULT_STDERR;
  const dryRun = opts.dryRun === true;

  const claudeHome = resolveClaudeHome(opts.home, env);
  const settings = settingsPath(claudeHome);
  const sidecar = sidecarPath(claudeHome);

  // (2) Load sidecar.
  const sidecarRead = readJsonFile(sidecar);
  if (sidecarRead.kind === "missing") {
    stdout(
      `claude-harbor-install: no sidecar at ${sidecar}; nothing to uninstall.`,
    );
    return { code: 0 };
  }
  if (sidecarRead.kind === "malformed") {
    stderr(
      `claude-harbor-install: sidecar at ${sidecar} is malformed (${sidecarRead.message}).`,
    );
    stderr("  Refusing to touch settings.json.");
    return { code: 1 };
  }
  if (sidecarRead.kind === "too-large") {
    stderr(
      `claude-harbor-install: sidecar at ${sidecar} is too large (${sidecarRead.bytes} bytes; limit 1 MiB).`,
    );
    stderr("  Refusing to touch settings.json.");
    return { code: 1 };
  }
  if (!isSidecar(sidecarRead.value)) {
    stderr(
      `claude-harbor-install: sidecar at ${sidecar} is not a v1 sidecar; refusing to uninstall.`,
    );
    return { code: 1 };
  }
  const sidecarValue: Sidecar = sidecarRead.value;

  // (3) Load settings.
  const settingsRead = readJsonFile(settings);
  if (settingsRead.kind === "malformed") {
    stderr(
      `claude-harbor-install: settings.json at ${settings} is malformed (${settingsRead.message}).`,
    );
    stderr("  Refusing to touch the file.");
    return { code: 1 };
  }
  if (settingsRead.kind === "too-large") {
    stderr(
      `claude-harbor-install: settings.json at ${settings} is too large (${settingsRead.bytes} bytes; limit 1 MiB).`,
    );
    stderr("  Refusing to touch the file.");
    return { code: 1 };
  }
  const currentValue = settingsRead.kind === "ok" ? settingsRead.value : {};

  // (4) Merge out.
  const { next, plan } = mergeUninstall({
    current: currentValue,
    sidecar: sidecarValue,
  });

  stdout(`claude-harbor-install: uninstall target ${settings}`);
  if (dryRun) stdout("  (dry-run; no files will be written)");
  if (plan.removedHooks.length > 0) {
    stdout(`  hooks removed: ${plan.removedHooks.join(", ")}`);
  }
  if (plan.preservedHooks.length > 0) {
    stderr(
      `  hooks WARNING: ${plan.preservedHooks.join(", ")} were modified since install; leaving user's entries.`,
    );
  }
  if (plan.removedStatusLine) stdout("  statusLine: removed");
  if (plan.preservedStatusLine) {
    stderr("  statusLine WARNING: user modified statusLine since install; leaving user's value.");
  }
  if (plan.removedChannelPlugin) stdout("  allowedChannelPlugins: removed our entry");
  if (plan.revertedChannelsEnabled)
    stdout("  channelsEnabled: reverted to default (removed)");

  if (dryRun) {
    stdout("--- settings.json (post-uninstall) ---");
    stdout(JSON.stringify(next, null, 2));
    return { code: 0 };
  }

  // (5) Write.
  writeJsonAtomic(settings, next);
  if (existsSync(sidecar)) {
    try {
      unlinkSync(sidecar);
    } catch (err) {
      stderr(
        `claude-harbor-install: failed to delete sidecar ${sidecar}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { code: 1 };
    }
  }
  stdout(`  wrote: ${settings}`);
  stdout(`  removed sidecar: ${sidecar}`);
  return { code: 0 };
}
