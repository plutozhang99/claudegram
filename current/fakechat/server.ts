#!/usr/bin/env bun
/**
 * Fake chat for Claude Code.
 *
 * Localhost web UI for testing the channel contract. No external service,
 * no tokens, no access control.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { join, extname, basename } from 'path'
import type { ServerWebSocket } from 'bun'
import { ClaudegramClient } from './src/claudegram-client'

// ---------------------------------------------------------------------------
// Phase 4.1 — Claudegram env vars (optional; empty = upstream-identical behavior)
// ---------------------------------------------------------------------------
const CLAUDEGRAM_URL = process.env.CLAUDEGRAM_URL ?? ''
const CLAUDEGRAM_SERVICE_TOKEN_ID = process.env.CLAUDEGRAM_SERVICE_TOKEN_ID ?? ''
const CLAUDEGRAM_SERVICE_TOKEN_SECRET = process.env.CLAUDEGRAM_SERVICE_TOKEN_SECRET ?? ''

// ---------------------------------------------------------------------------
// Phase 4.0 — Scope STATE_DIR per session
// ---------------------------------------------------------------------------
const SESSION_SCOPE = process.env.CLAUDE_SESSION_ID ?? `pid-${process.pid}`
const STATE_DIR = join(homedir(), '.claude', 'channels', 'fakechat', SESSION_SCOPE)
const INBOX_DIR = join(STATE_DIR, 'inbox')
const OUTBOX_DIR = join(STATE_DIR, 'outbox')

// Create STATE_DIR once at startup (subdirs are created lazily as before).
mkdirSync(STATE_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Phase 4.2 — Stable session_id helpers
// ---------------------------------------------------------------------------
export function generateUlid(): string {
  // Simple Crockford-base32 timestamp + random. Sufficient for session IDs —
  // collision risk is negligible and human-readable ordering by time isn't required.
  const TIME_LEN = 10
  const RAND_LEN = 16
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let ts = Date.now()
  let out = ''
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[ts % 32] + out
    ts = Math.floor(ts / 32)
  }
  for (let i = 0; i < RAND_LEN; i++) {
    out += ALPHABET[Math.floor(Math.random() * 32)]
  }
  return out
}

/**
 * Returns a stable session ID for the lifetime of this fakechat process.
 * Accepts stateDir so it can be called with a tmpdir during tests.
 */
export function getSessionId(stateDir: string = STATE_DIR): string {
  const fromEnv = process.env.CLAUDE_SESSION_ID
  if (fromEnv && fromEnv.length > 0) return fromEnv

  // Persist a ULID so it's stable across restarts within the same STATE_DIR scope.
  const sessionFile = join(stateDir, 'session_id')
  try {
    const existing = readFileSync(sessionFile, 'utf-8').trim()
    if (existing.length > 0) return existing
    // Empty file — fall through to ULID generation (treat as if file didn't exist).
  } catch {
    // File doesn't exist — fall through.
  }

  const id = generateUlid()
  try {
    writeFileSync(sessionFile, id, { flag: 'wx' })
    return id
  } catch {
    // Race or filesystem issue — try to read what's there.
    try {
      const retry = readFileSync(sessionFile, 'utf-8').trim()
      if (retry.length > 0) return retry
    } catch {
      // Final fallback — use the generated ULID even though we couldn't persist.
    }
    return id
  }
}

// SESSION_ID is available for Phase 4.3+ (webhook, registration, etc.).
const SESSION_ID = getSessionId(STATE_DIR)

// ---------------------------------------------------------------------------
// Phase P2.4 — ClaudegramClient (reverse WS + bounded retry queue)
// Instantiated only when CLAUDEGRAM_URL is set; otherwise fakechat is
// upstream-identical (§4.5 no-opt-in guarantee).
// ---------------------------------------------------------------------------
const client: ClaudegramClient | null = CLAUDEGRAM_URL
  ? new ClaudegramClient({
      url: CLAUDEGRAM_URL,
      serviceTokenId: CLAUDEGRAM_SERVICE_TOKEN_ID || undefined,
      serviceTokenSecret: CLAUDEGRAM_SERVICE_TOKEN_SECRET || undefined,
      sessionId: SESSION_ID,
    })
  : null

