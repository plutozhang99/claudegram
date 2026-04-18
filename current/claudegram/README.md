# claudegram

Claudegram is a lightweight message-ingestion server that receives conversation events from fakechat instances and persists them to SQLite, keyed by session.

---

### Manual multi-session verification (spec §8.5 pt 6 equivalent)

To confirm that two fakechat processes with distinct sessions both land in claudegram with correct attribution:

1. Start claudegram:
   ```bash
   cd current/claudegram && bun run src/main.ts
   # Observes: server_ready { port: 8788 }
   ```

2. In two separate terminals, start two fakechat instances:
   ```bash
   # Terminal A
   cd current/fakechat && CLAUDE_SESSION_ID=alice CLAUDEGRAM_URL=http://localhost:8788 bun server.ts

   # Terminal B
   cd current/fakechat && CLAUDE_SESSION_ID=bob CLAUDEGRAM_URL=http://localhost:8788 bun server.ts
   ```

   (Note: fakechat auto-picks port 8788/8789 because claudegram is on 8788.)

3. Open each fakechat UI in a separate browser tab (URLs printed to stderr on startup).

4. Type a message in each. Verify claudegram log shows two ingest events with distinct `session_id`s.

5. Inspect the SQLite DB:
   ```bash
   sqlite3 current/claudegram/data/claudegram.db "SELECT id, name FROM sessions;"
   sqlite3 current/claudegram/data/claudegram.db "SELECT session_id, id, direction, content FROM messages ORDER BY ts;"
   ```

   Expected: two session rows (`alice`, `bob`); each message correctly attributed to its session.
