import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { jsonResponse } from '../http.js';
import type { RouterCtx } from '../http.js';

export const INGEST_MAX_BODY_BYTES = 1_048_576; // 1 MiB

const METHOD_NOT_ALLOWED = { ok: false, error: 'method not allowed' } as const;
const PAYLOAD_TOO_LARGE = { ok: false, error: 'payload too large' } as const;
const INVALID_CONTENT_LENGTH = { ok: false, error: 'invalid content-length' } as const;
const INVALID_BODY = { ok: false, error: 'invalid body' } as const;
const INVALID_JSON = { ok: false, error: 'invalid json' } as const;
const INTERNAL_ERROR = { ok: false, error: 'internal error' } as const;

export const ingestSchema = z.object({
  session_id: z.string().min(1).max(256),
  session_name: z.string().min(1).max(256).optional(),
  message: z.object({
    id: z.string().min(1).max(256),
    direction: z.enum(['assistant', 'user']),
    ts: z.number().int().nonnegative(),
    // content is deliberately allowed to be empty: fakechat's file-only messages
    // upstream send zero text with an attachment payload; we preserve that shape.
    content: z.string().max(1_000_000),
  }),
});

export type IngestPayload = z.infer<typeof ingestSchema>;

export async function handleIngest(
  req: Request,
  deps: Pick<RouterCtx, 'msgRepo' | 'sessRepo' | 'logger'>,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse(405, METHOD_NOT_ALLOWED);
  }

  // Check Content-Length header first (fast rejection).
  // Guard against non-numeric or negative values to prevent NaN bypass.
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number(contentLength);
    if (!Number.isFinite(len) || len < 0) {
      return jsonResponse(400, INVALID_CONTENT_LENGTH);
    }
    if (len > INGEST_MAX_BODY_BYTES) {
      return jsonResponse(413, PAYLOAD_TOO_LARGE);
    }
  }

  // Stream body with a hard cap to prevent unbounded buffering when
  // Content-Length is absent or lies.
  const reader = req.body?.getReader();
  if (!reader) {
    return jsonResponse(400, INVALID_BODY);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > INGEST_MAX_BODY_BYTES) {
        await reader.cancel();
        return jsonResponse(413, PAYLOAD_TOO_LARGE);
      }
      chunks.push(value);
    }
  } catch {
    return jsonResponse(400, INVALID_BODY);
  }
  const bodyText = Buffer.concat(chunks).toString('utf-8');

  let parsed: unknown;
  try {
    // P1: depth-limit to prevent stack-overflow on malicious bodies. Acceptable at P0 (localhost + trusted client).
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse(400, INVALID_JSON);
  }

  const result = ingestSchema.safeParse(parsed);
  if (!result.success) {
    return jsonResponse(400, { ok: false, error: 'invalid payload', issues: result.error.issues });
  }

  const { session_id, session_name, message } = result.data;

  try {
    // P1: wrap session upsert + message insert in a single transaction to prevent orphan session on insert failure.
    deps.sessRepo.upsert({ id: session_id, name: session_name ?? session_id, now: Date.now() });
    deps.msgRepo.insert({
      session_id,
      id: message.id,
      direction: message.direction,
      ts: message.ts,
      content: message.content,
    });
  } catch (err: unknown) {
    deps.logger.error('ingest_failed', {
      err: String(err),
      session_id,
      message_id: message.id,
    });
    return jsonResponse(500, INTERNAL_ERROR);
  }

  return jsonResponse(200, { ok: true, message_id: message.id });
}
