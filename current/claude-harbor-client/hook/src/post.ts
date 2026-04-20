/**
 * Best-effort HTTP POST helper with a hard deadline.
 *
 * Hooks MUST NOT block Claude Code. We aggressively time out and swallow
 * all network errors (reporting to stderr for operator debugging). Success
 * and timeout / error paths both resolve — callers always exit 0.
 */

export interface PostOptions {
  readonly url: string;
  readonly body: string;
  /** Timeout in ms. 0 disables the timeout (only useful for tests). */
  readonly timeoutMs: number;
  /** Test seam. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam. Defaults to stderr. */
  readonly logErr?: (msg: string) => void;
}

export type PostResult =
  | { readonly kind: "ok"; readonly status: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-error"; readonly message: string };

const DEFAULT_LOG_ERR = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * POST `body` as application/json to `url` with a hard timeout. Never
 * throws — callers can rely on the returned discriminated union.
 */
export async function postJson(opts: PostOptions): Promise<PostResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logErr = opts.logErr ?? DEFAULT_LOG_ERR;
  const controller = new AbortController();
  const timer =
    opts.timeoutMs > 0
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : null;
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body,
      signal: controller.signal,
    });
    return { kind: "ok", status: res.status };
  } catch (err) {
    // AbortError on timeout.
    if (err instanceof Error && err.name === "AbortError") {
      logErr(`claude-harbor-hook: POST ${opts.url} timed out after ${opts.timeoutMs}ms`);
      return { kind: "timeout" };
    }
    const message = stringifyErr(err);
    logErr(`claude-harbor-hook: POST ${opts.url} failed: ${message}`);
    return { kind: "network-error", message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
