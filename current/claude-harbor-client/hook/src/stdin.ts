/**
 * Read all of stdin as a UTF-8 string. Caps size to `maxBytes` to defend
 * against pathologically large hook payloads (CC bounds them in practice;
 * this is belt-and-braces).
 */

export interface ReadStdinOptions {
  readonly maxBytes: number;
  /** Test seam: AsyncIterable of Uint8Array chunks. Defaults to process.stdin. */
  readonly source?: AsyncIterable<Uint8Array>;
  /**
   * Overall deadline (ms) for the stdin read. If the upstream process
   * never closes stdin we must NOT hang — hooks / statusline have tight
   * budgets. 0 disables (tests only).
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
  if (timeoutMs <= 0) {
    return collect(source, opts.maxBytes);
  }
  // Race the read against the deadline. On timeout we return an error
  // and let the caller decide how to degrade.
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
