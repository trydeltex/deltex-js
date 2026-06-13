/**
 * @deltex/client — Official TypeScript/JavaScript client for Deltex
 *
 * Deltex is an edge-native SQL database built on Fastly Compute.
 *
 * ## Quick start
 * ```ts
 * import { createClient } from "@deltex/client";
 *
 * // Auto-reads DELTEX_API_KEY from env
 * const db = createClient();
 *
 * // Tagged template literal — primary API (injection-safe)
 * const users = await db<User[]>`SELECT * FROM users WHERE active = ${true}`;
 *
 * // Single row
 * const user = await db.one<User>`SELECT * FROM users WHERE id = ${42}`;
 *
 * // Mutations
 * await db`INSERT INTO events (type, ts) VALUES (${"click"}, NOW())`;
 *
 * // Transactions
 * const result = await db.transaction(async (tx) => {
 *   const [acc] = await tx<Account[]>`SELECT balance FROM accounts WHERE id = ${id} FOR UPDATE`;
 *   await tx`UPDATE accounts SET balance = balance - ${100} WHERE id = ${id}`;
 *   return acc;
 * });
 * ```
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A row returned by the engine — column name → value. */
export type Row = Record<string, unknown>;

/** SDK version. */
export const VERSION = "1.4.0";

/** SQL parameter value — any JSON-serializable scalar. */
export type Param = string | number | boolean | null | object;

/** Write mode for mutating queries. */
export type WriteMode = "sync" | "async" | "edge";

/**
 * How a write was committed. Read from the `x-commit-status` response header.
 * - `"committed"` — synchronously written to KV (sync mode)
 * - `"edge-accepted"` — CAS-protected async write queued (edge mode); data visible at this PoP immediately
 * - `"async-queued"` — fire-and-forget write queued (async mode)
 */
export type CommitStatus = "committed" | "edge-accepted" | "async-queued";

/** Full result envelope (for advanced use). */
export interface QueryResult<T extends Row = Row> {
  /** All result rows. */
  rows: T[];
  /** Column names in result order. */
  columns: string[];
  /** Number of rows affected (for INSERT/UPDATE/DELETE). */
  rowsAffected: number;
  /** Server-side execution time in milliseconds (from server-timing header). */
  executionMs: number | null;
  /**
   * How the write was committed (mutating queries only).
   * `undefined` for SELECT queries.
   *
   * - `"committed"` — durable write to KV ack'd synchronously
   * - `"edge-accepted"` — edge mode: write accepted at PoP, propagating to KV async (~300ms)
   * - `"async-queued"` — fire-and-forget: write queued, no ack
   */
  commitStatus: CommitStatus | undefined;
  /**
   * Schema version at the time of query execution (from x-schema-version header).
   * Useful for cache invalidation: if this changes, client-side caches should be cleared.
   */
  schemaVersion: number | undefined;
}

/** Options for `createClient()`. */
export interface ClientOptions {
  /**
   * API key (Bearer token). Defaults to `process.env.DELTEX_API_KEY`.
   * In Cloudflare Workers, pass it explicitly via env: `createClient({ apiKey: env.DELTEX_API_KEY })`.
   */
  apiKey?: string;
  /**
   * Engine endpoint. Defaults to `process.env.DELTEX_ENDPOINT ?? "https://db.deltex.dev"`.
   */
  endpoint?: string;
  /**
   * Default write mode.
   * - `"edge"` (default) — CAS-protected async (~10ms). Best for ASIA/AUS PoPs.
   * - `"sync"` — Synchronous KV ack (~350ms). Strongest durability.
   * - `"async"` — Fire-and-forget (~5ms). Best for high-volume telemetry.
   * @default "edge"
   */
  writeMode?: WriteMode;
  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeoutMs?: number;
  /**
   * Maximum number of automatic retries on HTTP 429 (rate limit exceeded).
   * Each retry waits `Retry-After` seconds (if header present) or uses exponential backoff.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Default query tag sent as `X-Query-Tag`. Appears in server-side analytics.
   * Useful for identifying which feature/route is making a query.
   */
  tag?: string;
  /**
   * Custom `fetch` implementation. Pass this in environments without native fetch
   * (Node < 18, some edge runtimes).
   */
  fetch?: typeof globalThis.fetch;
}

