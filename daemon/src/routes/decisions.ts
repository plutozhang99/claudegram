import { Hono } from 'hono'
import { z } from 'zod'
import type { DecisionQueue } from '../queue'
import type { SessionRegistry } from '../registry'
import type {
  CreateDecisionRequest,
  CreateDecisionResponse,
  PollDecisionResponse,
  ListDecisionsResponse,
  ErrorResponse,
  RequestId,
  SessionId,
} from '@claudegram/shared'
import { PERMISSION_CATEGORIES } from '@claudegram/shared'

const createDecisionSchema = z.object({
  sessionId: z.string().uuid(),
  sessionName: z.string().min(1).max(64),
  type: z.enum(['permission', 'custom']),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(100),
      }),
    )
    .min(2)
    .max(6),
  ttlSeconds: z.number().int().min(10).max(3600).optional(),
  // Optional — meaningful only for type:'permission'.  Bot uses this to render
  // category-specific copy without inspecting options[].label.
  category: z.enum(PERMISSION_CATEGORIES).optional(),
})

const uuidSchema = z.string().uuid()

export function createDecisionRoutes(queue: DecisionQueue, registry: SessionRegistry): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    // Avoid logging the raw error object (may include stack/internals) — log
    // only the narrowed message.
    console.error(
      '[decisions] handler error:',
      err instanceof Error ? err.message : String(err),
    )
    const body: ErrorResponse = { error: 'INTERNAL_ERROR', message: 'Internal server error.' }
    return c.json(body, 500)
  })

  // POST / — create a new decision
  app.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch (parseErr) {
      console.error(
        '[decisions] failed to parse request body:',
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      )
      const err: ErrorResponse = {
        error: 'VALIDATION_ERROR',
        message: 'Invalid JSON body.',
      }
      return c.json(err, 400)
    }

    const parsed = createDecisionSchema.safeParse(body)
    if (!parsed.success) {
      const err: ErrorResponse = {
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      }
      return c.json(err, 400)
    }

    const req: CreateDecisionRequest = {
      ...parsed.data,
      sessionId: parsed.data.sessionId as SessionId,
    }

    const result = queue.create(req)
    if (!result.ok) {
      return c.json(result.error, 400)
    }

    // Touch the session to mark activity
    registry.touch(req.sessionId)

    const response: CreateDecisionResponse = {
      requestId: result.data.requestId,
      status: 'pending',
    }
    return c.json(response, 201)
  })

  // GET /:requestId — long-poll (blocks up to 30s)
  app.get('/:requestId', async (c) => {
    const rawId = c.req.param('requestId')
    const parsed = uuidSchema.safeParse(rawId)
    if (!parsed.success) {
      const err: ErrorResponse = {
        error: 'DECISION_NOT_FOUND',
        message: 'Invalid request ID.',
      }
      return c.json(err, 404)
    }

    const requestId = parsed.data as RequestId
    // Pass the request's AbortSignal so the poller is cleaned up on client disconnect (Option A).
    const decision = await queue.poll(requestId, 30_000, c.req.raw.signal)

    if (decision === undefined) {
      const err: ErrorResponse = {
        error: 'DECISION_NOT_FOUND',
        message: `Decision "${requestId}" not found.`,
      }
      return c.json(err, 404)
    }

    let response: PollDecisionResponse
    if (decision.status === 'answered') {
      response = {
        requestId: decision.requestId,
        status: 'answered',
        answer: decision.answer,
      }
    } else {
      response = {
        requestId: decision.requestId,
        status: decision.status,
      }
    }

    return c.json(response, 200)
  })

  // GET / — list all decisions
  app.get('/', (c) => {
    const response: ListDecisionsResponse = {
      decisions: queue.getAll(),
    }
    return c.json(response, 200)
  })

  // DELETE /:requestId — cancel a decision
  app.delete('/:requestId', (c) => {
    const rawId = c.req.param('requestId')
    const parsed = uuidSchema.safeParse(rawId)
    if (!parsed.success) {
      const err: ErrorResponse = {
        error: 'DECISION_NOT_FOUND',
        message: 'Invalid request ID.',
      }
      return c.json(err, 404)
    }

    const requestId = parsed.data as RequestId
    const result = queue.cancel(requestId)

    if (!result.ok) {
      return c.json(result.error, 404)
    }

    return new Response(null, { status: 204 })
  })

  return app
}
