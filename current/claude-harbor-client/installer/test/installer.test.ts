/**
 * claude-harbor-install tests.
 *
 * Covers:
 *   - Install into a fresh $CLAUDE_HOME (mkdtempSync)
 *   - Idempotent install (second run doesn't duplicate entries, no extra backup)
 *   - Uninstall restores functional equivalence with pre-install state
 *   - Uninstall preserves user-modified entries with a warning
 *   - --dry-run does not write files
 *   - Malformed settings.json is rejected (exit 1)
 *   - Backup is created only once
 *   - Custom --harbor-url + --home flags
 *   - CLI-level flags: --help, --version, unknown command/flag
 *   - Default matcher is "" per CC hooks reference
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../src/install.ts";
import { runUninstall } from "../src/uninstall.ts";
import { main } from "../src/index.ts";
import {
  DEFAULT_CHANNEL_PLUGIN_MARKETPLACE,
  DEFAULT_CHANNEL_PLUGIN_NAME,
  MANAGED_HOOK_EVENTS,
} from "../src/types.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "claude-harbor-install-"));
}

function cleanup(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // swallow
  }
}

interface CapturedIO {
  readonly stdout: string[];
  readonly stderr: string[];
}

function makeIo(): CapturedIO & {
  readonly writeOut: (m: string) => void;
  readonly writeErr: (m: string) => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeOut: (m) => stdout.push(m),
    writeErr: (m) => stderr.push(m),
  };
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
}

function listBackups(home: string): string[] {
  return readdirSync(home).filter((f) => f.startsWith("settings.json.bak-"));
}

describe("install (fresh)", () => {
  test("creates settings.json with all managed hooks + statusLine + plugin + channelsEnabled", () => {
    const home = makeHome();
    try {
      const io = makeIo();
      const result = runInstall({
        home,
        harborUrl: "http://127.0.0.1:7823",
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(result.code).toBe(0);
      const s = readSettings(home);
      expect(typeof s.hooks).toBe("object");
      const hooks = s.hooks as Record<string, unknown[]>;
      for (const event of MANAGED_HOOK_EVENTS) {
        expect(hooks[event]).toBeDefined();
        expect(Array.isArray(hooks[event])).toBe(true);
        const bucket = hooks[event] as Array<Record<string, unknown>>;
        expect(bucket.length).toBe(1);
        expect(bucket[0]!.matcher).toBe("");
        const hs = bucket[0]!.hooks as Array<Record<string, string>>;
        expect(hs[0]!.type).toBe("command");
        expect(hs[0]!.command).toBe(`claude-harbor-hook ${event}`);
      }
      expect(s.statusLine).toEqual({
        type: "command",
        command: "claude-harbor-statusline",
      });
      expect(s.allowedChannelPlugins).toEqual([
        {
          marketplace: DEFAULT_CHANNEL_PLUGIN_MARKETPLACE,
          plugin: DEFAULT_CHANNEL_PLUGIN_NAME,
        },
      ]);
      expect(s.channelsEnabled).toBe(true);

      // Sidecar present.
      expect(existsSync(join(home, "claude-harbor-installed.json"))).toBe(true);
      // No backup on fresh install (nothing to back up).
      expect(listBackups(home)).toHaveLength(0);
    } finally {
      cleanup(home);
    }
  });

  test("creates exactly one backup on first install against pre-existing file", () => {
    const home = makeHome();
    try {
      // Put a user-authored settings.json in place.
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "/my/own.sh" } }, null, 2),
      );
      const io = makeIo();
      const result = runInstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(result.code).toBe(0);
      const backups = listBackups(home);
      expect(backups).toHaveLength(1);
      // Backup contains the original file bytes.
      const backupRaw = readFileSync(join(home, backups[0]!), "utf8");
      expect(JSON.parse(backupRaw).theme).toBe("dark");
      // User's statusLine preserved because ours didn't match.
      const s = readSettings(home);
      expect(s.statusLine).toEqual({ type: "command", command: "/my/own.sh" });
      // Warning surfaced.
      expect(io.stderr.some((l) => l.includes("statusLine"))).toBe(true);
    } finally {
      cleanup(home);
    }
  });

  test("idempotent: running install twice does not duplicate entries or create a second backup", () => {
    const home = makeHome();
    try {
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ keepMe: 1 }, null, 2),
      );
      const io1 = makeIo();
      runInstall({ home, env: {}, stdout: io1.writeOut, stderr: io1.writeErr });
      const firstSettings = readSettings(home);
      const firstBackups = listBackups(home);
      expect(firstBackups).toHaveLength(1);

      const io2 = makeIo();
      runInstall({ home, env: {}, stdout: io2.writeOut, stderr: io2.writeErr });
      const secondSettings = readSettings(home);
      const secondBackups = listBackups(home);

      expect(secondBackups).toEqual(firstBackups);
      expect(secondSettings).toEqual(firstSettings);
      // Second run should say "already present" on the skipped hooks.
      expect(io2.stdout.join("\n")).toContain("already present");
    } finally {
      cleanup(home);
    }
  });

  test("preserves unrelated user keys verbatim", () => {
    const home = makeHome();
    try {
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({
          theme: "mistral",
          model: "opus-4.5",
          customArray: [1, 2, 3],
          nested: { ok: true },
        }),
      );
      runInstall({
        home,
        env: {},
        stdout: () => {},
        stderr: () => {},
      });
      const s = readSettings(home);
      expect(s.theme).toBe("mistral");
      expect(s.model).toBe("opus-4.5");
      expect(s.customArray).toEqual([1, 2, 3]);
      expect(s.nested).toEqual({ ok: true });
    } finally {
      cleanup(home);
    }
  });

  test("preserves pre-existing user hook entry for same event", () => {
    const home = makeHome();
    try {
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [{ type: "command", command: "/my/setup.sh" }],
              },
            ],
          },
        }),
      );
      runInstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      const s = readSettings(home) as { hooks: Record<string, unknown[]> };
      const sessionStart = s.hooks.SessionStart as Array<Record<string, unknown>>;
      expect(sessionStart.length).toBe(2);
      expect(sessionStart[0]!.matcher).toBe("startup");
      expect(sessionStart[1]!.matcher).toBe("");
    } finally {
      cleanup(home);
    }
  });
});

describe("uninstall", () => {
  test("restores JSON equivalence with pre-install state", () => {
    const home = makeHome();
    try {
      const preInstall = { theme: "mistral", custom: { keep: true } };
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify(preInstall, null, 2),
      );
      runInstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      const io = makeIo();
      const result = runUninstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(result.code).toBe(0);
      const after = readSettings(home);
      expect(after).toEqual(preInstall);
      // Sidecar removed.
      expect(existsSync(join(home, "claude-harbor-installed.json"))).toBe(false);
    } finally {
      cleanup(home);
    }
  });

  test("fresh-install -> uninstall leaves an empty-ish settings.json", () => {
    const home = makeHome();
    try {
      runInstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      runUninstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      const s = readSettings(home);
      // hooks/statusLine/allowedChannelPlugins/channelsEnabled should all be gone.
      expect(s.hooks).toBeUndefined();
      expect(s.statusLine).toBeUndefined();
      expect(s.allowedChannelPlugins).toBeUndefined();
      expect(s.channelsEnabled).toBeUndefined();
    } finally {
      cleanup(home);
    }
  });

  test("preserves user-modified hook entry and warns", () => {
    const home = makeHome();
    try {
      runInstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      // User mucks with SessionStart — changes the command.
      const s = readSettings(home) as { hooks: Record<string, Array<{ hooks: Array<Record<string, string>> }>> };
      s.hooks.SessionStart[0]!.hooks[0]!.command = "my-own-script.sh";
      writeFileSync(join(home, "settings.json"), JSON.stringify(s));

      const io = makeIo();
      runUninstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      const after = readSettings(home) as { hooks?: Record<string, unknown> };
      // User's modified SessionStart still there.
      expect(after.hooks).toBeDefined();
      const ss = (after.hooks as Record<string, Array<{ hooks: Array<Record<string, string>> }>>).SessionStart;
      expect(ss).toBeDefined();
      expect(ss[0]!.hooks[0]!.command).toBe("my-own-script.sh");
      // Warning emitted.
      expect(io.stderr.some((l) => l.includes("WARNING") && l.includes("SessionStart"))).toBe(true);
    } finally {
      cleanup(home);
    }
  });

  test("no sidecar → exits 0 with hint", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, "settings.json"), "{}");
      const io = makeIo();
      const r = runUninstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(0);
      expect(io.stdout.some((l) => l.includes("nothing to uninstall"))).toBe(true);
    } finally {
      cleanup(home);
    }
  });

  test("malformed sidecar → exit 1, settings untouched", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, "settings.json"), "{}");
      writeFileSync(
        join(home, "claude-harbor-installed.json"),
        "not-json{{{",
      );
      const io = makeIo();
      const r = runUninstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(1);
    } finally {
      cleanup(home);
    }
  });
});

describe("--dry-run", () => {
  test("install --dry-run does not write files", () => {
    const home = makeHome();
    try {
      const io = makeIo();
      const r = runInstall({
        home,
        env: {},
        dryRun: true,
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(0);
      expect(existsSync(join(home, "settings.json"))).toBe(false);
      expect(existsSync(join(home, "claude-harbor-installed.json"))).toBe(false);
      expect(io.stdout.join("\n")).toContain("dry-run");
      expect(io.stdout.join("\n")).toContain("settings.json (post-merge)");
    } finally {
      cleanup(home);
    }
  });

  test("uninstall --dry-run does not write files", () => {
    const home = makeHome();
    try {
      runInstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      const before = readFileSync(join(home, "settings.json"), "utf8");
      const sidecarBefore = readFileSync(
        join(home, "claude-harbor-installed.json"),
        "utf8",
      );
      const io = makeIo();
      const r = runUninstall({
        home,
        env: {},
        dryRun: true,
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(0);
      const afterSettings = readFileSync(join(home, "settings.json"), "utf8");
      const afterSidecar = readFileSync(
        join(home, "claude-harbor-installed.json"),
        "utf8",
      );
      expect(afterSettings).toBe(before);
      expect(afterSidecar).toBe(sidecarBefore);
    } finally {
      cleanup(home);
    }
  });
});

describe("malformed input", () => {
  test("install on malformed settings.json → exit 1, file untouched", () => {
    const home = makeHome();
    try {
      const badContents = "{ this is not: json";
      writeFileSync(join(home, "settings.json"), badContents);
      const io = makeIo();
      const r = runInstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(1);
      expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(badContents);
      expect(io.stderr.some((l) => l.includes("malformed"))).toBe(true);
    } finally {
      cleanup(home);
    }
  });

  test("channelsEnabled=false is preserved with a warning", () => {
    const home = makeHome();
    try {
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ channelsEnabled: false }),
      );
      const io = makeIo();
      runInstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      const s = readSettings(home);
      expect(s.channelsEnabled).toBe(false);
      expect(io.stderr.some((l) => l.toLowerCase().includes("channelsenabled"))).toBe(
        true,
      );
    } finally {
      cleanup(home);
    }
  });
});

describe("URL validation", () => {
  test("rejects non-http(s) --harbor-url with exit 2", () => {
    const home = makeHome();
    try {
      const io = makeIo();
      const r = runInstall({
        home,
        harborUrl: "file:///etc/passwd",
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(2);
      expect(
        io.stderr.some((l) => l.toLowerCase().includes("not allowed")),
      ).toBe(true);
    } finally {
      cleanup(home);
    }
  });

  test("rejects malformed --harbor-url with exit 2", () => {
    const home = makeHome();
    try {
      const io = makeIo();
      const r = runInstall({
        home,
        harborUrl: "not a url at all",
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(2);
      expect(
        io.stderr.some((l) => l.toLowerCase().includes("not a valid url")),
      ).toBe(true);
    } finally {
      cleanup(home);
    }
  });

  test("strips userinfo from --harbor-url in sidecar + log", () => {
    const home = makeHome();
    try {
      const io = makeIo();
      const r = runInstall({
        home,
        harborUrl: "http://u:p@127.0.0.1:7823",
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(0);
      const sidecarRaw = readFileSync(
        join(home, "claude-harbor-installed.json"),
        "utf8",
      );
      expect(sidecarRaw).not.toContain("u:p");
      expect(sidecarRaw).toContain("127.0.0.1:7823");
      // Runtime log line must also be stripped.
      const runtimeLine = io.stdout.find((l) =>
        l.startsWith("  harbor URL (runtime):"),
      );
      expect(runtimeLine).toBeDefined();
      expect(runtimeLine!).not.toContain("u:p");
    } finally {
      cleanup(home);
    }
  });
});

describe("settings.json size cap", () => {
  test("install refuses a > 1 MiB settings.json with exit 1", () => {
    const home = makeHome();
    try {
      // Write a JSON file just over 1 MiB.
      const padding = "a".repeat(1024 * 1024 + 100);
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ huge: padding }),
      );
      const io = makeIo();
      const r = runInstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(1);
      expect(io.stderr.some((l) => l.toLowerCase().includes("too large"))).toBe(
        true,
      );
    } finally {
      cleanup(home);
    }
  });
});

describe("backup path", () => {
  test("backup filename includes iso timestamp + random suffix", () => {
    const home = makeHome();
    try {
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ theme: "dark" }),
      );
      runInstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      const backups = listBackups(home);
      expect(backups).toHaveLength(1);
      // Expect `settings.json.bak-<iso>-<4 hex>`.
      expect(backups[0]!).toMatch(
        /^settings\.json\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z-[0-9a-f]{4}$/,
      );
    } finally {
      cleanup(home);
    }
  });
});

describe("sidecar strict validation", () => {
  test("uninstall refuses sidecar missing required fields", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, "settings.json"), "{}");
      // A v1 sidecar that lacks settings_path / harbor_url / statusLine /
      // channel_plugin / set_channels_enabled.
      writeFileSync(
        join(home, "claude-harbor-installed.json"),
        JSON.stringify({
          version: 1,
          installed_at: "2026-01-01T00:00:00Z",
          hooks: {},
        }),
      );
      const io = makeIo();
      const r = runUninstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(1);
      expect(io.stderr.some((l) => l.includes("not a v1 sidecar"))).toBe(true);
    } finally {
      cleanup(home);
    }
  });
});

describe("hookEntry structural equality", () => {
  test("uninstall tolerates key-reordered hook entry", () => {
    const home = makeHome();
    try {
      runInstall({ home, env: {}, stdout: () => {}, stderr: () => {} });
      // Reorder keys inside the SessionStart hook entry: swap `hooks`
      // before `matcher`, and swap `command` before `type`.
      const s = readSettings(home) as {
        hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
      };
      const original = s.hooks.SessionStart[0]!;
      const reordered = {
        hooks: original.hooks.map((h) => ({
          command: h.command,
          type: h.type,
        })),
        matcher: original.matcher,
      };
      s.hooks.SessionStart[0] = reordered as never;
      writeFileSync(join(home, "settings.json"), JSON.stringify(s));

      const io = makeIo();
      const r = runUninstall({
        home,
        env: {},
        stdout: io.writeOut,
        stderr: io.writeErr,
      });
      expect(r.code).toBe(0);
      const after = readSettings(home) as { hooks?: Record<string, unknown> };
      // The reordered entry must have been treated as equal and removed.
      expect(after.hooks).toBeUndefined();
    } finally {
      cleanup(home);
    }
  });
});

describe("CLI main()", () => {
  test("--help writes help to stdout, exits 0", async () => {
    const originalOut = process.stdout.write.bind(process.stdout);
    let captured = "";
    (process.stdout as unknown as { write: (m: string) => boolean }).write = (m: string) => {
      captured += m;
      return true;
    };
    try {
      const code = await main(["--help"]);
      expect(code).toBe(0);
      expect(captured).toContain("claude-harbor-install");
    } finally {
      (process.stdout as unknown as { write: (m: string) => boolean }).write = originalOut as unknown as (m: string) => boolean;
    }
  });

  test("unknown command exits 2", async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (m: string) => boolean }).write = () => true;
    try {
      const code = await main(["wat"]);
      expect(code).toBe(2);
    } finally {
      (process.stderr as unknown as { write: (m: string) => boolean }).write = origErr as unknown as (m: string) => boolean;
    }
  });

  test("unknown flag exits 2", async () => {
    (process.stderr as unknown as { write: (m: string) => boolean }).write = () => true;
    const code = await main(["install", "--wat"]);
    expect(code).toBe(2);
  });
});

describe("end-to-end via bun run", () => {
  test("`install` then `uninstall` leaves pre-install bytes functionally equivalent", async () => {
    const home = makeHome();
    try {
      const preJson = { theme: "mistral", model: "opus" };
      writeFileSync(join(home, "settings.json"), JSON.stringify(preJson, null, 2));
      const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
      const BUN = process.execPath;
      const installProc = Bun.spawn({
        cmd: [BUN, "run", ENTRY, "install", "--home", home],
        stdout: "pipe",
        stderr: "pipe",
      });
      const installCode = await installProc.exited;
      expect(installCode).toBe(0);
      expect(existsSync(join(home, "claude-harbor-installed.json"))).toBe(true);

      const uninstallProc = Bun.spawn({
        cmd: [BUN, "run", ENTRY, "uninstall", "--home", home],
        stdout: "pipe",
        stderr: "pipe",
      });
      const uninstallCode = await uninstallProc.exited;
      expect(uninstallCode).toBe(0);

      const after = readSettings(home);
      expect(after).toEqual(preJson);
    } finally {
      cleanup(home);
    }
  }, 30_000);
});