// ─── Error ────────────────────────────────────────────────────────────────────

/** Thrown when the engine returns an error or the network request fails. */
export class DeltexError extends Error {
  /** HTTP status code (0 for network errors). */
  readonly status: number;
  /** The SQL that caused the error (when available). */
  readonly sql: string | null;
  /** Raw engine error message. */
  readonly engineMessage: string;

  constructor(message: string, status = 0, sql: string | null = null, engineMessage = message) {
    super(message);
    this.name = "DeltexError";
    this.status = status;
    this.sql = sql;
    this.engineMessage = engineMessage;
  }
}

/**
 * Thrown when the rate limit (200 req/min) is exceeded and all retries are exhausted.
 * The `retryAfter` field indicates how many seconds to wait before the next request.
 */
export class DeltexRateLimitError extends DeltexError {
  /** Seconds to wait before retrying (from Retry-After header, or estimated). */
  readonly retryAfter: number;
  constructor(retryAfter: number, sql: string | null = null) {
    super(`Rate limit exceeded. Retry after ${retryAfter}s.`, 429, sql, "Rate limit exceeded");
    this.name = "DeltexRateLimitError";
    this.retryAfter = retryAfter;
  }
}

// ─── The callable client type ─────────────────────────────────────────────────

/**
 * A Deltex client. Can be called directly as a tagged template literal,
 * or used via its methods.
 *
 * @example
 * ```ts
 * const db = createClient();
 *
 * // Tagged template (primary API)
 * const rows = await db<User[]>`SELECT * FROM users WHERE id = ${id}`;
 *
 * // Single row
 * const user = await db.one<User>`SELECT * FROM users WHERE id = ${id}`;
 *
 * // Mutation (returns rowsAffected)
 * const n = await db.exec`UPDATE users SET active = ${true} WHERE id = ${id}`;
 *
 * // Full result envelope
 * const result = await db.raw`SELECT * FROM users`;
 * console.log(result.executionMs);
 *
 * // Transaction
 * await db.transaction(async (tx) => {
 *   await tx`UPDATE ...`;
 *   await tx`INSERT INTO ...`;
 * });
 * ```
 */
export interface Client {
  /**
   * Execute a SQL query via tagged template literal.
   * Returns all rows as `T[]`. Parameters are safely interpolated.
   *
   * @example
   * ```ts
   * const users = await db<User[]>`SELECT * FROM users WHERE id = ${id}`;
   * ```
   */
  <T extends Row = Row>(template: TemplateStringsArray, ...values: Param[]): Promise<T[]>;

  /**
   * Execute a SQL query, returning the first row or `undefined`.
   *
   * @example
   * ```ts
   * const user = await db.one<User>`SELECT * FROM users WHERE email = ${"alice@example.com"}`;
   * if (!user) throw new Error("Not found");
   * ```
   */
  one: <T extends Row = Row>(template: TemplateStringsArray, ...values: Param[]) => Promise<T | undefined>;

  /**
   * Execute a mutating SQL statement (INSERT/UPDATE/DELETE/DDL).
   * Returns the number of rows affected.
   *
   * @example
   * ```ts
   * const n = await db.exec`UPDATE users SET active = ${false} WHERE last_login < NOW() - INTERVAL '90 days'`;
   * console.log(`Deactivated ${n} users`);
   * ```
   */
  exec: (template: TemplateStringsArray, ...values: Param[]) => Promise<number>;

