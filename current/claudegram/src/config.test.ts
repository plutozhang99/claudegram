import { describe, it, expect } from "bun:test";
import { ZodError } from "zod";
import { loadConfig, configSchema } from "./config.js";

describe("configSchema defaults", () => {
  it("returns defaults when all env vars are unset", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8788);
    expect(config.db_path).toBe("./data/claudegram.db");
    expect(config.log_level).toBe("info");
  });
});

describe("CLAUDEGRAM_PORT", () => {
  it("coerces a valid string port to integer", () => {
    const config = loadConfig({ CLAUDEGRAM_PORT: "9000" });
    expect(config.port).toBe(9000);
  });

  it("throws ZodError when port is 0 (below range)", () => {
    expect(() => loadConfig({ CLAUDEGRAM_PORT: "0" })).toThrow(ZodError);
  });

  it("throws ZodError when port is 65536 (above range)", () => {
    expect(() => loadConfig({ CLAUDEGRAM_PORT: "65536" })).toThrow(ZodError);
  });

  it("throws ZodError when port is non-numeric string", () => {
    expect(() => loadConfig({ CLAUDEGRAM_PORT: "abc" })).toThrow(ZodError);
  });
});

describe("CLAUDEGRAM_DB_PATH", () => {
  it("throws ZodError when db_path is empty string", () => {
    expect(() => loadConfig({ CLAUDEGRAM_DB_PATH: "" })).toThrow(ZodError);
  });

  it("accepts a valid custom db_path", () => {
    const config = loadConfig({ CLAUDEGRAM_DB_PATH: "/tmp/x.db" });
    expect(config.db_path).toBe("/tmp/x.db");
  });
});

describe("CLAUDEGRAM_LOG_LEVEL", () => {
  it("accepts 'debug'", () => {
    const config = loadConfig({ CLAUDEGRAM_LOG_LEVEL: "debug" });
    expect(config.log_level).toBe("debug");
  });

  it("accepts 'info'", () => {
    const config = loadConfig({ CLAUDEGRAM_LOG_LEVEL: "info" });
    expect(config.log_level).toBe("info");
  });

  it("accepts 'warn'", () => {
    const config = loadConfig({ CLAUDEGRAM_LOG_LEVEL: "warn" });
    expect(config.log_level).toBe("warn");
  });

  it("accepts 'error'", () => {
    const config = loadConfig({ CLAUDEGRAM_LOG_LEVEL: "error" });
    expect(config.log_level).toBe("error");
  });

  it("throws ZodError for unknown level 'trace'", () => {
    expect(() => loadConfig({ CLAUDEGRAM_LOG_LEVEL: "trace" })).toThrow(
      ZodError
    );
  });
});

describe("explicit env object isolation", () => {
  it("uses the passed env object and ignores process.env", () => {
    // Set a known value in process.env to confirm it is NOT used
    const original = process.env.CLAUDEGRAM_PORT;
    process.env.CLAUDEGRAM_PORT = "1111";

    try {
      // Pass an explicit env with a different port
      const config = loadConfig({ CLAUDEGRAM_PORT: "7777" });
      expect(config.port).toBe(7777);
    } finally {
      // Restore original state
      if (original === undefined) {
        delete process.env.CLAUDEGRAM_PORT;
      } else {
        process.env.CLAUDEGRAM_PORT = original;
      }
    }
  });

  it("uses only the passed env object (no process.env bleed-through) when port absent from explicit env", () => {
    const original = process.env.CLAUDEGRAM_PORT;
    process.env.CLAUDEGRAM_PORT = "2222";

    try {
      // Explicit env has no CLAUDEGRAM_PORT → should use default 8788, not 2222
      const config = loadConfig({});
      expect(config.port).toBe(8788);
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDEGRAM_PORT;
      } else {
        process.env.CLAUDEGRAM_PORT = original;
      }
    }
  });
});

