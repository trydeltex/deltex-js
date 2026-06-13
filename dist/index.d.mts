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
/** A row returned by the engine — column name → value. */
type Row = Record<string, unknown>;
/** SDK version. */
declare const VERSION = "1.4.0";
/** SQL parameter value — any JSON-serializable scalar. */
type Param = string | number | boolean | null | object;
/** Write mode for mutating queries. */
type WriteMode = "sync" | "async" | "edge";
/**
 * How a write was committed. Read from the `x-commit-status` response header.
 * - `"committed"` — synchronously written to KV (sync mode)
 * - `"edge-accepted"` — CAS-protected async write queued (edge mode); data visible at this PoP immediately
 * - `"async-queued"` — fire-and-forget write queued (async mode)
 */
type CommitStatus = "committed" | "edge-accepted" | "async-queued";
/** Full result envelope (for advanced use). */
interface QueryResult<T extends Row = Row> {
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
interface ClientOptions {
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
/** Thrown when the engine returns an error or the network request fails. */
declare class DeltexError extends Error {
    /** HTTP status code (0 for network errors). */
    readonly status: number;
    /** The SQL that caused the error (when available). */
    readonly sql: string | null;
    /** Raw engine error message. */
    readonly engineMessage: string;
    constructor(message: string, status?: number, sql?: string | null, engineMessage?: string);
}
/**
 * Thrown when the rate limit (200 req/min) is exceeded and all retries are exhausted.
 * The `retryAfter` field indicates how many seconds to wait before the next request.
 */
declare class DeltexRateLimitError extends DeltexError {
    /** Seconds to wait before retrying (from Retry-After header, or estimated). */
    readonly retryAfter: number;
    constructor(retryAfter: number, sql?: string | null);
}
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
interface Client {
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
declare function createClient(options?: ClientOptions): Client;

export { type Client, type ClientOptions, type CommitStatus, type Client as DeltexClient, DeltexError, DeltexRateLimitError, type Param, type QueryResult, type Row, VERSION, type WriteMode, createClient, createClient as default };