  /**
   * Execute a SQL query and return the full result envelope.
   * Useful when you need columns, rowsAffected, and executionMs together.
   *
   * @example
   * ```ts
   * const result = await db.raw`SELECT * FROM products`;
   * console.log(result.columns, result.executionMs);
   * ```
   */
  raw: <T extends Row = Row>(template: TemplateStringsArray, ...values: Param[]) => Promise<QueryResult<T>>;

  /**
   * Execute multiple statements in a transaction.
   * Runs BEGIN → user function → COMMIT on success, ROLLBACK on error.
   *
   * @example
   * ```ts
   * const order = await db.transaction(async (tx) => {
   *   await tx`INSERT INTO orders (user_id, total) VALUES (${userId}, ${total})`;
   *   await tx`UPDATE users SET order_count = order_count + 1 WHERE id = ${userId}`;
   *   const [order] = await tx<Order[]>`SELECT * FROM orders ORDER BY id DESC LIMIT 1`;
   *   return order;
   * });
   * ```
   */
  transaction: <T>(fn: (tx: Client) => Promise<T>) => Promise<T>;

  /**
   * Return a copy of this client with a different write mode.
   *
   * @example
   * ```ts
   * const syncDb = db.withWriteMode("sync"); // Wait for KV ack
   * await syncDb.exec`INSERT INTO critical_log ...`;
   * ```
   */
  withWriteMode: (mode: WriteMode) => Client;

  /**
   * Execute a SQL string with positional parameters ($1, $2, …).
   * Prefer tagged template literals; use this for dynamic SQL generation.
   *
   * @example
   * ```ts
   * const cols = ["id", "name"];
   * const users = await db.query(`SELECT ${cols.join(", ")} FROM users WHERE id = $1`, [42]);
   * ```
   */
  query: <T extends Row = Row>(sql: string, params?: Param[]) => Promise<T[]>;

  /**
   * Execute SQL with positional params, return first row or `undefined`.
   */
  queryOne: <T extends Row = Row>(sql: string, params?: Param[]) => Promise<T | undefined>;

  /**
   * Execute a mutating SQL string with positional params. Returns rows affected.
   */
  execute: (sql: string, params?: Param[]) => Promise<number>;

  /**
   * Execute SQL string with positional params, return full QueryResult envelope.
   */
  executeRaw: <T extends Row = Row>(sql: string, params?: Param[]) => Promise<QueryResult<T>>;

  // ─── Deltex-specific ────────────────────────────────────────────────────────

  /**
   * Return a client that forces strong consistency for all reads.
   * Bypasses Simple Cache and Core Cache — reads directly from KV.
   * Slower (~10–15ms extra) but guarantees reading your own writes across PoPs.
   *
   * @example
   * ```ts
   * // After a sync write, ensure the next read sees it everywhere:
   * const syncDb = db.withWriteMode("sync");
   * await syncDb.exec`INSERT INTO users (id, name) VALUES (${id}, ${"Alice"})`;
   * const user = await db.strong.one<User>`SELECT * FROM users WHERE id = ${id}`;
   * ```
   */
  strong: Client;

  /**
   * Return a client that attaches `X-Idempotency-Key` to every request.
   * The engine deduplicates requests with the same key within a time window,
   * preventing double-writes in retry scenarios.
   *
   * @example
   * ```ts
   * // Safe to retry: second call with same key is a no-op
   * const safeDb = db.withIdempotencyKey(requestId);
   * await safeDb.exec`INSERT INTO payments (id, amount) VALUES (${id}, ${amount})`;
   * ```
   */
  withIdempotencyKey: (key: string) => Client;

  /**
   * Return a client that tags every query with `X-Query-Tag`.
   * Tags appear in server-side query analytics and logs.
   *
   * @example
   * ```ts
   * const db = createClient({ tag: "api-server" });
   * const pageDb = db.withTag("homepage");
   * const products = await pageDb`SELECT * FROM products LIMIT 10`;
   * ```
   */
  withTag: (tag: string) => Client;
}

// ─── Parameter interpolation ──────────────────────────────────────────────────

