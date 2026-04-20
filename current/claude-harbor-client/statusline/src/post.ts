/**
 * POST stdin JSON to the harbor server and parse the `line` field from
 * the response. Statusline fires every ~300 ms, so we cap network time
 * aggressively.
 */

export interface PostOptions {
  readonly url: string;
  readonly body: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export type PostResult =
  | { readonly kind: "ok"; readonly line: string | null }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-error"; readonly message: string }
  | { readonly kind: "bad-response"; readonly message: string };

export async function postStatusline(opts: PostOptions): Promise<PostResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
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
    if (!res.ok) return { kind: "http-error", status: res.status };
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      return {
        kind: "bad-response",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (!parsed || typeof parsed !== "object") {
      return { kind: "bad-response", message: "response not a JSON object" };
    }
    const line = (parsed as Record<string, unknown>).line;
    if (line === undefined || line === null) {
      return { kind: "ok", line: null };
    }
    if (typeof line !== "string") {
      return { kind: "bad-response", message: "`line` is not a string" };
    }
    return { kind: "ok", line };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { kind: "timeout" };
    }
    return {
      kind: "network-error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
