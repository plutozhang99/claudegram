# claude-harbor — workspace root

Two projects, one repo:

- **[`claude-harbor-server/`](./claude-harbor-server/)** — remote aggregator.
  One Bun process (Dockerised if you want) holding session state in SQLite.
  Runs on a box reachable from your CC machines.
- **[`claude-harbor-client/`](./claude-harbor-client/)** — local-side
  binaries. Install on each machine where you run Claude Code. Five
  packages (`wrapper`, `proxy`, `hook`, `statusline`, `installer`) wired
  together through the server.

Start with the server's README to get it running, then each CC machine
follows the client's README.