// Module-level regex constants — compiled once, not per-call.
const POSITIONAL_RE = /\$(\d+)/g;
const SINGLE_QUOTE_RE = /'/g;
const TIMING_RE = /total;dur=([\d.]+)/;

function interpolate(template: TemplateStringsArray, values: Param[]): string {
  const n = values.length;
  // Fast path: no interpolation needed
  if (n === 0) return template[0] ?? "";
  // Pre-allocate result array: [s0, v0, s1, v1, ..., vN-1, sN]
  const parts = new Array<string>(2 * n + 1);
  parts[0] = template[0]!;
  for (let i = 0; i < n; i++) {
    parts[2 * i + 1] = formatParam(values[i]!);
    parts[2 * i + 2] = template[i + 1]!;
  }
  return parts.join("");
}

function formatParam(v: Param): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new DeltexError(`Non-finite number in SQL parameter: ${v}`);
    return String(v);
  }
  if (typeof v === "string") return "'" + v.replace(SINGLE_QUOTE_RE, "''") + "'";
  // Objects/Arrays: JSON-encode and quote-escape in one pass
  return "'" + JSON.stringify(v).replace(SINGLE_QUOTE_RE, "''") + "'";
}

function bindPositional(sql: string, params: Param[]): string {
  if (!params.length) return sql;
  // Reset lastIndex before reuse (regex is stateful when using /g with exec())
  POSITIONAL_RE.lastIndex = 0;
  return sql.replace(POSITIONAL_RE, (_match, idx: string) => {
    const i = parseInt(idx, 10) - 1;
    if (i < 0 || i >= params.length) {
      throw new DeltexError(`Missing SQL parameter $${idx} (${params.length} provided)`);
    }
    return formatParam(params[i]!);
  });
}

// ─── HTTP execution ───────────────────────────────────────────────────────────

interface ResolvedOptions {
  apiKey: string;
  endpoint: string;
  writeMode: WriteMode;
  timeoutMs: number;
  maxRetries: number;
  fetchFn: typeof globalThis.fetch;
  /** Pre-computed full URL — avoids template-literal per request. */
  url: string;
  /** Pre-computed transaction URL. */
  txUrl: string;
  /** Pre-computed static + write-mode headers — avoids object literal per request. */
  headers: Record<string, string>;
}

const COMMIT_STATUS_RE = /^(committed|edge-accepted|async-queued)$/;

async function runQuery<T extends Row>(
  sql: string,
  opts: ResolvedOptions
): Promise<QueryResult<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller!.abort(), opts.timeoutMs);
    }

    let resp: Response;
    try {
      resp = await opts.fetchFn(opts.url, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify({ sql }),
        signal: controller?.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new DeltexError(`Request timed out after ${opts.timeoutMs}ms`, 0, sql);
      }
      throw new DeltexError(`Network error: ${String(err)}`, 0, sql);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // Rate limit — auto-retry with backoff, then throw DeltexRateLimitError.
    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get("retry-after") ?? "") || 1;
      if (attempt < opts.maxRetries) {
        lastErr = new DeltexRateLimitError(retryAfter, sql);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw new DeltexRateLimitError(retryAfter, sql);
    }

    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      throw new DeltexError(`Invalid JSON response (HTTP ${resp.status})`, resp.status, sql);
    }

    if (typeof body !== "object" || body === null) {
      throw new DeltexError(`Unexpected response format`, resp.status, sql);
    }

    const b = body as Record<string, unknown>;

    if (b["success"] === false || (resp.status >= 400 && !b["columns"])) {
      const msg = String(b["message"] ?? b["error"] ?? "Unknown engine error");
      throw new DeltexError(msg, resp.status, sql, msg);
    }

    let executionMs: number | null = null;
    const st = resp.headers.get("server-timing");
    if (st) {
      const m = TIMING_RE.exec(st);
      if (m) executionMs = parseFloat(m[1]!);
    }

    // Deltex-specific: commit status (edge/async/sync write confirmation).
    const rawStatus = resp.headers.get("x-commit-status")?.trim() ?? "";
    const commitStatus: CommitStatus | undefined =
      COMMIT_STATUS_RE.test(rawStatus) ? (rawStatus as CommitStatus) : undefined;

    // Deltex-specific: schema version for cache invalidation.
    const rawSchema = resp.headers.get("x-schema-version")?.trim() ?? "";
    const schemaVersion: number | undefined =
      /^\d+$/.test(rawSchema) ? parseInt(rawSchema, 10) : undefined;

    const columns = Array.isArray(b["columns"]) ? (b["columns"] as string[]) : [];
    const rawRows = Array.isArray(b["rows"]) ? b["rows"] : [];
    // Engine returns "affected_rows" for mutations; SDK also checks "rows_affected" and "affected" for compatibility.
    const rowsAffected =
      typeof b["affected_rows"] === "number" ? b["affected_rows"] :
      typeof b["rows_affected"] === "number" ? b["rows_affected"] :
      typeof b["affected"] === "number" ? b["affected"] :
      rawRows.length;

    return { rows: rawRows as T[], columns, rowsAffected, executionMs, commitStatus, schemaVersion };
  }
  throw lastErr ?? new DeltexError("Retry loop exhausted", 429, sql);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Client factory ───────────────────────────────────────────────────────────

