# claude-harbor — workspace root

Three projects, one repo:

- **[`claude-harbor-server/`](./claude-harbor-server/)** — remote aggregator.
  One Bun process (Dockerised if you want) holding session state in SQLite,
  serving REST + WS, and shipping the frontend bundle at `/`. Runs on a box
  reachable from your CC machines.
- **[`claude-harbor-client/`](./claude-harbor-client/)** — local-side
  binaries. Install on each machine where you run Claude Code. Five
  packages (`wrapper`, `proxy`, `hook`, `statusline`, `installer`) wired
  together through the server.
- **[`claude-harbor-frontend/`](./claude-harbor-frontend/)** — Flutter Web
  PWA (P2). Session list + detail + compose. Consumes the server's REST
  endpoints and `WS /subscribe` for live updates. Mobile apps are P4.

Start with the [root README](../README.md) for the full build +
run workflow (`./scripts/build-frontend.sh`, `./scripts/dev.sh`), then
dive into each package README for details.
