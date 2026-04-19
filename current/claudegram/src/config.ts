import { z } from "zod";

export const configSchema = z.object({
  port: z
    .string()
    .regex(/^\d+$/, "port must be a positive integer string")
    .transform((s) => parseInt(s, 10))
    .pipe(z.number().int().min(1).max(65535))
    .default("8788"),
  db_path: z
    .string()
    .min(1)
    .refine((p) => !p.split(/[\/\\]/).includes(".."), {
      message: "db_path must not contain path traversal segments",
    })
    .default("./data/claudegram.db"),
  log_level: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
  trustCfAccess: z
    .boolean()
    .default(false),
  wsOutboundBufferCapBytes: z
    .coerce.number()
    .int()
    .positive()
    .default(1_048_576),
  wsInboundMaxBadFrames: z
    .coerce.number()
    .int()
    .positive()
    .default(5),
  maxPwaConnections: z
    .coerce.number()
    .int()
    .positive()
    .default(256),
  maxSessionConnections: z
    .coerce.number()
    .int()
    .positive()
    .default(64),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const rawCap = env["WS_OUTBOUND_BUFFER_CAP_BYTES"];
  if (rawCap !== undefined) {
    const parsed = Number(rawCap);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `Invalid environment variable WS_OUTBOUND_BUFFER_CAP_BYTES: "${rawCap}" is not a finite number`,
      );
    }
  }

  const rawMaxBadFrames = env["WS_INBOUND_MAX_BAD_FRAMES"];
  if (rawMaxBadFrames !== undefined) {
    const parsed = Number(rawMaxBadFrames);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `Invalid environment variable WS_INBOUND_MAX_BAD_FRAMES: "${rawMaxBadFrames}" is not a finite number`,
      );
    }
  }

  // MED 2: MAX_PWA_CONNECTIONS and MAX_SESSION_CONNECTIONS are validated directly
  // by Zod's z.coerce.number().int().positive() — no manual pre-guard needed.
  // The redundant Number.isFinite block has been removed; the Zod error names the
  // field via its path array, which is sufficient for debugging.

  return configSchema.parse({
    port: env["CLAUDEGRAM_PORT"],
    db_path: env["CLAUDEGRAM_DB_PATH"],
    log_level: env["CLAUDEGRAM_LOG_LEVEL"],
    trustCfAccess: env["TRUST_CF_ACCESS"] === "true",
    wsOutboundBufferCapBytes: rawCap,
    wsInboundMaxBadFrames: rawMaxBadFrames,
    maxPwaConnections: env["MAX_PWA_CONNECTIONS"],
    maxSessionConnections: env["MAX_SESSION_CONNECTIONS"],
  });
}
