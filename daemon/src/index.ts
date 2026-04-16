import { Hono } from 'hono'
import { loadConfig } from './config'
import { acquirePidLock, releasePidLock } from './pid'
import { SessionRegistry } from './registry'
import { DecisionQueue } from './queue'
import { createSessionRoutes } from './routes/sessions'
import { createDecisionRoutes } from './routes/decisions'
import type { HealthResponse, ErrorResponse } from '@claudegram/shared'

// Validate environment configuration before anything else — exits with code 1 on failure
const config = loadConfig()
process.stderr.write('[claudegram-daemon] Config loaded\n')

const PORT = config.CLAUDEGRAM_PORT
const registry = new SessionRegistry()
const queue = new DecisionQueue()

// Acquire PID lock — exit immediately if the daemon is already running
try {
  acquirePidLock()
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : 'Unknown error'
  process.stderr.write(`[claudegram-daemon] Failed to start: ${msg}\n`)
  process.exit(1)
}

// Graceful shutdown handlers
function shutdown(): void {
  queue.destroy()
  releasePidLock()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const app = new Hono()

// Mount session routes
app.route('/api/sessions', createSessionRoutes(registry))

// Mount decision routes
app.route('/api/decisions', createDecisionRoutes(queue, registry))

// GET /api/health
app.get('/api/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    uptime: registry.uptimeSeconds(),
    sessions: registry.getAll().length,
    pendingDecisions: queue.pendingCount(),
  }
  return c.json(body)
})

// 404 fallback
app.notFound((c) => {
  const err: ErrorResponse = { error: 'INTERNAL_ERROR', message: 'Not found' }
  return c.json(err, 404)
})

export default {
  port: PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
}
