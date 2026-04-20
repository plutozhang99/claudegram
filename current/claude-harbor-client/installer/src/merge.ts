/**
 * Idempotent merge of our additions into an existing settings.json value,
 * and the reverse merge used by `uninstall`.
 *
 * Purity: returns a fresh object; inputs are not mutated. Implementation
 * uses `structuredClone` of the caller-provided `current` and then
 * mutates the local clone — callers still observe a pure function
 * because no reference they hold escapes.
 *
 * Install rules:
 *   - Hooks: append to `hooks.<EventName>[]` only if a structurally
 *     equal entry is not already present (see `hookEntryEqual`).
 *   - statusLine: set if absent OR already equal to ours. If user has a
 *     DIFFERENT statusLine, we leave it and report the conflict.
 *   - allowedChannelPlugins: append `{marketplace, plugin}` if not
 *     already present (match on identity). If the user never had the
 *     key and ours is already in a pre-existing array, we won't create
 *     the key spuriously.
 *   - channelsEnabled: set to `true` if unset. If explicitly `false`,
 *     leave it and surface it (caller warns).
 *
 * Uninstall rules mirror the sidecar recorded at install time:
 *   - Remove the hook entry we added for each event (only if it's still
 *     structurally equal — otherwise preserve and warn).
 *   - Remove our statusLine only if it's still ours.
 *   - Remove our `allowedChannelPlugins` entry.
 *   - If WE flipped channelsEnabled, flip it back.
 */

import {
  MANAGED_HOOK_EVENTS,
  type ChannelPluginEntry,
  type InstalledHookEntry,
  type ManagedHookEvent,
  type SettingsShape,
  type Sidecar,
  type StatusLineEntry,
} from "./types.ts";

// ---------------------------------------------------------------------
// Install merge
// ---------------------------------------------------------------------

export interface MergeInputs {
  readonly current: unknown;
  /**
   * Hook entry to install per event. We index per event so callers can
   * bake the event name into the hook command itself.
   */
  readonly perEventHookEntries: Readonly<Record<ManagedHookEvent, InstalledHookEntry>>;
  readonly statusLine: StatusLineEntry;
  readonly channelPlugin: ChannelPluginEntry;
}

export interface MergePlan {
  readonly addedHooks: readonly ManagedHookEvent[];
  readonly skippedHooks: readonly ManagedHookEvent[];
  readonly willSetStatusLine: boolean;
  readonly statusLineAlreadyMine: boolean;
  readonly conflictingStatusLine: StatusLineEntry | null;
  readonly willAddChannelPlugin: boolean;
  readonly channelPluginAlreadyMine: boolean;
  readonly willSetChannelsEnabled: boolean;
  readonly channelsExplicitlyDisabled: boolean;
}

export interface MergeResult {
  readonly next: SettingsShape;
  readonly plan: MergePlan;
}

export function mergeInstall(inputs: MergeInputs): MergeResult {
  const next = asObject(inputs.current);

  // hooks
  const hooks: Record<string, InstalledHookEntry[]> =
    next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks)
      ? { ...next.hooks }
      : {};
  const added: ManagedHookEvent[] = [];
  const skipped: ManagedHookEvent[] = [];
  for (const event of MANAGED_HOOK_EVENTS) {
    const entry = inputs.perEventHookEntries[event];
    const bucket = Array.isArray(hooks[event]) ? [...hooks[event]!] : [];
    if (bucket.some((e) => hookEntryEqual(e, entry))) {
      skipped.push(event);
    } else {
      bucket.push(entry);
      added.push(event);
    }
    hooks[event] = bucket;
  }
  next.hooks = hooks;

  // statusLine
  const existingStatusLine = next.statusLine;
  const statusLineAlreadyMine = statusLineEqual(existingStatusLine, inputs.statusLine);
  const hasDifferent = !!existingStatusLine && !statusLineAlreadyMine;
  const willSetStatusLine = !statusLineAlreadyMine && !hasDifferent;
  if (willSetStatusLine) next.statusLine = inputs.statusLine;
  const conflictingStatusLine = hasDifferent ? existingStatusLine! : null;

  // allowedChannelPlugins
  const hadPluginsField = Array.isArray(next.allowedChannelPlugins);
  const existingPlugins: ChannelPluginEntry[] = hadPluginsField
    ? [...(next.allowedChannelPlugins as ChannelPluginEntry[])]
    : [];
  const channelPluginAlreadyMine = existingPlugins.some((p) =>
    channelPluginEqual(p, inputs.channelPlugin),
  );
  if (!channelPluginAlreadyMine) existingPlugins.push(inputs.channelPlugin);
  // Only persist the array back to `next` if we actually changed it OR
  // the user already had the key. This keeps uninstall-produced objects
  // minimal when the user never touched allowedChannelPlugins.
  if (!channelPluginAlreadyMine || hadPluginsField) {
    next.allowedChannelPlugins = existingPlugins;
  }

  // channelsEnabled
  const channelsExplicitlyDisabled = next.channelsEnabled === false;
  const willSetChannelsEnabled =
    next.channelsEnabled !== true && !channelsExplicitlyDisabled;
  if (willSetChannelsEnabled) next.channelsEnabled = true;

  return {
    next,
    plan: {
      addedHooks: added,
      skippedHooks: skipped,
      willSetStatusLine,
      statusLineAlreadyMine,
      conflictingStatusLine,
      willAddChannelPlugin: !channelPluginAlreadyMine,
      channelPluginAlreadyMine,
      willSetChannelsEnabled,
      channelsExplicitlyDisabled,
    },
  };
}