describe("ZodError type verification", () => {
  it("thrown error is instanceof ZodError", () => {
    let caught: unknown;
    try {
      loadConfig({ CLAUDEGRAM_PORT: "99999" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZodError);
  });
});

describe("CLAUDEGRAM_DB_PATH — path traversal", () => {
  it("throws ZodError for '../../etc/passwd'", () => {
    expect(() => loadConfig({ CLAUDEGRAM_DB_PATH: "../../etc/passwd" })).toThrow(ZodError);
  });

  it("throws ZodError for './data/../../etc/x.db'", () => {
    expect(() => loadConfig({ CLAUDEGRAM_DB_PATH: "./data/../../etc/x.db" })).toThrow(ZodError);
  });

  it("still accepts '/tmp/x.db' (no traversal segments)", () => {
    const config = loadConfig({ CLAUDEGRAM_DB_PATH: "/tmp/x.db" });
    expect(config.db_path).toBe("/tmp/x.db");
  });
});

describe("CLAUDEGRAM_PORT — string regex validation", () => {
  it("throws ZodError for empty string ''", () => {
    expect(() => loadConfig({ CLAUDEGRAM_PORT: "" })).toThrow(ZodError);
  });

  it("throws ZodError for padded string '  8080 '", () => {
    expect(() => loadConfig({ CLAUDEGRAM_PORT: "  8080 " })).toThrow(ZodError);
  });

  it("throws ZodError for negative '-1'", () => {
    expect(() => loadConfig({ CLAUDEGRAM_PORT: "-1" })).toThrow(ZodError);
  });
});

describe("configSchema export", () => {
  it("configSchema is a Zod object schema", () => {
    // Basic smoke-test: the schema should exist and parse successfully
    const result = configSchema.safeParse({
      port: "3000",
      db_path: "/some/path.db",
      log_level: "warn",
    });
    expect(result.success).toBe(true);
  });
});

describe("MAX_PWA_CONNECTIONS", () => {
  it("accepts a valid numeric string", () => {
    const config = loadConfig({ MAX_PWA_CONNECTIONS: "512" });
    expect(config.maxPwaConnections).toBe(512);
  });

  it("uses default 256 when unset", () => {
    const config = loadConfig({});
    expect(config.maxPwaConnections).toBe(256);
  });

  it("malformed value 'abc' → throws (Zod validation fails)", () => {
    // MED 2: the pre-guard was removed; Zod's coerce.number() now handles this.
    // ZodError is an Error subclass, so toBeInstanceOf(Error) still holds.
    expect(() => loadConfig({ MAX_PWA_CONNECTIONS: "abc" })).toThrow(Error);
  });

  it("value '0' → throws (not positive)", () => {
    expect(() => loadConfig({ MAX_PWA_CONNECTIONS: "0" })).toThrow();
  });

  it("negative value '-1' → throws (not positive)", () => {
    expect(() => loadConfig({ MAX_PWA_CONNECTIONS: "-1" })).toThrow();
  });
});

describe("MAX_SESSION_CONNECTIONS", () => {
  it("accepts a valid numeric string", () => {
    const config = loadConfig({ MAX_SESSION_CONNECTIONS: "128" });
    expect(config.maxSessionConnections).toBe(128);
  });

  it("uses default 64 when unset", () => {
    const config = loadConfig({});
    expect(config.maxSessionConnections).toBe(64);
  });

  it("malformed value 'abc' → throws (Zod validation fails)", () => {
    // MED 2: the pre-guard was removed; Zod's coerce.number() now handles this.
    // ZodError is an Error subclass, so toBeInstanceOf(Error) still holds.
    expect(() => loadConfig({ MAX_SESSION_CONNECTIONS: "abc" })).toThrow(Error);
  });

  it("value '0' → throws (not positive)", () => {
    expect(() => loadConfig({ MAX_SESSION_CONNECTIONS: "0" })).toThrow();
  });

  it("negative value '-1' → throws (not positive)", () => {
    expect(() => loadConfig({ MAX_SESSION_CONNECTIONS: "-1" })).toThrow();
  });
});

describe("WS_OUTBOUND_BUFFER_CAP_BYTES", () => {
  it("accepts a valid numeric string", () => {
    const config = loadConfig({ WS_OUTBOUND_BUFFER_CAP_BYTES: "2097152" });
    expect(config.wsOutboundBufferCapBytes).toBe(2_097_152);
  });

  it("malformed value 'abc' → throws Error mentioning WS_OUTBOUND_BUFFER_CAP_BYTES", () => {
    let caught: unknown;
    try {
      loadConfig({ WS_OUTBOUND_BUFFER_CAP_BYTES: "abc" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("WS_OUTBOUND_BUFFER_CAP_BYTES");
  });

  it("value '0' → throws (not positive)", () => {
    expect(() => loadConfig({ WS_OUTBOUND_BUFFER_CAP_BYTES: "0" })).toThrow();
  });

  it("negative value '-1' → throws (not positive)", () => {
    expect(() => loadConfig({ WS_OUTBOUND_BUFFER_CAP_BYTES: "-1" })).toThrow();
  });
});
