import { Bot } from 'grammy'

/**
 * Telegram user IDs are stored as `number` (JavaScript safe-integer range, up to 2^53-1).
 * Current Telegram IDs are 32-bit. If Telegram ever ships >2^53 user IDs,
 * migrate to bigint/string at this boundary.
 *
 * Why number (and not bigint/string) today:
 *   - grammy's entire API uses `number` for user IDs
 *   - switching to string forces a conversion at every boundary, polluting the bot
 *   - the MAX_SAFE_INTEGER guard in daemon/src/config.ts blocks alias attacks
 *
 * Naming: this is `ClaudegramBotConfig` (not `BotConfig`) to avoid shadowing
 * grammy's own `BotConfig` interface from `grammy/out/bot.d.ts`. Reviewers seeing
 * `import { BotConfig }` would otherwise wonder which one is meant.
 */
export interface ClaudegramBotConfig {
  readonly token: string
  readonly allowlist: readonly number[]
}

/**
 * Back-compat alias. Prefer {@link ClaudegramBotConfig} in new code; this exists
 * so a stale `import { BotConfig } from '@claudegram/bot'` keeps compiling.
 *
 * @deprecated Use {@link ClaudegramBotConfig} — `BotConfig` shadows grammy's own
 *             type and will be removed in a future phase.
 */
export type BotConfig = ClaudegramBotConfig

/**
 * Phase 3A will replace the generic defaults with structural interfaces for the
 * daemon's DecisionQueue / SessionRegistry. Generics are declared here in 1E so
 * Phase 3A callers can write `startBot<DecisionQueue, SessionRegistry>(config, deps)`
 * and have the dependency types flow through automatically — no per-use-site cast.
 */
export interface BotDeps<Q = unknown, R = unknown> {
  readonly queue?: Q // Phase 3A: typed as DecisionQueue via structural interface
  readonly registry?: R // Phase 3A: typed as SessionRegistry
}

export interface BotHandle {
  start(): Promise<void>
  /**
   * Gracefully stops the bot. No-op (does NOT throw) if the bot was never
   * started — this matches grammy's tolerant `bot.stop()` semantics but makes
   * the contract explicit for callers.
   */
  stop(): Promise<void>
  /**
   * Escape hatch returning the underlying grammy Bot instance. Reserved for
   * Phase 3A integration tests that need to introspect grammy state. Production
   * code should not depend on this.
   */
  getBot(): Bot
}

/**
 * Construct a bot handle. The grammy Bot is created eagerly so {@link BotHandle.getBot}
 * always returns a valid instance, but no network calls are made until `start()`.
 *
 * @typeParam Q  - Phase 3A: queue dependency type (e.g. DecisionQueue)
 * @typeParam R  - Phase 3A: registry dependency type (e.g. SessionRegistry)
 * @param config - bot token + allowlist
 * @param _deps  - reserved for Phase 3A wiring (queue, registry); unused in 1E
 */
export function startBot<Q = unknown, R = unknown>(
  config: ClaudegramBotConfig,
  _deps?: BotDeps<Q, R>,
): BotHandle {
  const bot = new Bot(config.token)
  // Phase 3A will wire allowlist middleware, queue subscription, callback_query handler
  return {
    async start(): Promise<void> {
      // Stub — Phase 3A implementation
      throw new Error('Bot.start() not yet implemented (Phase 3A)')
    },
    async stop(): Promise<void> {
      if (bot.isRunning()) {
        await bot.stop()
      }
    },
    getBot(): Bot {
      return bot
    },
  }
}
