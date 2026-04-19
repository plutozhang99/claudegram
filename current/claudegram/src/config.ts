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

  return configSchema.parse({
    port: env["CLAUDEGRAM_PORT"],
    db_path: env["CLAUDEGRAM_DB_PATH"],
    log_level: env["CLAUDEGRAM_LOG_LEVEL"],
    trustCfAccess: env["TRUST_CF_ACCESS"] === "true",
    wsOutboundBufferCapBytes: rawCap,
  });
}
