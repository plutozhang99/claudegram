/**
 * Stdin reader (UTF-8, size-capped). Mirrors the helper in the hook
 * package but kept here so statusline has zero cross-package imports —
 * each claude-harbor local binary is independently deployable.
 */

export interface ReadStdinOptions {
  readonly maxBytes: number;
  readonly source?: AsyncIterable<Uint8Array>;
  /**
   * Overall deadline (ms) for the stdin read. statusline fires every
   * ~300 ms — a dangling pipe MUST not stall the UI. 0 disables (tests
   * only).
   */
  readonly timeoutMs?: number;
}

export type ReadStdinResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "error"; readonly message: string };

async function collect(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<ReadStdinResult> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        return { kind: "too-large", bytes: total };
      }
      chunks.push(chunk);
    }
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: "ok", text: Buffer.concat(chunks).toString("utf8") };
}

export async function readStdinAll(
  opts: ReadStdinOptions,
): Promise<ReadStdinResult> {
  const source = opts.source ?? (process.stdin as AsyncIterable<Uint8Array>);
  const timeoutMs = opts.timeoutMs ?? 0;
  if (timeoutMs <= 0) return collect(source, opts.maxBytes);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<ReadStdinResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "error", message: "stdin timeout" }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([collect(source, opts.maxBytes), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
