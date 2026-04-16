import { z } from 'zod'
import type { Result } from '@claudegram/shared'

/**
 * Preprocessor: treat empty string as undefined so that `.default(...)` fires.
 * Without this, `CLAUDEGRAM_PORT=` (blank in .env) would coerce to 0 and fail
 * `.min(1)` with a confusing error instead of falling back to the default.
 */
const emptyStringAsUndefined = (v: unknown): unknown =>
  v === '' || v === undefined ? undefined : v

const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'required'),
  TELEGRAM_ALLOWLIST: z
    .string()
    .min(1, 'required')
    .transform((s, ctx) => {
      const ids = s
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const n = Number(p)
          // MAX_SAFE_INTEGER guard: Number('99999999999999999999') silently
          // loses precision and aliases to a different integer. Without this
          // check, an attacker could craft an ID string that parses to a
          // *different* allowed user ID. Telegram IDs are well within
          // 2^53 today, so rejecting >MAX_SAFE_INTEGER is safe.
          if (
            !Number.isInteger(n) ||
            n <= 0 ||
            n > Number.MAX_SAFE_INTEGER
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `invalid Telegram user ID: ${p}`,
            })
            return z.NEVER
          }
          return n
        })
      return ids
    })
    .pipe(z.array(z.number().int().positive()).min(1, 'at least one user ID required')),
  // `.default()` must live INSIDE preprocess so that an empty string (mapped
  // to undefined) triggers the default. If `.default()` wrapped the preprocess
  // instead, the default would only fire when the env key was entirely absent
  // and an empty string would still be coerced (port → NaN, URL → invalid).
  CLAUDEGRAM_PORT: z.preprocess(
    emptyStringAsUndefined,
    z.coerce.number().int().min(1).max(65535).default(3582),
  ),
  CLAUDEGRAM_DAEMON_URL: z.preprocess(
    emptyStringAsUndefined,
    z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u), 'must be http or https')
      .default('http://localhost:3582'),
  ),
})

export type Config = z.infer<typeof ConfigSchema>

/**
 * Pure validation: parse env into a typed Result. Does NOT touch process state.
 * Use this in tests (avoids process.exit). Daemon boot uses {@link loadConfig}.
 */
export function parseConfig(
  env: NodeJS.ProcessEnv = process.env,
): Result<Config, string[]> {
  const result = ConfigSchema.safeParse(env)
  if (!result.success) {
    return {
      ok: false,
      error: result.error.errors.map((e) => {
        const path = e.path.length > 0 ? e.path.join('.') : '(root)'
        return `${path}: ${e.message}`
      }),
    }
  }
  return { ok: true, data: result.data }
}

/**
 * Boot-time loader: validates env, prints fail-fast diagnostics to stderr and
 * exits with code 1 on any error. Intended for the daemon entry point only —
 * tests should call {@link parseConfig} instead.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env)
  if (!result.ok) {
    const lines = result.error.map((l) => `  ✗ ${l}`).join('\n')
    process.stderr.write(
      `[claudegram] Invalid environment configuration:\n${lines}\n\n` +
        `Required: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWLIST\n` +
        `Optional: CLAUDEGRAM_PORT (default 3582), CLAUDEGRAM_DAEMON_URL (default http://localhost:3582)\n` +
        `See .env.example for template.\n`,
    )
    process.exit(1)
  }
  return result.data
}