function resolveOptions(options: ClientOptions): ResolvedOptions {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) {
    throw new DeltexError(
      "No fetch API available. Pass `fetch` via options (or use Node 18+, Deno, Bun, or Cloudflare Workers)."
    );
  }

  const apiKey =
    options.apiKey ??
    (typeof process !== "undefined" ? process.env?.DELTEX_API_KEY : undefined) ??
    "";

  if (!apiKey) {
    throw new DeltexError(
      "No API key. Set DELTEX_API_KEY env var or pass apiKey to createClient()."
    );
  }

  const endpoint = (
    options.endpoint ??
    (typeof process !== "undefined" ? process.env?.DELTEX_ENDPOINT : undefined) ??
    "https://db.deltex.dev"
  ).replace(/\/$/, "");

  const writeMode = options.writeMode ?? "edge";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-Write-Mode": writeMode,
  };
  if (options.tag) headers["X-Query-Tag"] = options.tag;

  return {
    apiKey,
    endpoint,
    writeMode,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 3,
    fetchFn,
    url: `${endpoint}/v1/query`,
    txUrl: `${endpoint}/v1/transaction`,
    headers,
  };
}

function makeClient(opts: ResolvedOptions): Client {
  // The client IS a tagged template function.
  const client = async function<T extends Row = Row>(
    template: TemplateStringsArray,
    ...values: Param[]
  ): Promise<T[]> {
    return (await runQuery<T>(interpolate(template, values), opts)).rows;
  } as unknown as Client;

  client.one = async <T extends Row = Row>(template: TemplateStringsArray, ...values: Param[]) =>
    (await runQuery<T>(interpolate(template, values), opts)).rows[0] as T | undefined;

  client.exec = async (template: TemplateStringsArray, ...values: Param[]) =>
    (await runQuery(interpolate(template, values), opts)).rowsAffected;

  client.raw = <T extends Row = Row>(template: TemplateStringsArray, ...values: Param[]) =>
    runQuery<T>(interpolate(template, values), opts);

  client.transaction = async <T>(fn: (tx: Client) => Promise<T>): Promise<T> => {
    // Deltex uses a dedicated /transaction endpoint that atomically executes
    // an array of SQL statements. The tx client collects statements during fn(),
    // then sends them all in one request.
    //
    // Limitation: reads inside the transaction (fn reads results mid-tx) execute
    // immediately against the live DB. Only mutations are batched atomically.
    // For purely write transactions, this gives full ACID guarantees.
    const statements: string[] = [];

    // Create a collecting proxy client — mutations go to the batch, reads execute live.
    const txCollector = makeClient(opts);

    // Override exec/execute/raw to collect into statements array instead of executing
    const origExec = txCollector.exec;
    txCollector.exec = async (template: TemplateStringsArray, ...values: Param[]) => {
      const sql = interpolate(template, values);
      statements.push(sql);
      return 0; // rows affected unknown until commit
    };
    const origExecute = txCollector.execute;
    txCollector.execute = async (sql: string, params: Param[] = []) => {
      statements.push(bindPositional(sql, params));
      return 0;
    };

    // Run the user's function — reads execute live, writes are collected
    const userResult = await fn(txCollector as Client);

    if (statements.length === 0) {
      // No mutations — nothing to commit
      return userResult;
    }

    // Send collected statements to /transaction endpoint atomically
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller!.abort(), opts.timeoutMs);
    }
    try {
      const resp = await opts.fetchFn(opts.txUrl, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify({ statements, isolation: "SERIALIZABLE" }),
        signal: controller?.signal,
      });
      const body = await resp.json() as Record<string, unknown>;
      if (body["success"] === false || resp.status >= 400) {
        const msg = String(body["message"] ?? body["error"] ?? "Transaction failed");
        throw new DeltexError(msg, resp.status, statements.join("; "), msg);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    return userResult;
  };

  client.withWriteMode = (mode: WriteMode): Client => {
    if (mode === opts.writeMode) return client;
    return makeClient({
      ...opts,
      writeMode: mode,
      headers: { ...opts.headers, "X-Write-Mode": mode },
    });
  };

  // Deltex-specific: strong consistency — bypasses SC/Core Cache, reads directly from KV.
  Object.defineProperty(client, "strong", {
    get: () => makeClient({
      ...opts,
      headers: { ...opts.headers, "X-Consistency": "strong" },
    }),
    enumerable: false,
  });

  // Deltex-specific: idempotency key — deduplication for safe retries.
  client.withIdempotencyKey = (key: string): Client =>
    makeClient({ ...opts, headers: { ...opts.headers, "X-Idempotency-Key": key } });

  // Deltex-specific: query tag — per-client analytics label.
  client.withTag = (tag: string): Client =>
    makeClient({ ...opts, headers: { ...opts.headers, "X-Query-Tag": tag } });

  client.query = async <T extends Row = Row>(sql: string, params: Param[] = []) =>
    (await runQuery<T>(bindPositional(sql, params), opts)).rows;

  client.queryOne = async <T extends Row = Row>(sql: string, params: Param[] = []) =>
    (await runQuery<T>(bindPositional(sql, params), opts)).rows[0] as T | undefined;

  client.execute = async (sql: string, params: Param[] = []) =>
    (await runQuery(bindPositional(sql, params), opts)).rowsAffected;

  client.executeRaw = async <T extends Row = Row>(sql: string, params: Param[] = []) =>
    runQuery<T>(bindPositional(sql, params), opts);

  return client;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a Deltex client.
 *
 * Reads `DELTEX_API_KEY` and `DELTEX_ENDPOINT` from environment variables
 * automatically — just call `createClient()` with no arguments in Node/Deno/Bun.
 *
 * @example
 * ```ts
 * // Node/Deno/Bun — auto-reads DELTEX_API_KEY from env
 * const db = createClient();
 *
 * // Cloudflare Workers / edge runtimes (no process.env)
 * const db = createClient({ apiKey: env.DELTEX_API_KEY });
 *
 * // Custom endpoint + write mode
 * const db = createClient({
 *   apiKey: env.DELTEX_API_KEY,
 *   endpoint: "https://custom.example.com",
 *   writeMode: "sync",
 * });
 * ```
 */
export function createClient(options: ClientOptions = {}): Client {
  return makeClient(resolveOptions(options));
}

// Named re-exports
export { type Client as DeltexClient };
export default createClient;
