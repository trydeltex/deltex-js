import { describe, it, expect, beforeEach } from "@jest/globals";
import { createClient, DeltexError, DeltexRateLimitError } from "../src/index";
import type { Client } from "../src/index";

// ─── Mock fetch factory ────────────────────────────────────────────────────────

type MockFetch = (url: unknown, opts: unknown) => Promise<Response>;

function mockFetch(body: object, status = 200, extraHeaders: Record<string, string> = {}): MockFetch {
  return async (_url: unknown, _opts: unknown) =>
    ({
      status,
      json: async () => body,
      headers: new Headers({ "server-timing": "total;dur=12.5", ...extraHeaders }),
    } as Response);
}

function captureFetch(): { mockFetch: MockFetch; captured: { sql: string; headers: Record<string, string> } } {
  const captured = { sql: "", headers: {} as Record<string, string> };
  const fn: MockFetch = async (_url: unknown, opts: unknown) => {
    const reqOpts = opts as RequestInit;
    const body = JSON.parse(reqOpts.body as string);
    captured.sql = body.sql;
    captured.headers = Object.fromEntries(
      Object.entries(reqOpts.headers as Record<string, string>)
    );
    return {
      status: 200,
      json: async () => ({ columns: ["r"], rows: [{ r: 1 }], rows_affected: 1 }),
      headers: new Headers(),
    } as Response;
  };
  return { mockFetch: fn, captured };
}

// ─── Client creation ───────────────────────────────────────────────────────────

describe("createClient", () => {
  it("requires an API key", () => {
    // Set up a scenario with no env var and no option
    const origEnv = process.env.DELTEX_API_KEY;
    delete process.env.DELTEX_API_KEY;
    expect(() => createClient({ fetch: mockFetch({}) as typeof fetch })).toThrow(DeltexError);
    if (origEnv) process.env.DELTEX_API_KEY = origEnv;
  });

  it("reads DELTEX_API_KEY from env", () => {
    process.env.DELTEX_API_KEY = "dtx_test_key";
    const db = createClient({ fetch: mockFetch({}) as typeof fetch });
    expect(db).toBeDefined();
    delete process.env.DELTEX_API_KEY;
  });

  it("accepts explicit apiKey option", () => {
    const db = createClient({ apiKey: "dtx_k_test", fetch: mockFetch({}) as typeof fetch });
    expect(db).toBeDefined();
  });

  it("withWriteMode returns a new client", () => {
    const db = createClient({ apiKey: "k", fetch: mockFetch({}) as typeof fetch });
    const edge = db.withWriteMode("edge");
    expect(edge).toBeDefined();
    expect(edge).not.toBe(db);
  });
});

// ─── Tagged template literals ─────────────────────────────────────────────────

describe("tagged template literal", () => {
  let db: Client;
  let captured: ReturnType<typeof captureFetch>["captured"];

  beforeEach(() => {
    const cap = captureFetch();
    captured = cap.captured;
    db = createClient({ apiKey: "k", fetch: cap.mockFetch as typeof fetch });
  });

  it("basic query: db`SELECT 1`", async () => {
    const rows = await db`SELECT 1 AS n`;
    expect(rows).toEqual([{ r: 1 }]);
    expect(captured.sql).toBe("SELECT 1 AS n");
  });

  it("interpolates string param safely", async () => {
    const name = "Alice";
    await db`SELECT * FROM users WHERE name = ${name}`;
    expect(captured.sql).toContain("'Alice'");
  });

  it("interpolates number without quotes", async () => {
    await db`SELECT * FROM t WHERE id = ${42}`;
    expect(captured.sql).toContain("= 42");
    expect(captured.sql).not.toContain("'42'");
  });

  it("interpolates boolean as TRUE/FALSE", async () => {
    await db`SELECT * FROM t WHERE active = ${true}`;
    expect(captured.sql).toContain("TRUE");
  });

  it("interpolates NULL for null", async () => {
    await db`UPDATE t SET x = ${null}`;
    expect(captured.sql).toContain("NULL");
  });

  it("escapes single quotes in strings", async () => {
    await db`SELECT ${`it's`} AS v`;
    expect(captured.sql).toContain("'it''s'");
  });

  it("encodes objects as JSON", async () => {
    await db`SELECT ${{ key: "val" }}::jsonb`;
    expect(captured.sql).toContain('{"key":"val"}');
  });

  it("handles multiple params", async () => {
    const [a, b, c] = ["foo", 2, true];
    await db`INSERT INTO t (a,b,c) VALUES (${a},${b},${c})`;
    expect(captured.sql).toBe("INSERT INTO t (a,b,c) VALUES ('foo',2,TRUE)");
  });

  it("sends correct Authorization header", async () => {
    const db2 = createClient({ apiKey: "dtx_k_secret", fetch: captureFetch().mockFetch as typeof fetch });
    const cap = captureFetch();
    const db3 = createClient({ apiKey: "dtx_k_secret", fetch: cap.mockFetch as typeof fetch });
    await db3`SELECT 1`;
    expect(cap.captured.headers["Authorization"]).toBe("Bearer dtx_k_secret");
  });
});