// ---------------------------------------------------------------------
// Uninstall merge
// ---------------------------------------------------------------------

export interface UninstallInputs {
  readonly current: unknown;
  readonly sidecar: Sidecar;
}

export interface UninstallPlan {
  readonly removedHooks: readonly ManagedHookEvent[];
  readonly preservedHooks: readonly ManagedHookEvent[];
  readonly removedStatusLine: boolean;
  readonly preservedStatusLine: boolean;
  readonly removedChannelPlugin: boolean;
  readonly revertedChannelsEnabled: boolean;
}

export interface UninstallResult {
  readonly next: SettingsShape;
  readonly plan: UninstallPlan;
}

export function mergeUninstall(inputs: UninstallInputs): UninstallResult {
  const { sidecar } = inputs;
  const next = asObject(inputs.current);
  const removedHooks: ManagedHookEvent[] = [];
  const preservedHooks: ManagedHookEvent[] = [];

  const hooks: Record<string, InstalledHookEntry[]> =
    next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks)
      ? { ...next.hooks }
      : {};

  for (const event of MANAGED_HOOK_EVENTS) {
    const recorded = sidecar.hooks[event];
    if (!recorded) continue;
    const bucket = Array.isArray(hooks[event]) ? [...hooks[event]!] : [];
    const idx = bucket.findIndex((e) => hookEntryEqual(e, recorded));
    if (idx === -1) {
      preservedHooks.push(event);
      continue;
    }
    bucket.splice(idx, 1);
    if (bucket.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = bucket;
    }
    removedHooks.push(event);
  }
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }

  let removedStatusLine = false;
  let preservedStatusLine = false;
  if (sidecar.statusLine) {
    const current = next.statusLine;
    if (current && statusLineEqual(current, sidecar.statusLine)) {
      delete next.statusLine;
      removedStatusLine = true;
    } else if (current) {
      preservedStatusLine = true;
    }
  }

  let removedChannelPlugin = false;
  if (sidecar.channel_plugin) {
    const arr: ChannelPluginEntry[] = Array.isArray(next.allowedChannelPlugins)
      ? [...(next.allowedChannelPlugins as ChannelPluginEntry[])]
      : [];
    const idx = arr.findIndex((p) =>
      channelPluginEqual(p, sidecar.channel_plugin!),
    );
    if (idx !== -1) {
      arr.splice(idx, 1);
      removedChannelPlugin = true;
    }
    if (arr.length === 0) {
      delete next.allowedChannelPlugins;
    } else {
      next.allowedChannelPlugins = arr;
    }
  }

  let revertedChannelsEnabled = false;
  if (sidecar.set_channels_enabled && next.channelsEnabled === true) {
    delete next.channelsEnabled;
    revertedChannelsEnabled = true;
  }

  return {
    next,
    plan: {
      removedHooks,
      preservedHooks,
      removedStatusLine,
      preservedStatusLine,
      removedChannelPlugin,
      revertedChannelsEnabled,
    },
  };
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function asObject(value: unknown): SettingsShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return structuredClone(value as SettingsShape);
}

/**
 * Structural equality for hook entries. Key-order within objects must
 * NOT matter (CC / editors reorder JSON keys). We compare:
 *   - `matcher` string equality
 *   - `hooks` array length
 *   - elementwise: `type === "command"` and `command` string equality
 *
 * Extra fields on the recorded entry (currently none, but kept extensible)
 * would be compared by shallow-key equality. Arrays in `hooks` are
 * compared in order because CC itself treats them as ordered.
 */
function hookEntryEqual(a: InstalledHookEntry, b: InstalledHookEntry): boolean {
  if (a.matcher !== b.matcher) return false;
  if (a.hooks.length !== b.hooks.length) return false;
  for (let i = 0; i < a.hooks.length; i += 1) {
    const ah = a.hooks[i]!;
    const bh = b.hooks[i]!;
    if (ah.type !== "command" || bh.type !== "command") return false;
    if (ah.command !== bh.command) return false;
  }
  return true;
}

function statusLineEqual(
  a: StatusLineEntry | undefined,
  b: StatusLineEntry,
): boolean {
  return !!a && a.type === b.type && a.command === b.command;
}

function channelPluginEqual(a: ChannelPluginEntry, b: ChannelPluginEntry): boolean {
  return a.marketplace === b.marketplace && a.plugin === b.plugin;
}
