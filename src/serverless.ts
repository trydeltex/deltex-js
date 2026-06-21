/**
 * @deltex/client/serverless — edge-native Postgres-compatible drivers.
 *
 * Deltex runs on Fastly Compute (HTTP-only at the edge), so there is no raw TCP
 * Postgres endpoint. These drivers speak Deltex's HTTP query API but expose the
 * familiar shapes of `@neondatabase/serverless` (`neon()`) and `pg`
 * (`Client` / `Pool`), so existing tooling and ORMs work from any edge or
 * serverless runtime (Cloudflare Workers, Vercel Edge, Deno, Bun, Node ≥18).
 *
 * Each query is a single HTTPS round-trip — fully edge-native, no connection
 * pool, no central gateway. Parameters use Postgres `$1,$2` placeholders and are
 * substituted safely server-side.
 */

export type SqlParam = string | number | boolean | null | bigint | Date | object;

export interface DeltexHttpConfig {
  /** API key (Bearer). Defaults to `process.env.DELTEX_API_KEY`. */
  apiKey?: string;
  /** Engine endpoint. Defaults to `process.env.DELTEX_ENDPOINT ?? "https://db.deltex.dev"`. */
  endpoint?: string;
  /** Write mode for mutating statements: "sync" (default, durable) | "edge" | "async". */
  writeMode?: "edge" | "sync" | "async";
  /** Request timeout (ms). @default 30000 */
  timeoutMs?: number;
  /** Custom fetch (for runtimes without a global fetch). */
  fetch?: typeof globalThis.fetch;
  /** Strong (read-your-writes) reads via `X-Consistency: strong`. */
  strongReads?: boolean;
}

/** Raised when the engine returns an error or the request fails. */
export class DeltexError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "DeltexError";
    this.code = opts.code ?? "DELTEX_ERROR";
    this.status = opts.status ?? 0;
  }
}

interface EngineResponse {
  success?: boolean;
  message?: string;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  affected_rows?: number;
  rows_affected?: number;
}