// ─── .one() ───────────────────────────────────────────────────────────────────

describe("client.one", () => {
  it("returns first row", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ columns: ["id"], rows: [{ id: 1 }, { id: 2 }], rows_affected: 2 }) as typeof fetch,
    });
    const row = await db.one`SELECT id FROM users LIMIT 1`;
    expect(row).toEqual({ id: 1 });
  });

  it("returns undefined when no rows", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ columns: ["id"], rows: [], rows_affected: 0 }) as typeof fetch,
    });
    const row = await db.one`SELECT * FROM t WHERE false`;
    expect(row).toBeUndefined();
  });
});

// ─── .exec() ──────────────────────────────────────────────────────────────────

describe("client.exec", () => {
  it("returns rowsAffected", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ columns: [], rows: [], rows_affected: 5 }) as typeof fetch,
    });
    const n = await db.exec`UPDATE users SET x = ${1}`;
    expect(n).toBe(5);
  });
});

// ─── .raw() ───────────────────────────────────────────────────────────────────

describe("client.raw", () => {
  it("returns full result envelope with executionMs", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ columns: ["id", "name"], rows: [{ id: 1, name: "Alice" }], rows_affected: 1 }) as typeof fetch,
    });
    const result = await db.raw`SELECT id, name FROM users`;
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toHaveLength(1);
    expect(result.executionMs).toBe(12.5);
    expect(result.rowsAffected).toBe(1);
  });
});

// ─── .query() positional params ───────────────────────────────────────────────

describe("client.query positional params", () => {
  it("supports $1 $2 style", async () => {
    const cap = captureFetch();
    const db = createClient({ apiKey: "k", fetch: cap.mockFetch as typeof fetch });
    await db.query("SELECT * FROM t WHERE id = $1 AND active = $2", [42, true]);
    expect(cap.captured.sql).toBe("SELECT * FROM t WHERE id = 42 AND active = TRUE");
  });

  it("throws on missing parameter", async () => {
    const db = createClient({ apiKey: "k", fetch: captureFetch().mockFetch as typeof fetch });
    await expect(db.query("SELECT $2", ["only_one"])).rejects.toThrow(DeltexError);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws DeltexError on engine failure", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ success: false, message: "Table does not exist" }, 400) as typeof fetch,
    });
    await expect(db`SELECT * FROM nonexistent`).rejects.toThrow(DeltexError);
    await expect(db`SELECT * FROM nonexistent`).rejects.toThrow("Table does not exist");
  });

  it("DeltexError.status reflects HTTP status", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ success: false, message: "Unauthorized" }, 401) as typeof fetch,
    });
    let err!: DeltexError;
    try { await db`SELECT 1`; } catch (e) { err = e as DeltexError; }
    expect(err).toBeInstanceOf(DeltexError);
    expect(err.status).toBe(401);
  });

  it("DeltexError.sql contains the query", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ success: false, message: "error" }, 400) as typeof fetch,
    });
    let err!: DeltexError;
    try { await db.query("SELECT * FROM boom"); } catch (e) { err = e as DeltexError; }
    expect(err).toBeInstanceOf(DeltexError);
    expect(err.sql).toBe("SELECT * FROM boom");
  });

  it("throws on non-finite number", async () => {
    const db = createClient({ apiKey: "k", fetch: mockFetch({}) as typeof fetch });
    await expect(db`SELECT ${Infinity}`).rejects.toThrow(DeltexError);
    await expect(db`SELECT ${NaN}`).rejects.toThrow(DeltexError);
  });
});

// ─── withWriteMode ────────────────────────────────────────────────────────────

describe("withWriteMode", () => {
  it("sends correct X-Write-Mode header", async () => {
    const cap = captureFetch();
    const db = createClient({ apiKey: "k", fetch: cap.mockFetch as typeof fetch });
    const edgeDb = db.withWriteMode("edge");
    await edgeDb`INSERT INTO t VALUES (1)`;
    expect(cap.captured.headers["X-Write-Mode"]).toBe("edge");
  });

  it("default write mode is sync (durable)", async () => {
    const cap = captureFetch();
    const db = createClient({ apiKey: "k", fetch: cap.mockFetch as typeof fetch });
    await db`SELECT 1`;
    expect(cap.captured.headers["X-Write-Mode"]).toBe("sync");
  });
});