// ---------------------------------------------------------------------------
// Phase 4.3a — postIngest webhook helper
// ---------------------------------------------------------------------------
type IngestPayload = {
  session_id: string
  session_name?: string
  message: {
    id: string
    direction: 'assistant' | 'user'
    ts: number
    content: string
  }
}

type IngestConfig = {
  url: string
  tokenId: string
  tokenSecret: string
}

function defaultIngestConfig(): IngestConfig {
  return {
    url: CLAUDEGRAM_URL,
    tokenId: CLAUDEGRAM_SERVICE_TOKEN_ID,
    tokenSecret: CLAUDEGRAM_SERVICE_TOKEN_SECRET,
  }
}

export async function postIngest(
  payload: IngestPayload,
  cfg: IngestConfig = defaultIngestConfig(),
): Promise<void> {
  // Opted out — upstream-identical behavior.
  if (!cfg.url) return

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (cfg.tokenId && cfg.tokenSecret) {
    headers['CF-Access-Client-Id'] = cfg.tokenId
    headers['CF-Access-Client-Secret'] = cfg.tokenSecret
  }

  try {
    const res = await fetch(`${cfg.url}/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'ingest_webhook_failure',
          kind: 'non-2xx',
          status: res.status,
          err: `HTTP ${res.status}`,
        }) + '\n',
      )
    }
  } catch (err: unknown) {
    let kind: string
    if (
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      kind = 'timeout'
    } else if (err instanceof Error && (err.message.includes('ECONNREFUSED') || (err as NodeJS.ErrnoException).code === 'ECONNREFUSED')) {
      kind = 'refused'
    } else {
      kind = 'network'
    }
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: 'ingest_webhook_failure',
        kind,
        status: null,
        err: err instanceof Error ? err.message : String(err),
      }) + '\n',
    )
  }
}

// ---------------------------------------------------------------------------
// Phase 4.2b — Port auto-pick
// Bun.serve throws synchronously with EADDRINUSE — confirmed via manual test:
//   bun -e "Bun.serve({port: 22, ...})"  →  throws immediately, exit 1
// So a simple try/continue loop is sufficient; no async needed.
// ---------------------------------------------------------------------------
const explicitPort = process.env.FAKECHAT_PORT
const PORT_CANDIDATES = explicitPort
  ? [Number(explicitPort)]
  : [8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Msg = {
  id: string
  from: 'user' | 'assistant'
  text: string
  ts: number
  replyTo?: string
  file?: { url: string; name: string }
}

type Wire =
  | ({ type: 'msg' } & Msg)
  | { type: 'edit'; id: string; text: string }

const clients = new Set<ServerWebSocket<unknown>>()
let seq = 0

function nextId() {
  return `m${Date.now()}-${++seq}`
}

function broadcast(m: Wire) {
  const data = JSON.stringify(m)
  for (const ws of clients) if (ws.readyState === 1) ws.send(data)
}

function mime(ext: string) {
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  }
  return m[ext] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// startServer — wraps Bun.serve with port auto-pick retry
// ---------------------------------------------------------------------------
function startServer(tryPorts: number[]): ReturnType<typeof Bun.serve> {
  for (const p of tryPorts) {
    try {
      return Bun.serve({
        port: p,
        hostname: '127.0.0.1',
        fetch(req, server) {
          const url = new URL(req.url)

          if (url.pathname === '/ws') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((server as any).upgrade(req)) return undefined
            return new Response('upgrade failed', { status: 400 })
          }

          if (url.pathname.startsWith('/files/')) {
            const f = url.pathname.slice(7)
            if (f.includes('..') || f.includes('/')) return new Response('bad', { status: 400 })
            try {
              return new Response(readFileSync(join(OUTBOX_DIR, f)), {
                headers: { 'content-type': mime(extname(f).toLowerCase()) },
              })
            } catch {
              return new Response('404', { status: 404 })
            }
          }

          if (url.pathname === '/upload' && req.method === 'POST') {
            return (async () => {
              const form = await req.formData()
              const id = String(form.get('id') ?? '')
              const text = String(form.get('text') ?? '')
              const f = form.get('file')
              if (!id) return new Response('missing id', { status: 400 })
              let file: { path: string; name: string } | undefined
              if (f instanceof File && f.size > 0) {
                mkdirSync(INBOX_DIR, { recursive: true })
                const ext = extname(f.name).toLowerCase() || '.bin'
                const path = join(INBOX_DIR, `${Date.now()}${ext}`)
                writeFileSync(path, Buffer.from(await f.arrayBuffer()))
                file = { path, name: f.name }
              }
              deliver(id, text, file)
              return new Response(null, { status: 204 })
            })()
          }

          if (url.pathname === '/') {
            return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          return new Response('404', { status: 404 })
        },
        websocket: {
          open: ws => { clients.add(ws) },
          close: ws => { clients.delete(ws) },
          message: (_, raw) => {
            try {
              const { id, text } = JSON.parse(String(raw)) as { id: string; text: string }
              if (id && text?.trim()) deliver(id, text.trim())
            } catch {}
          },
        },
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') continue
      throw err
    }
  }
  throw new Error(`no free port in range ${tryPorts[0]}..${tryPorts[tryPorts.length - 1]}`)
}

// Bind the server — PORT is now known after this call.
const server = startServer(PORT_CANDIDATES)
const PORT = server.port

// ---------------------------------------------------------------------------
// MCP server — built AFTER PORT is known so instructions string is correct
// ---------------------------------------------------------------------------
const mcp = new Server(
  { name: 'fakechat', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: `The sender reads the fakechat UI, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches the UI.\n\nMessages from the fakechat web UI arrive as <channel source="fakechat" chat_id="web" message_id="...">. If the tag has a file_path attribute, Read that file — it is an upload from the UI. Reply with the reply tool. UI is at http://localhost:${PORT}.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message to the fakechat UI. Pass reply_to for quote-reply, files for attachments.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reply_to: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message.',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, text: { type: 'string' } },
        required: ['message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = args.text as string
        const replyTo = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []
        const ids: string[] = []

        // Text + files collapse into a single message, matching the client's [filename]-under-text rendering.
        mkdirSync(OUTBOX_DIR, { recursive: true })
        let file: { url: string; name: string } | undefined
        if (files[0]) {
          const f = files[0]
          const st = statSync(f)
          if (st.size > 50 * 1024 * 1024) throw new Error(`file too large: ${f}`)
          const ext = extname(f).toLowerCase()
          const out = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          copyFileSync(f, join(OUTBOX_DIR, out))
          file = { url: `/files/${out}`, name: basename(f) }
        }
        const id = nextId()
        broadcast({ type: 'msg', id, from: 'assistant', text, ts: Date.now(), replyTo, file })
        ids.push(id)
        client?.postIngest({
          session_id: SESSION_ID,
          session_name: undefined,
          message: {
            id,
            direction: 'assistant',
            ts: Date.now(),
            content: text,
          },
        }).catch((err: unknown) => {
          process.stderr.write(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: 'error',
              msg: 'postIngest_failed',
              err: err instanceof Error ? err.message : String(err),
            }) + '\n',
          )
        })
        return { content: [{ type: 'text', text: `sent (${ids.join(', ')})` }] }
      }
      case 'edit_message': {
        broadcast({ type: 'edit', id: args.message_id as string, text: args.text as string })
        return { content: [{ type: 'text', text: 'ok' }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// P2.4 — Wire ClaudegramClient: start reverse WS dial + register reply handler.
// The client is null when CLAUDEGRAM_URL is unset (upstream-identical behavior).
// ---------------------------------------------------------------------------
if (client !== null) {
  client.onReply(reply => {
    // Inbound reply from claudegram PWA → deliver to MCP as a user-direction message.
    // Pass _origin:'pwa' so deliver() skips the outbound /ingest POST (echo-dedup).
    deliver(reply.client_msg_id, reply.text, undefined, 'pwa')
  })
  client.start()
}

function deliver(
  id: string,
  text: string,
  file?: { path: string; name: string },
  origin?: 'pwa',
): void {
  // file_path goes in meta only — an in-content "[attached — Read: PATH]"
  // annotation is forgeable by typing that string into the UI.
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text || `(${file?.name ?? 'attachment'})`,
      meta: {
        chat_id: 'web', message_id: id, user: 'web', ts: new Date().toISOString(),
        ...(file ? { file_path: file.path } : {}),
      },
    },
  })

  // Echo-dedup (P2.4 Q1=a): when this message originated from claudegram (pwa),
  // it is already persisted there — skip the outbound /ingest POST to avoid
  // double-broadcasting the same message back.
  if (origin === 'pwa') return

  client?.postIngest({
    session_id: SESSION_ID,
    session_name: undefined,
    message: {
      id,
      direction: 'user',
      ts: Date.now(),
      content: text || `(${file?.name ?? 'attachment'})`,
    },
  }).catch((err: unknown) => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'postIngest_failed',
        err: err instanceof Error ? err.message : String(err),
      }) + '\n',
    )
  })
}