const DEFAULT_ENDPOINT = "https://db.deltex.dev";
const WRITE_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\(?\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|MERGE|CALL|REPLACE|UPSERT|REINDEX|VACUUM|COMMENT)\b/i;
const COMMAND_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\(?\s*([A-Za-z]+)/;

function envGet(name: string): string | undefined {
  // Guarded — `process` may be undefined in some edge runtimes.
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Parse a Postgres-style connection string into Deltex HTTP config.
 * The password component is treated as the Deltex API key, and the host as the
 * engine endpoint. Examples:
 *   postgresql://user:dtx_k_xxx@db.deltex.dev/mydb
 *   deltex://dtx_k_xxx@db.deltex.dev
 *   https://db.deltex.dev (apiKey supplied separately)
 */
export function parseConnectionString(input: string): { apiKey?: string; endpoint: string } {
  if (/^https?:\/\//i.test(input)) {
    return { endpoint: input.replace(/\/+$/, "") };
  }
  let u: URL;
  try {
    // Normalize postgres/deltex schemes to a parseable URL.
    u = new URL(input.replace(/^(postgres(ql)?|deltex):\/\//i, "https://"));
  } catch {
    throw new DeltexError(`Invalid connection string: ${input}`, { code: "BAD_CONNECTION_STRING" });
  }
  const apiKey = decodeURIComponent(u.password || u.username || "") || undefined;
  const port = u.port && u.port !== "5432" ? `:${u.port}` : "";
  return { apiKey, endpoint: `https://${u.hostname}${port}` };
}

function resolveConfig(
  connectionStringOrConfig?: string | DeltexHttpConfig,
  extra?: DeltexHttpConfig,
): Required<Pick<DeltexHttpConfig, "endpoint" | "timeoutMs" | "writeMode">> & DeltexHttpConfig {
  let base: DeltexHttpConfig = {};
  if (typeof connectionStringOrConfig === "string") {
    base = parseConnectionString(connectionStringOrConfig);
  } else if (connectionStringOrConfig) {
    base = { ...connectionStringOrConfig };
  }
  const cfg: DeltexHttpConfig = { ...base, ...extra };
  const apiKey = cfg.apiKey ?? envGet("DELTEX_API_KEY");
  const endpoint = (cfg.endpoint ?? envGet("DELTEX_ENDPOINT") ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  if (!apiKey) {
    throw new DeltexError(
      "No API key. Pass one via the connection string, { apiKey }, or DELTEX_API_KEY.",
      { code: "NO_API_KEY" },
    );
  }
  return {
    ...cfg,
    apiKey,
    endpoint,
    writeMode: cfg.writeMode ?? "sync",
    timeoutMs: cfg.timeoutMs ?? 30000,
  };
}

/** A node-postgres-shaped query result. */
export interface PgQueryResult<R = Record<string, unknown>> {
  command: string;
  rowCount: number;
  rows: R[];
  fields: Array<{ name: string; dataTypeID: number }>;
}

/** Low-level: execute one SQL statement over HTTP and return the engine envelope. */
async function execEngine(
  cfg: ReturnType<typeof resolveConfig>,
  sql: string,
  params: SqlParam[],
): Promise<EngineResponse> {
  const doFetch = cfg.fetch ?? globalThis.fetch;
  if (!doFetch) {
    throw new DeltexError("No fetch available; pass { fetch } in this runtime.", { code: "NO_FETCH" });
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    "X-Write-Mode": cfg.writeMode,
  };
  if (cfg.strongReads) headers["X-Consistency"] = "strong";

  const body = JSON.stringify({ sql, params: serializeParams(params) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await doFetch(`${cfg.endpoint}/v1/query`, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new DeltexError(`Network error: ${(e as Error).message}`, { code: "NETWORK", status: 0 });
  } finally {
    clearTimeout(timer);
  }
  let json: EngineResponse;
  try {
    json = (await resp.json()) as EngineResponse;
  } catch {
    throw new DeltexError(`Non-JSON response (HTTP ${resp.status})`, { code: "BAD_RESPONSE", status: resp.status });
  }
  if (!resp.ok || json.success === false) {
    throw new DeltexError(json.message || `Query failed (HTTP ${resp.status})`, {
      code: resp.status === 429 ? "RATE_LIMITED" : "QUERY_ERROR",
      status: resp.status,
    });
  }
  return json;
}

/** Convert JS params to JSON-safe values the engine understands. */
function serializeParams(params: SqlParam[]): unknown[] {
  return params.map((p) => {
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "bigint") return p.toString();
    if (p !== null && typeof p === "object") return JSON.stringify(p);
    return p;
  });
}

function commandTag(sql: string): string {
  const m = COMMAND_RE.exec(sql);
  return m ? m[1].toUpperCase() : "SELECT";
}

function toPgResult(sql: string, res: EngineResponse): PgQueryResult {
  const rows = res.rows ?? [];
  const columns = res.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const affected = res.affected_rows ?? res.rows_affected ?? rows.length;
  return {
    command: commandTag(sql),
    rowCount: WRITE_RE.test(sql) ? affected : rows.length,
    rows,
    fields: columns.map((name) => ({ name, dataTypeID: 0 })),
  };
}

/** Build `$1,$2,...` SQL + params array from a tagged-template call. */
function fromTemplate(strings: TemplateStringsArray, values: SqlParam[]): { sql: string; params: SqlParam[] } {
  let sql = strings[0];
  for (let i = 0; i < values.length; i++) sql += `$${i + 1}${strings[i + 1]}`;
  return { sql, params: values };
}

// ─── neon()-compatible API ────────────────────────────────────────────────────

export interface NeonQueryFunction {
  /** Tagged-template query → rows. */
  <R = Record<string, unknown>>(strings: TemplateStringsArray, ...values: SqlParam[]): Promise<R[]>;
  /** Plain string query with positional params → rows. */
  <R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<R[]>;
  /** Full result envelope (rows, rowCount, fields, command). */
  query<R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<PgQueryResult<R>>;
  /** Run multiple statements atomically via /v1/transaction. */
  transaction<R = Record<string, unknown>>(
    statements: Array<string | { sql: string; params?: SqlParam[] }>,
    opts?: { isolation?: string },
  ): Promise<PgQueryResult<R>[]>;
}

/**
 * Create a Neon-style serverless query function.
 *
 * @example
 * ```ts
 * import { neon } from "@deltex/client/serverless";
 * const sql = neon(process.env.DATABASE_URL);          // or neon({ apiKey })
 * const users = await sql`SELECT * FROM users WHERE id = ${id}`;
 * const r = await sql.query("SELECT * FROM users WHERE id = $1", [id]);
 * ```
 */
export function neon(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig): NeonQueryFunction {
  const cfg = resolveConfig(connectionStringOrConfig, extra);

  const fn = (async (
    first: TemplateStringsArray | string,
    ...rest: unknown[]
  ): Promise<unknown[]> => {
    let sql: string;
    let params: SqlParam[];
    if (typeof first === "string") {
      sql = first;
      params = (rest[0] as SqlParam[]) ?? [];
    } else {
      ({ sql, params } = fromTemplate(first, rest as SqlParam[]));
    }
    const res = await execEngine(cfg, sql, params);
    return res.rows ?? [];
  }) as NeonQueryFunction;

  fn.query = async (sql, params = []) => toPgResult(sql, await execEngine(cfg, sql, params)) as never;

  fn.transaction = async (statements, opts) => {
    const stmts = statements.map((s) =>
      typeof s === "string" ? { sql: s } : { sql: s.sql, params: s.params ?? [] },
    );
    const results = await execTransaction(cfg, stmts, opts?.isolation);
    return results as never;
  };

  return fn;
}

// ─── pg-compatible Client / Pool ───────────────────────────────────────────────

type QueryConfig = { text: string; values?: SqlParam[] } | string;

/**
 * A `pg` (node-postgres)-compatible client backed by Deltex's HTTP API.
 * `connect()` / `end()` / `release()` are no-ops (HTTP is connectionless) so
 * code and ORMs written for `pg` work unchanged.
 */
export class Client {
  private cfg: ReturnType<typeof resolveConfig>;
  constructor(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig) {
    this.cfg = resolveConfig(connectionStringOrConfig, extra);
  }
  async connect(): Promise<void> {
    /* no-op: Deltex is connectionless over HTTP */
  }
  async end(): Promise<void> {
    /* no-op */
  }
  release(): void {
    /* no-op (Pool compatibility) */
  }
  async query<R = Record<string, unknown>>(
    queryTextOrConfig: QueryConfig,
    values?: SqlParam[],
  ): Promise<PgQueryResult<R>> {
    const text = typeof queryTextOrConfig === "string" ? queryTextOrConfig : queryTextOrConfig.text;
    const params =
      values ?? (typeof queryTextOrConfig === "object" ? queryTextOrConfig.values ?? [] : []);
    return toPgResult(text, await execEngine(this.cfg, text, params)) as PgQueryResult<R>;
  }
  /** Run a function inside a Deltex transaction (statements buffered + committed atomically). */
  async transaction<T>(fn: (tx: TxRunner) => Promise<T>): Promise<T> {
    const buffer: Array<{ sql: string; params?: SqlParam[] }> = [];
    const tx: TxRunner = {
      query: async (text, vals) => {
        buffer.push({ sql: text, params: vals ?? [] });
        return { command: commandTag(text), rowCount: 0, rows: [], fields: [] };
      },
    };
    const out = await fn(tx);
    if (buffer.length) await execTransaction(this.cfg, buffer, undefined);
    return out;
  }
}

interface TxRunner {
  query<R = Record<string, unknown>>(text: string, values?: SqlParam[]): Promise<PgQueryResult<R>>;
}

/**
 * A `pg.Pool`-compatible class. Since Deltex is connectionless, this composes a
 * single {@link Client}; `connect()` returns a pooled-client-like handle and
 * `query()` works directly on the pool, matching node-postgres usage.
 */
export class Pool {
  private client: Client;
  constructor(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig) {
    this.client = new Client(connectionStringOrConfig, extra);
  }
  async connect(): Promise<Client> {
    return this.client;
  }
  query<R = Record<string, unknown>>(
    queryTextOrConfig: QueryConfig,
    values?: SqlParam[],
  ): Promise<PgQueryResult<R>> {
    return this.client.query<R>(queryTextOrConfig, values);
  }
  transaction<T>(fn: (tx: TxRunner) => Promise<T>): Promise<T> {
    return this.client.transaction(fn);
  }
  async end(): Promise<void> {
    /* no-op */
  }
}

// ─── transaction helper (/v1/transaction) ──────────────────────────────────────

async function execTransaction(
  cfg: ReturnType<typeof resolveConfig>,
  statements: Array<{ sql: string; params?: SqlParam[] }>,
  isolation?: string,
): Promise<PgQueryResult[]> {
  const doFetch = cfg.fetch ?? globalThis.fetch;
  if (!doFetch) throw new DeltexError("No fetch available.", { code: "NO_FETCH" });

  // The engine substitutes params server-side per statement; inline them here so a
  // single /v1/transaction call stays atomic.
  const inlined = statements.map((s) => inlineParams(s.sql, s.params ?? []));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await doFetch(`${cfg.endpoint}/v1/transaction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        "X-Write-Mode": cfg.writeMode === "async" ? "sync" : cfg.writeMode,
      },
      body: JSON.stringify(isolation ? { statements: inlined, isolation } : { statements: inlined }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new DeltexError(`Network error: ${(e as Error).message}`, { code: "NETWORK" });
  } finally {
    clearTimeout(timer);
  }
  const json = (await resp.json()) as EngineResponse;
  if (!resp.ok || json.success === false) {
    throw new DeltexError(json.message || "Transaction failed", {
      code: "TXN_ERROR",
      status: resp.status,
    });
  }
  return [toPgResult("COMMIT", json)];
}

/** Inline positional params into a SQL string as safe literals (for /v1/transaction). */
function inlineParams(sql: string, params: SqlParam[]): string {
  if (!params.length) return sql;
  const vals = serializeParams(params);
  return sql.replace(/\$(\d+)/g, (m, d) => {
    const idx = Number(d) - 1;
    return idx >= 0 && idx < vals.length ? toLiteral(vals[idx]) : m;
  });
}

function toLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ─── pg-proxy callback (for drizzle-orm/pg-proxy and similar HTTP adapters) ─────

/** A `drizzle-orm/pg-proxy`-shaped result: rows as positional value arrays. */
export interface PgProxyResult {
  rows: unknown[][];
}

/**
 * Build a `(sql, params, method) => { rows }` callback compatible with
 * `drizzle-orm/pg-proxy`. Rows are returned positionally (arrays), as the proxy
 * driver expects. Exposed so other HTTP ORM adapters can reuse it.
 */
export function pgProxyQuery(
  connectionStringOrConfig?: string | DeltexHttpConfig,
  extra?: DeltexHttpConfig,
): (sql: string, params: SqlParam[], method: "all" | "execute") => Promise<PgProxyResult> {
  const cfg = resolveConfig(connectionStringOrConfig, extra);
  return async (sql, params) => {
    const res = await execEngine(cfg, sql, params ?? []);
    const objs = res.rows ?? [];
    const columns = res.columns ?? (objs[0] ? Object.keys(objs[0]) : []);
    const rows = objs.map((r) => columns.map((c) => r[c]));
    return { rows };
  };
}

export { execEngine as _execEngine, serializeParams as _serializeParams, toPgResult as _toPgResult };
