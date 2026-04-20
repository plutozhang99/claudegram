/**
 * claude-harbor wrapper tests.
 *
 * Covers the P0.3 CLI contract:
 *   - --version / --help / no-args / unknown command → stdout + exit code
 *   - CLAUDE_BIN resolution (happy path, missing file, bad PATH)
 *   - Positive PATH resolution (no CLAUDE_BIN)
 *   - Channel plugin --channels injection semantics
 *   - HARBOR_CHANNEL_SPEC validation (invalid rejected, valid logged)
 *   - SIGTERM forwarding to the child claude (deterministic via READY sentinel)
 *
 * We always invoke the wrapper via `bun run src/index.ts` so we exercise
 * the actual entrypoint, not the exported `main` (keeps tests honest about
 * exit codes / stderr routing).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER_ROOT = resolve(HERE, "..");
const ENTRY = resolve(WRAPPER_ROOT, "src/index.ts");
const FAKE_CLAUDE = resolve(HERE, "fixtures/fake-claude.sh");
const FAKE_SIGTERM_CLAUDE = resolve(HERE, "fixtures/fake-claude-sigterm.sh");
const PATH_BIN_DIR = resolve(HERE, "fixtures/path-bin");
const BUN_BIN = process.execPath;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}

async function runWrapper(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [BUN_BIN, "run", ENTRY, ...args],
    cwd: WRAPPER_ROOT,
    env: sanitizeEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("claude-harbor CLI", () => {
  test("--version prints a semver-looking string on stdout, exit 0", async () => {
    const r = await runWrapper(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.stderr).toBe("");
  });

  test("-v alias works", async () => {
    const r = await runWrapper(["-v"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--help prints usage with 'claude-harbor start' on stdout, exit 0", async () => {
    const r = await runWrapper(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("claude-harbor start");
    // Help text is short; allow up to 25 lines for the expanded body.
    expect(r.stdout.split("\n").length).toBeLessThanOrEqual(25);
  });

  test("no args prints help and exits 0", async () => {
    const r = await runWrapper([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("claude-harbor start");
  });

  test("unknown command → stderr contains 'unknown' (ci), exit 2", async () => {
    const r = await runWrapper(["bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("unknown");
  });

  test("start forwards argv to claude and injects --channels by default", async () => {
    // HARBOR_NO_CHANNEL is NOT set; wrapper should inject --channels.
    const r = await runWrapper(["start", "foo", "--bar", "baz"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: FAKE_CLAUDE,
    });
    expect(r.code).toBe(0);
    // Exit code comes from fake-claude, which is 0.
    const args = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    // Expect --channels plugin:claude-harbor@local prepended ahead of user argv.
    expect(args).toEqual([
      "--channels",
      "plugin:claude-harbor@local",
      "foo",
      "--bar",
      "baz",
    ]);
  });

  test("HARBOR_NO_CHANNEL=1 skips --channels injection", async () => {
    const r = await runWrapper(["start", "foo", "--bar", "baz"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: FAKE_CLAUDE,
      HARBOR_NO_CHANNEL: "1",
    });
    expect(r.code).toBe(0);
    const args = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    expect(args).toEqual(["foo", "--bar", "baz"]);
  });

  test("HARBOR_CHANNEL_SPEC overrides the default plugin spec and is logged", async () => {
    const r = await runWrapper(["start", "x"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: FAKE_CLAUDE,
      HARBOR_CHANNEL_SPEC: "plugin:custom@elsewhere",
    });
    expect(r.code).toBe(0);
    const args = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    expect(args).toEqual(["--channels", "plugin:custom@elsewhere", "x"]);
    // The effective spec should be logged to stderr at startup.
    expect(r.stderr).toContain("using channel spec: plugin:custom@elsewhere");
  });

  test("invalid HARBOR_CHANNEL_SPEC → exit 2 with clear error on stderr", async () => {
    const r = await runWrapper(["start", "x"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: FAKE_CLAUDE,
      // Missing the @marketplace half and contains invalid characters.
      HARBOR_CHANNEL_SPEC: "not a valid spec!",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid HARBOR_CHANNEL_SPEC");
    expect(r.stderr).toContain("plugin:<name>@<marketplace>");
  });

  test("user-supplied --channels is respected, no duplicate injection", async () => {
    const r = await runWrapper(
      ["start", "--channels", "plugin:other@foo", "rest"],
      {
        PATH: process.env.PATH ?? "",
        CLAUDE_BIN: FAKE_CLAUDE,
      },
    );
    expect(r.code).toBe(0);
    const args = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    expect(args).toEqual(["--channels", "plugin:other@foo", "rest"]);
  });

  test("user-supplied --channels with no value is passed through verbatim (no duplicate injection)", async () => {
    // Edge case: the user typed `--channels` with no following value. The
    // wrapper must NOT react by injecting its own `--channels <default>`
    // — the user's token must be forwarded as-is so `claude` can produce
    // its own missing-value error message, and we must not produce a
    // duplicate `--channels` on the command line.
    const r = await runWrapper(["start", "--channels"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: FAKE_CLAUDE,
    });
    expect(r.code).toBe(0);
    const args = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    expect(args).toEqual(["--channels"]);
  });

  test("fake claude exit code propagates", async () => {
    const r = await runWrapper(["start"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_EXIT: "7",
      HARBOR_NO_CHANNEL: "1",
    });
    expect(r.code).toBe(7);
  });

  test("CLAUDE_BIN=/nonexistent → exit 127 with error on stderr", async () => {
    const r = await runWrapper(["start"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: "/nonexistent/really-not-here",
    });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("claude-harbor:");
  });

  test("CLAUDE_BIN relative path → exit 127 (must be absolute)", async () => {
    const r = await runWrapper(["start"], {
      PATH: process.env.PATH ?? "",
      CLAUDE_BIN: "relative/claude",
    });
    expect(r.code).toBe(127);
    expect(r.stderr.toLowerCase()).toContain("absolute");
  });

  test("no CLAUDE_BIN and empty PATH → exit 127 with install hint", async () => {
    const r = await runWrapper(["start"], { PATH: "" });
    expect(r.code).toBe(127);
    expect(r.stderr.toLowerCase()).toContain("install");
  });

  test("PATH resolution: no CLAUDE_BIN, fake claude on PATH receives forwarded args", async () => {
    // Set PATH to ONLY our fixture dir so `claude` must resolve to the
    // fake binary in path-bin/. CLAUDE_BIN is left unset on purpose.
    const r = await runWrapper(["start", "foo", "--bar"], {
      PATH: PATH_BIN_DIR,
      HARBOR_NO_CHANNEL: "1",
    });
    expect(r.code).toBe(0);
    const args = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    expect(args).toEqual(["foo", "--bar"]);
  });

  test("SIGTERM forwarded to child claude (writes marker file)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-harbor-sigterm-"));
    const marker = join(tmp, "marker.txt");
    try {
      const proc = Bun.spawn({
        cmd: [BUN_BIN, "run", ENTRY, "start"],
        cwd: WRAPPER_ROOT,
        env: sanitizeEnv({
          PATH: process.env.PATH ?? "",
          CLAUDE_BIN: FAKE_SIGTERM_CLAUDE,
          MARKER: marker,
          HARBOR_NO_CHANNEL: "1",
        }),
        stdout: "pipe",
        stderr: "pipe",
      });

      // Wait deterministically for the fake claude to print READY —
      // signalling its SIGTERM trap is installed and the process is live.
      // This replaces a racy fixed-duration sleep.
      const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
      const reader = stdoutStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ready = false;
      while (!ready) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.split("\n").some((line) => line.trim() === "READY")) {
          ready = true;
        }
      }
      reader.releaseLock();
      expect(ready).toBe(true);

      proc.kill("SIGTERM");
      const code = await proc.exited;

      // The fake traps TERM and exits 143; wrapper propagates.
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8").trim()).toBe("sigterm");
      // 143 = 128 + 15 (SIGTERM)
      expect([143, 128 + 15]).toContain(code);
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failure */
      }
    }
  }, 10_000);
});

describe("buildChildArgv unit", () => {
  test("default spec injected when no env override", async () => {
    const mod = await import("../src/start.ts");
    expect(mod.buildChildArgv(["--model", "sonnet"], {})).toEqual([
      "--channels",
      "plugin:claude-harbor@local",
      "--model",
      "sonnet",
    ]);
  });

  test("HARBOR_NO_CHANNEL=1 preserves user argv verbatim", async () => {
    const mod = await import("../src/start.ts");
    expect(mod.buildChildArgv(["a", "b"], { HARBOR_NO_CHANNEL: "1" })).toEqual([
      "a",
      "b",
    ]);
  });

  test("user-supplied --channels flag prevents duplicate injection", async () => {
    const mod = await import("../src/start.ts");
    expect(
      mod.buildChildArgv(["--channels", "plugin:x@y"], {}),
    ).toEqual(["--channels", "plugin:x@y"]);
    expect(
      mod.buildChildArgv(["--channels=plugin:x@y"], {}),
    ).toEqual(["--channels=plugin:x@y"]);
  });

  test("lone --channels with no value is passed through verbatim", async () => {
    const mod = await import("../src/start.ts");
    expect(mod.buildChildArgv(["--channels"], {})).toEqual(["--channels"]);
  });
});