describe("batch", () => {
  it("sends all statements in ONE request to the transaction endpoint", async () => {
    let calls = 0;
    let capturedUrl = "";
    let capturedStatements: string[] = [];
    const fetchFn: MockFetch = async (url: unknown, opts: unknown) => {
      calls++;
      capturedUrl = String(url);
      const body = JSON.parse((opts as RequestInit).body as string);
      capturedStatements = body.statements;
      return { status: 200, json: async () => ({ success: true, affected_rows: 3 }), headers: new Headers() } as Response;
    };
    const db = createClient({ apiKey: "k", fetch: fetchFn as typeof fetch });
    const affected = await db.batch([
      "INSERT INTO t VALUES (1)",
      "INSERT INTO t VALUES (2)",
      "INSERT INTO t VALUES (3)",
    ]);
    expect(calls).toBe(1); // one round-trip, not three
    expect(capturedUrl).toContain("/v1/transaction");
    expect(capturedStatements).toHaveLength(3);
    expect(affected).toBe(3);
  });

  it("empty batch is a no-op (no request)", async () => {
    let calls = 0;
    const fetchFn: MockFetch = async () => { calls++; return { status: 200, json: async () => ({}), headers: new Headers() } as Response; };
    const db = createClient({ apiKey: "k", fetch: fetchFn as typeof fetch });
    const affected = await db.batch([]);
    expect(calls).toBe(0);
    expect(affected).toBe(0);
  });

  it("throws on batch failure", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: (async () => ({ status: 400, json: async () => ({ success: false, message: "boom" }), headers: new Headers() })) as unknown as typeof fetch,
    });
    await expect(db.batch(["INSERT INTO t VALUES (1)"])).rejects.toThrow("boom");
  });
});

// ─── Deltex-specific features ─────────────────────────────────────────────────

describe("commitStatus and schemaVersion", () => {
  it("reads commitStatus from x-commit-status header", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ columns: [], rows: [], rows_affected: 1 }, 200, {
        "x-commit-status": "edge-accepted",
      }) as typeof fetch,
    });
    const result = await db.raw`INSERT INTO t VALUES (1)`;
    expect(result.commitStatus).toBe("edge-accepted");
  });

  it("reads schemaVersion from x-schema-version header", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ columns: ["id"], rows: [{ id: 1 }], rows_affected: 1 }, 200, {
        "x-schema-version": "42",
      }) as typeof fetch,
    });
    const result = await db.raw`SELECT id FROM t`;
    expect(result.schemaVersion).toBe(42);
  });

  it("commitStatus is undefined for SELECT", async () => {
    const db = createClient({
      apiKey: "k",
      fetch: mockFetch({ columns: ["id"], rows: [], rows_affected: 0 }) as typeof fetch,
    });
    const result = await db.raw`SELECT * FROM t`;
    expect(result.commitStatus).toBeUndefined();
  });
});

describe("rate limit retry", () => {
  it("retries on 429 and succeeds", async () => {
    let calls = 0;
    const retryingFetch: typeof fetch = async (_url, _opts) => {
      calls++;
      if (calls === 1) {
        return {
          status: 429,
          json: async () => ({ success: false, message: "Rate limit" }),
          headers: new Headers({ "retry-after": "0.01" }),
        } as Response;
      }
      return {
        status: 200,
        json: async () => ({ columns: ["n"], rows: [{ n: 1 }], rows_affected: 1 }),
        headers: new Headers(),
      } as Response;
    };
    const db = createClient({ apiKey: "k", maxRetries: 1, fetch: retryingFetch });
    const rows = await db`SELECT 1 AS n`;
    expect(rows).toEqual([{ n: 1 }]);
    expect(calls).toBe(2);
  });

  it("throws DeltexRateLimitError when retries exhausted", async () => {
    const rateLimitedFetch: typeof fetch = async () =>
      ({
        status: 429,
        json: async () => ({}),
        headers: new Headers({ "retry-after": "0.01" }),
      } as Response);
    const db = createClient({ apiKey: "k", maxRetries: 0, fetch: rateLimitedFetch });
    await expect(db`SELECT 1`).rejects.toThrow(DeltexRateLimitError);
  });
});

describe("strong consistency", () => {
  it("db.strong sends X-Consistency: strong header", async () => {
    const cap = captureFetch();
    const db = createClient({ apiKey: "k", fetch: cap.mockFetch as typeof fetch });
    await db.strong`SELECT * FROM users`;
    expect(cap.captured.headers["X-Consistency"]).toBe("strong");
  });
});

describe("withIdempotencyKey", () => {
  it("sends X-Idempotency-Key header", async () => {
    const cap = captureFetch();
    const db = createClient({ apiKey: "k", fetch: cap.mockFetch as typeof fetch });
    await db.withIdempotencyKey("req-123")`INSERT INTO t VALUES (1)`;
    expect(cap.captured.headers["X-Idempotency-Key"]).toBe("req-123");
  });
});

describe("withTag", () => {
  it("sends X-Query-Tag header", async () => {
    const cap = captureFetch();
    const db = createClient({ apiKey: "k", fetch: cap.mockFetch as typeof fetch });
    await db.withTag("homepage-load")`SELECT * FROM products`;
    expect(cap.captured.headers["X-Query-Tag"]).toBe("homepage-load");
  });

  it("tag from createClient options is sent", async () => {
    const cap = captureFetch();
    const db = createClient({ apiKey: "k", tag: "my-service", fetch: cap.mockFetch as typeof fetch });
    await db`SELECT 1`;
    expect(cap.captured.headers["X-Query-Tag"]).toBe("my-service");
  });
});
