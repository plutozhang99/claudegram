/**
 * `claude-harbor-install install` flow.
 *
 *  1. Resolve $CLAUDE_HOME (override via --home).
 *  2. Ensure settings.json exists (create empty `{}` if not).
 *  3. Read settings.json. Malformed JSON → exit 1 without touching file.
 *  4. Build our additions (per-event hook entries, statusLine, channel
 *     plugin).
 *  5. Backup settings.json to `settings.json.bak-<iso>` ONCE per install —
 *     the first time install runs against a non-empty file that predates
 *     our sidecar. Subsequent re-installs do not pile up backups.
 *  6. Merge (idempotent), write settings.json atomically, write sidecar
 *     atomically.
 *  7. Print a human summary.
 *
 * `--dry-run`: compute the merge, print the plan + merged JSON to stdout,
 * do not write anything.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  backupSuffix,
  ensureSettingsFile,
  readJsonFile,
  resolveClaudeHome,
  settingsPath,
  shortRandomSuffix,
  sidecarPath,
  writeFileAtomic,
  writeJsonAtomic,
} from "./fs.ts";
import { mergeInstall } from "./merge.ts";
import {
  DEFAULT_CHANNEL_PLUGIN_MARKETPLACE,
  DEFAULT_CHANNEL_PLUGIN_NAME,
  DEFAULT_HARBOR_URL,
  MANAGED_HOOK_EVENTS,
  type ChannelPluginEntry,
  type InstalledHookEntry,
  type ManagedHookEvent,
  type Sidecar,
  type StatusLineEntry,
} from "./types.ts";

export interface InstallOptions {
  readonly home?: string;
  readonly harborUrl?: string;
  readonly dryRun?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  readonly stdout?: (msg: string) => void;
  readonly stderr?: (msg: string) => void;
}

export interface InstallResult {
  readonly code: number;
}

/**
 * Validate and normalize a candidate harbor URL. Accepts only http(s),
 * strips any `user:pass@` userinfo, and trims trailing slashes. Returns
 * `null` if the URL is unusable; caller should exit 2.
 */
export function normalizeHarborUrl(
  raw: string,
  stderr: (m: string) => void,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    stderr(
      `claude-harbor-install: --harbor-url '${raw}' is not a valid URL.`,
    );
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    stderr(
      `claude-harbor-install: --harbor-url scheme '${parsed.protocol}' is not allowed (must be http or https).`,
    );
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    stderr(
      `claude-harbor-install: --harbor-url contained credentials in userinfo; stripping before use.`,
    );
    parsed.username = "";
    parsed.password = "";
  }
  return parsed.toString().replace(/\/+$/, "");
}

const DEFAULT_STDOUT = (m: string): void => {
  process.stdout.write(`${m}\n`);
};
const DEFAULT_STDERR = (m: string): void => {
  process.stderr.write(`${m}\n`);
};

/** Resolve the hook command. Placeholder in case we bake args later. */
function hookCommandBase(): string {
  // The binary reads HARBOR_URL from env at runtime, not from argv.
  return "claude-harbor-hook";
}

function statuslineCommandBase(): string {
  return "claude-harbor-statusline";
}

/**
 * Best-effort read of a prior sidecar, used to carry forward recorded
 * hooks across idempotent re-installs. Any read or shape error yields
 * `null` — we fall through to recording only what this run added.
 */
function readPriorSidecar(path: string): Sidecar | null {
  const r = readJsonFile(path);
  if (r.kind !== "ok") return null;
  const v = r.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  if (rec.version !== 1) return null;
  if (!rec.hooks || typeof rec.hooks !== "object") return null;
  return v as Sidecar;
}

function buildPerEventEntries(): Record<ManagedHookEvent, InstalledHookEntry> {
  const out = {} as Record<ManagedHookEvent, InstalledHookEntry>;
  for (const event of MANAGED_HOOK_EVENTS) {
    out[event] = {
      // Empty matcher = "match all" per CC hooks reference.
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `${hookCommandBase()} ${event}`,
        },
      ],
    };
  }
  return out;
}

