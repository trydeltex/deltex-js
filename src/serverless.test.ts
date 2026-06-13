import { describe, it, expect } from "@jest/globals";
import {
  neon,
  Client,
  Pool,
  parseConnectionString,
  pgProxyQuery,
  DeltexError,
} from "../src/serverless";

type MockFetch = (url: unknown, opts: unknown) => Promise<Response>;

/** A fetch mock that records the last request and returns a canned engine body. */
function recordingFetch(body: object, status = 200) {
  const calls: Array<{ url: string; sql: string; params: unknown[]; headers: Record<string, string>; path: string }> = [];
  const fetch: MockFetch = async (url, opts) => {
    const o = opts as RequestInit;
    const b = JSON.parse(o.body as string);
    calls.push({
      url: String(url),
      path: new URL(String(url)).pathname,
      sql: b.sql,
      params: b.params ?? b.statements,
      headers: Object.fromEntries(Object.entries((o.headers as Record<string, string>) ?? {})),
    });
    return { status, ok: status < 400, json: async () => body } as Response;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const cfg = (fetch: typeof globalThis.fetch) => ({ apiKey: "dtx_k_test", endpoint: "https://db.deltex.dev", fetch });

describe("parseConnectionString", () => {
  it("treats the password as the API key and host as endpoint", () => {
    const c = parseConnectionString("postgresql://user:dtx_k_abc@db.deltex.dev/mydb");
    expect(c.apiKey).toBe("dtx_k_abc");
    expect(c.endpoint).toBe("https://db.deltex.dev");
  });
  it("supports the deltex:// scheme with key as username", () => {
    const c = parseConnectionString("deltex://dtx_k_xyz@db.deltex.dev");
    expect(c.apiKey).toBe("dtx_k_xyz");
  });
  it("accepts a bare https endpoint", () => {
    const c = parseConnectionString("https://db.deltex.dev/");
    expect(c.endpoint).toBe("https://db.deltex.dev");
    expect(c.apiKey).toBeUndefined();
  });
});

describe("neon()", () => {
  it("builds $1,$2 placeholders from a tagged template", async () => {
    const { fetch, calls } = recordingFetch({ success: true, columns: ["id"], rows: [{ id: 7 }] });
    const sql = neon(cfg(fetch));
    const rows = await sql`SELECT * FROM users WHERE id = ${7} AND name = ${"bob"}`;
    expect(calls[0].sql).toBe("SELECT * FROM users WHERE id = $1 AND name = $2");
    expect(calls[0].params).toEqual([7, "bob"]);
    expect(calls[0].path).toBe("/v1/query");
    expect(rows).toEqual([{ id: 7 }]);
  });
  it("passes a plain string + params through unchanged", async () => {
    const { fetch, calls } = recordingFetch({ success: true, columns: ["id"], rows: [] });
    const sql = neon(cfg(fetch));
    await sql("SELECT * FROM t WHERE id = $1", [42]);
    expect(calls[0].sql).toBe("SELECT * FROM t WHERE id = $1");
    expect(calls[0].params).toEqual([42]);
  });
  it(".query() returns a pg-shaped result", async () => {
    const { fetch } = recordingFetch({ success: true, columns: ["a", "b"], rows: [{ a: 1, b: "x" }], affected_rows: 0 });
    const sql = neon(cfg(fetch));
    const r = await sql.query("SELECT 1 AS a, 'x' AS b");
    expect(r.command).toBe("SELECT");
    expect(r.rowCount).toBe(1);
    expect(r.rows).toEqual([{ a: 1, b: "x" }]);
    expect(r.fields.map((f) => f.name)).toEqual(["a", "b"]);
  });
  it("serializes Date/bigint/object params to JSON-safe values", async () => {
    const { fetch, calls } = recordingFetch({ success: true, rows: [] });
    const sql = neon(cfg(fetch));
    const d = new Date("2024-01-02T03:04:05.000Z");
    await sql`INSERT INTO t VALUES (${d}, ${10n}, ${{ a: 1 }})`;
    expect(calls[0].params).toEqual(["2024-01-02T03:04:05.000Z", "10", '{"a":1}']);
  });
});

describe("pg-compatible Client / Pool", () => {
  it("Client.query() supports both string and {text,values}", async () => {
    const { fetch, calls } = recordingFetch({ success: true, columns: ["c"], rows: [{ c: 2 }] });
    const client = new Client(cfg(fetch));
    await client.connect();
    const r1 = await client.query("SELECT $1::int", [5]);
    const r2 = await client.query({ text: "SELECT $1::int", values: [6] });
    expect(r1.rows).toEqual([{ c: 2 }]);
    expect(calls[0].params).toEqual([5]);
    expect(calls[1].params).toEqual([6]);
    await client.end();
  });
  it("Pool.connect() returns a queryable client", async () => {
    const { fetch } = recordingFetch({ success: true, columns: ["m"], rows: [{ m: 9 }] });
    const pool = new Pool(cfg(fetch));
    const c = await pool.connect();
    const r = await c.query("SELECT MAX(x) AS m FROM t");
    expect(r.rows[0].m).toBe(9);
  });
  it("rowCount reflects affected_rows for writes", async () => {
    const { fetch } = recordingFetch({ success: true, message: "Updated 3 row(s)", affected_rows: 3, rows: [] });
    const client = new Client(cfg(fetch));
    const r = await client.query("UPDATE t SET x = 1");
    expect(r.command).toBe("UPDATE");
    expect(r.rowCount).toBe(3);
  });
});

describe("transactions", () => {
  it("buffers statements and posts them to /v1/transaction with inlined params", async () => {
    const { fetch, calls } = recordingFetch({ success: true, message: "COMMIT", affected_rows: 2 });
    const client = new Client(cfg(fetch));
    await client.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES ($1)", [1]);
      await tx.query("UPDATE t SET x = $1 WHERE id = $2", ["o'brien", 2]);
    });
    expect(calls[0].path).toBe("/v1/transaction");
    expect(calls[0].params).toEqual([
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 'o''brien' WHERE id = 2",
    ]);
  });
});

describe("pgProxyQuery (drizzle adapter callback)", () => {
  it("returns rows as positional arrays ordered by columns", async () => {
    const { fetch } = recordingFetch({ success: true, columns: ["id", "name"], rows: [{ name: "a", id: 1 }, { name: "b", id: 2 }] });
    const run = pgProxyQuery(cfg(fetch));
    const out = await run("SELECT id, name FROM t", [], "all");
    expect(out.rows).toEqual([[1, "a"], [2, "b"]]);
  });
});

describe("errors", () => {
  it("throws DeltexError on engine failure", async () => {
    const { fetch } = recordingFetch({ success: false, message: "boom" }, 400);
    const sql = neon(cfg(fetch));
    await expect(sql.query("SELECT bad")).rejects.toBeInstanceOf(DeltexError);
  });
  it("requires an API key", () => {
    expect(() => neon({ endpoint: "https://db.deltex.dev" })).toThrow(DeltexError);
  });
});
