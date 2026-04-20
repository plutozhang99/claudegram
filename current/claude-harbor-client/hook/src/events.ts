/**
 * Canonical hook event names and their server-side kebab-case paths.
 *
 * CC hook events (as they appear in `settings.json > hooks.<EventName>`) are
 * PascalCase. The harbor server exposes kebab-case routes (e.g.
 * `POST /hooks/session-start`). We map between the two in one place so
 * both the installer and the hook binary stay in sync.
 */

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd"
  | "Notification";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "Notification",
] as const;

/**
 * PascalCase hook event -> kebab-case server path segment.
 *
 * Insertion of capitalized letters becomes `-<lower>` except for the first
 * character. Explicit table keeps the mapping auditable and avoids edge
 * cases for future events with numbers / acronyms.
 */
export const EVENT_PATHS: Readonly<Record<HookEvent, string>> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  Stop: "stop",
  SessionEnd: "session-end",
  Notification: "notification",
};

export function isHookEvent(name: string): name is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}