process.stderr.write(`fakechat: http://localhost:${PORT}\n`)

const HTML = `<!doctype html>
<meta charset="utf-8">
<title>fakechat</title>
<style>
body { font-family: monospace; margin: 0; padding: 1em 1em 7em; }
#log { white-space: pre-wrap; word-break: break-word; }
form { position: fixed; bottom: 0; left: 0; right: 0; padding: 1em; background: #fff; }
#text { width: 100%; box-sizing: border-box; font: inherit; margin-bottom: 0.5em; }
#file { display: none; }
#row { display: flex; gap: 1ch; }
#row button[type=submit] { margin-left: auto; }
</style>
<h3>fakechat</h3>
<pre id=log></pre>
<form id=form>
  <textarea id=text rows=2 autocomplete=off autofocus></textarea>
  <div id=row>
    <button type=button onclick="file.click()">attach</button><input type=file id=file>
    <span id=chip></span>
    <button type=submit>send</button>
  </div>
</form>

<script>
const log = document.getElementById('log')
document.getElementById('file').onchange = e => { const f = e.target.files[0]; chip.textContent = f ? '[' + f.name + ']' : '' }
const form = document.getElementById('form')
const input = document.getElementById('text')
const fileIn = document.getElementById('file')
const chip = document.getElementById('chip')
const msgs = {}

const ws = new WebSocket('ws://' + location.host + '/ws')
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.type === 'msg') add(m)
  if (m.type === 'edit') { const x = msgs[m.id]; if (x) { x.body.textContent = m.text + ' (edited)' } }
}

let uid = 0
form.onsubmit = e => {
  e.preventDefault()
  const text = input.value.trim()
  const file = fileIn.files[0]
  if (!text && !file) return
  input.value = ''; fileIn.value = ''; chip.textContent = ''
  const id = 'u' + Date.now() + '-' + (++uid)
  add({ id, from: 'user', text, file: file ? { url: URL.createObjectURL(file), name: file.name } : undefined })
  if (file) {
    const fd = new FormData(); fd.set('id', id); fd.set('text', text); fd.set('file', file)
    fetch('/upload', { method: 'POST', body: fd })
  } else {
    ws.send(JSON.stringify({ id, text }))
  }
}

function add(m) {
  const who = m.from === 'user' ? 'you' : 'bot'
  const el = line(who, m.text, m.replyTo, m.file)
  log.appendChild(el); scroll()
  msgs[m.id] = { body: el.querySelector('.body') }
}

function line(who, text, replyTo, file) {
  const div = document.createElement('div')
  const t = new Date().toTimeString().slice(0, 8)
  const reply = replyTo && msgs[replyTo] ? ' ↳ ' + (msgs[replyTo].body.textContent || '(file)').slice(0, 40) : ''
  div.innerHTML = '[' + t + '] <b>' + who + '</b>' + reply + ': <span class=body></span>'
  const body = div.querySelector('.body')
  body.textContent = text || ''
  if (file) {
    const indent = 11 + who.length + 2  // '[HH:MM:SS] ' + who + ': '
    if (text) body.appendChild(document.createTextNode('\\n' + ' '.repeat(indent)))
    const a = document.createElement('a')
    a.href = file.url; a.download = file.name; a.textContent = '[' + file.name + ']'
    body.appendChild(a)
  }
  return div
}

function scroll() { window.scrollTo(0, document.body.scrollHeight) }
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() } })
</script>
`
