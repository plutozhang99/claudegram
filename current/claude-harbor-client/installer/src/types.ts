/**
 * Type definitions for the installer.
 *
 * The key types describe:
 *   - the subset of `~/.claude/settings.json` we touch (hooks, statusLine,
 *     allowedChannelPlugins, channelsEnabled),
 *   - the "sidecar" file we write alongside settings.json to record
 *     exactly what we added, so uninstall can remove only our entries.
 */

/** Hook event names we register. Matches the canonical CC event list. */
export const MANAGED_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "Notification",
] as const;
export type ManagedHookEvent = (typeof MANAGED_HOOK_EVENTS)[number];

/** Default marketplace + plugin registered under allowedChannelPlugins. */
export const DEFAULT_CHANNEL_PLUGIN_MARKETPLACE = "local";
export const DEFAULT_CHANNEL_PLUGIN_NAME = "claude-harbor";

/** Default harbor server URL (surfaced only when the user runs `install`). */
export const DEFAULT_HARBOR_URL = "http://localhost:7823";

/**
 * Sidecar record written to `<claudeHome>/claude-harbor-installed.json`.
 *
 * Everything we insert during `install` is enumerated here so `uninstall`
 * can remove exactly our additions. If the user has edited any of these
 * entries between install and uninstall, we leave that entry alone and
 * warn — we never overwrite user modifications.
 */
export interface Sidecar {
  /** Marker so future versions can detect and migrate. */
  readonly version: 1;
  /** ISO timestamp of the install. */
  readonly installed_at: string;
  /** Absolute path of the settings.json we wrote to. */
  readonly settings_path: string;
  /** Optional: the .bak-<iso> path, if we created one this install. */
  readonly backup_path: string | null;
  /** The harbor server URL we baked into hook/statusline commands. */
  readonly harbor_url: string;
  /** The hook command + args snapshot used, so uninstall can match exactly. */
  readonly hook_command: string;
  /** The statusLine command snapshot used. */
  readonly statusline_command: string;
  /** The hooks we added, keyed by event. */
  readonly hooks: Readonly<Record<ManagedHookEvent, InstalledHookEntry>>;
  /** statusLine value we wrote (null = didn't touch). */
  readonly statusLine: StatusLineEntry | null;
  /** allowedChannelPlugins entry we added (null = already present). */
  readonly channel_plugin: ChannelPluginEntry | null;
  /** `true` if WE flipped channelsEnabled to true. */
  readonly set_channels_enabled: boolean;
}

/** One entry we appended to `hooks.<EventName>[]`. */
export interface InstalledHookEntry {
  readonly matcher: string;
  readonly hooks: ReadonlyArray<{
    readonly type: "command";
    readonly command: string;
  }>;
}

export interface StatusLineEntry {
  readonly type: "command";
  readonly command: string;
}

export interface ChannelPluginEntry {
  readonly marketplace: string;
  readonly plugin: string;
}

/** Minimal shape of settings.json we care about. */
export interface SettingsShape {
  hooks?: Record<string, InstalledHookEntry[]>;
  statusLine?: StatusLineEntry;
  allowedChannelPlugins?: ChannelPluginEntry[];
  channelsEnabled?: boolean;
  // Anything else the user keeps there is preserved verbatim.
  [key: string]: unknown;
}