export function runInstall(opts: InstallOptions): InstallResult {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? DEFAULT_STDOUT;
  const stderr = opts.stderr ?? DEFAULT_STDERR;
  const dryRun = opts.dryRun === true;
  const rawUrl =
    opts.harborUrl?.trim() || env.HARBOR_URL?.trim() || DEFAULT_HARBOR_URL;
  const harborUrl = normalizeHarborUrl(rawUrl, stderr);
  if (harborUrl === null) {
    return { code: 2 };
  }

  const claudeHome = resolveClaudeHome(opts.home, env);
  const settings = settingsPath(claudeHome);
  const sidecar = sidecarPath(claudeHome);

  // (2) Ensure settings.json exists (skip write in dry-run).
  const createdFresh = dryRun
    ? !existsSync(settings)
    : ensureSettingsFile(claudeHome);

  // (3) Read + parse.
  const read = readJsonFile(settings);
  if (read.kind === "malformed") {
    stderr(
      `claude-harbor-install: settings.json at ${settings} is malformed JSON (${read.message}).`,
    );
    stderr("  Refusing to touch the file. Fix it or move it aside, then re-run.");
    return { code: 1 };
  }
  if (read.kind === "too-large") {
    stderr(
      `claude-harbor-install: settings.json at ${settings} is too large (${read.bytes} bytes; limit 1 MiB).`,
    );
    stderr("  Refusing to touch the file.");
    return { code: 1 };
  }
  // NOTE: the `missing` branch is only reachable in --dry-run, because
  // ensureSettingsFile() creates the file when not dry-run. Dry-run may
  // intentionally be run against an empty $CLAUDE_HOME.
  const currentValue = read.kind === "ok" ? read.value : {};

  // (4) Build additions.
  const statusLine: StatusLineEntry = {
    type: "command",
    command: statuslineCommandBase(),
  };
  const channelPlugin: ChannelPluginEntry = {
    marketplace: DEFAULT_CHANNEL_PLUGIN_MARKETPLACE,
    plugin: DEFAULT_CHANNEL_PLUGIN_NAME,
  };
  const perEventHookEntries = buildPerEventEntries();

  const { next, plan } = mergeInstall({
    current: currentValue,
    perEventHookEntries,
    statusLine,
    channelPlugin,
  });

  // (5) Backup — only if settings.json has prior content AND we have not
  // installed before (sidecar absent). `!createdFresh` already implies
  // the settings file existed before this invocation, so the previous
  // redundant `existsSync(settings)` check was removed. Dry-run does
  // NOT touch the filesystem at all.
  const sidecarExists = existsSync(sidecar);
  let backupPath: string | null = null;
  if (!createdFresh && !sidecarExists && !dryRun) {
    const raw = readFileSync(settings, "utf8");
    if (raw.trim().length > 0) {
      // Append a short random suffix so two installs within the same
      // ISO millisecond (tests, tight loops) don't clobber each other.
      // writeFileAtomic uses O_EXCL, so on the exceedingly unlikely
      // path collision we'd surface an error rather than overwrite.
      const suffix = backupSuffix(opts.now);
      backupPath = `${settings}.bak-${suffix}-${shortRandomSuffix()}`;
      writeFileAtomic(backupPath, raw);
    }
  }

  const installedAt = (opts.now ?? new Date()).toISOString();
  // Record ONLY the hook entries we actually inserted. "Inserted" spans
  // this run AND any prior install (idempotent re-installs produce zero
  // addedHooks but we still want uninstall to remove what the first
  // install added). We therefore carry forward entries from the prior
  // sidecar whose recorded command still matches ours.
  const priorSidecar = readPriorSidecar(sidecar);
  const recordedHooks = {} as Record<ManagedHookEvent, InstalledHookEntry>;
  for (const event of plan.addedHooks) {
    recordedHooks[event] = perEventHookEntries[event];
  }
  if (priorSidecar) {
    for (const event of MANAGED_HOOK_EVENTS) {
      if (recordedHooks[event]) continue;
      const prev = priorSidecar.hooks[event];
      // Only carry forward if the prior recorded entry is still our
      // current shape — protects against command renames between
      // installer versions.
      if (prev && prev.hooks?.[0]?.command === `${hookCommandBase()} ${event}`) {
        recordedHooks[event] = prev;
      }
    }
  }
  const sidecarValue: Sidecar = {
    version: 1,
    installed_at: installedAt,
    settings_path: settings,
    backup_path: backupPath,
    harbor_url: harborUrl,
    // `hook_command` / `statusline_command` are informational/diagnostic
    // only — uninstall matches by the full entries in `hooks` and
    // `statusLine`, not by these fields.
    hook_command: hookCommandBase(),
    statusline_command: statuslineCommandBase(),
    hooks: recordedHooks,
    statusLine:
      plan.willSetStatusLine || plan.statusLineAlreadyMine ? statusLine : null,
    channel_plugin:
      plan.willAddChannelPlugin || plan.channelPluginAlreadyMine
        ? channelPlugin
        : null,
    // Carry forward prior `set_channels_enabled=true` so that a repeat
    // install doesn't lose the flag we used to flip. Same rationale as
    // `recordedHooks` carry-forward.
    set_channels_enabled:
      plan.willSetChannelsEnabled ||
      (priorSidecar?.set_channels_enabled === true &&
        next.channelsEnabled === true),
  };

  // (7) Summary.
  stdout(`claude-harbor-install: target ${settings}`);
  if (dryRun) stdout("  (dry-run; no files will be written)");
  if (backupPath) stdout(`  backup: ${backupPath}`);
  stdout(
    `  hooks: ${plan.addedHooks.length} added, ${plan.skippedHooks.length} already present`,
  );
  if (plan.addedHooks.length > 0) {
    stdout(`    added: ${plan.addedHooks.join(", ")}`);
  }
  if (plan.skippedHooks.length > 0) {
    stdout(`    skipped: ${plan.skippedHooks.join(", ")}`);
  }
  if (plan.willSetStatusLine) {
    stdout(`  statusLine: set -> ${statusLine.command}`);
  } else if (plan.statusLineAlreadyMine) {
    stdout(`  statusLine: already ours, no change`);
  } else if (plan.conflictingStatusLine) {
    stderr(
      `  statusLine: WARNING — existing statusLine differs ` +
        `(${JSON.stringify(plan.conflictingStatusLine)}). Leaving user's value.`,
    );
  }
  if (plan.willAddChannelPlugin) {
    stdout(
      `  allowedChannelPlugins: added ${channelPlugin.marketplace}:${channelPlugin.plugin}`,
    );
  } else {
    stdout(`  allowedChannelPlugins: already present`);
  }
  if (plan.willSetChannelsEnabled) {
    stdout(`  channelsEnabled: set to true`);
  } else if (plan.channelsExplicitlyDisabled) {
    stderr(
      `  channelsEnabled: WARNING — explicitly false. Channels will not ` +
        `receive notifications until you set it to true.`,
    );
  }

  if (dryRun) {
    stdout("--- settings.json (post-merge) ---");
    stdout(JSON.stringify(next, null, 2));
    stdout("--- sidecar (would-write) ---");
    stdout(JSON.stringify(sidecarValue, null, 2));
    return { code: 0 };
  }

  // (6) Write atomically.
  writeJsonAtomic(settings, next);
  writeJsonAtomic(sidecar, sidecarValue);
  stdout(`  wrote: ${settings}`);
  stdout(`  wrote sidecar: ${sidecar}`);
  stdout(`  harbor URL (runtime): ${harborUrl}`);
  return { code: 0 };
}
