import { describe, it, expect, mock } from 'bun:test';
import type { MessageRepo, Message } from '../../repo/types.js';
import type { Logger } from '../../logger.js';
import { handleApiMessages } from './messages.js';

function makeReq(method: string, qs = ''): Request {
  const url = `http://localhost/api/messages${qs ? '?' + qs : ''}`;
  return new Request(url, { method });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const sampleMessages: ReadonlyArray<Message> = [
  {
    session_id: 's1',
    id: 'm1',
    direction: 'user',
    ts: 1000,
    ingested_at: 1001,
    content: 'hello',
  },
];

function makeRepo(msgRepo: MessageRepo) {
  return { msgRepo, logger: noopLogger };
}

describe('handleApiMessages', () => {
  it('GET without session_id → 400 with issues', async () => {
    const repo = makeRepo({
      insert: () => {},
      findBySession: () => [],
      findBySessionPage: () => ({ messages: [], has_more: false }),
      findById: () => null,
      deleteBySession: () => {},
    });
    const r = await handleApiMessages(makeReq('GET'), repo);
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('invalid query');
    expect(Array.isArray(body.issues)).toBe(true);
    expect((body.issues as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET with session_id=s1 → calls findBySessionPage with correct args', async () => {
    const findBySessionPage = mock((_sid: string, _opts?: { before_id?: string; limit?: number }) => ({
      messages: sampleMessages,
      has_more: false,
    }));
    const repo = makeRepo({
      insert: () => {},
      findBySession: () => [],
      findBySessionPage,
      findById: () => null,
      deleteBySession: () => {},
    });

    const r = await handleApiMessages(makeReq('GET', 'session_id=s1'), repo);
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.ok).toBe(true);
    expect(body.has_more).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);

    expect(findBySessionPage).toHaveBeenCalledTimes(1);
    expect(findBySessionPage).toHaveBeenCalledWith('s1', {
      before_id: undefined,
      limit: undefined,
    });
  });

  it('GET with session_id=s1&before=m9&limit=10 → calls findBySessionPage with cursor+limit', async () => {
    const findBySessionPage = mock((_sid: string, _opts?: { before_id?: string; limit?: number }) => ({
      messages: [],
      has_more: false,
    }));
    const repo = makeRepo({
      insert: () => {},
      findBySession: () => [],
      findBySessionPage,
      findById: () => null,
      deleteBySession: () => {},
    });

    await handleApiMessages(makeReq('GET', 'session_id=s1&before=m9&limit=10'), repo);

    expect(findBySessionPage).toHaveBeenCalledWith('s1', {
      before_id: 'm9',
      limit: 10,
    });
  });

  it('GET with limit=abc → 400 (unparseable int)', async () => {
    const repo = makeRepo({
      insert: () => {},
      findBySession: () => [],
      findBySessionPage: () => ({ messages: [], has_more: false }),
      findById: () => null,
      deleteBySession: () => {},
    });
    const r = await handleApiMessages(makeReq('GET', 'session_id=s1&limit=abc'), repo);
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('invalid query');
  });

  it('GET with limit=-1 → accepted; repo called with limit:-1', async () => {
    const findBySessionPage = mock((_sid: string, _opts?: { before_id?: string; limit?: number }) => ({
      messages: [],
      has_more: false,
    }));
    const repo = makeRepo({
      insert: () => {},
      findBySession: () => [],
      findBySessionPage,
      findById: () => null,
      deleteBySession: () => {},
    });

    const r = await handleApiMessages(makeReq('GET', 'session_id=s1&limit=-1'), repo);
    expect(r.status).toBe(200);
    expect(findBySessionPage).toHaveBeenCalledWith('s1', {
      before_id: undefined,
      limit: -1,
    });
  });

  it('POST → 405 method not allowed', async () => {
    const repo = makeRepo({
      insert: () => {},
      findBySession: () => [],
      findBySessionPage: () => ({ messages: [], has_more: false }),
      findById: () => null,
      deleteBySession: () => {},
    });
    const r = await handleApiMessages(makeReq('POST'), repo);
    expect(r.status).toBe(405);
    const body = await json(r);
    expect(body).toEqual({ ok: false, error: 'method not allowed' });
  });

  it('returns 500 when repo throws', async () => {
    const errors: Array<[string, Record<string, unknown>]> = [];
    const errorLogger: Logger = {
      ...noopLogger,
      error: (msg, fields) => { errors.push([msg, fields ?? {}]); },
    };

    const throwingRepo = {
      msgRepo: {
        insert: () => {},
        findBySession: () => [],
        findBySessionPage: (): never => { throw new Error('DB exploded'); },
        findById: () => null,
        deleteBySession: () => {},
      } satisfies MessageRepo,
      logger: errorLogger,
    };

    const r = await handleApiMessages(makeReq('GET', 'session_id=s1'), throwingRepo);
    expect(r.status).toBe(500);
    const body = await json(r);
    expect(body).toEqual({ ok: false, error: 'internal error' });
    expect(errors.length).toBe(1);
    expect(errors[0]![0]).toBe('messages_list_failed');
    expect(errors[0]![1]['session_id']).toBe('s1');
  });
});
