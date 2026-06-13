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
type SqlParam = string | number | boolean | null | bigint | Date | object;
interface DeltexHttpConfig {
    /** API key (Bearer). Defaults to `process.env.DELTEX_API_KEY`. */
    apiKey?: string;
    /** Engine endpoint. Defaults to `process.env.DELTEX_ENDPOINT ?? "https://db.deltex.dev"`. */
    endpoint?: string;
    /** Write mode for mutating statements: "edge" (default) | "sync" | "async". */
    writeMode?: "edge" | "sync" | "async";
    /** Request timeout (ms). @default 30000 */
    timeoutMs?: number;
    /** Custom fetch (for runtimes without a global fetch). */
    fetch?: typeof globalThis.fetch;
    /** Strong (read-your-writes) reads via `X-Consistency: strong`. */
    strongReads?: boolean;
}
/** Raised when the engine returns an error or the request fails. */
declare class DeltexError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(message: string, opts?: {
        code?: string;
        status?: number;
    });
}
interface EngineResponse {
    success?: boolean;
    message?: string;
    columns?: string[];
    rows?: Array<Record<string, unknown>>;
    affected_rows?: number;
    rows_affected?: number;
}
/**
 * Parse a Postgres-style connection string into Deltex HTTP config.
 * The password component is treated as the Deltex API key, and the host as the
 * engine endpoint. Examples:
 *   postgresql://user:dtx_k_xxx@db.deltex.dev/mydb
 *   deltex://dtx_k_xxx@db.deltex.dev
 *   https://db.deltex.dev (apiKey supplied separately)
 */
declare function parseConnectionString(input: string): {
    apiKey?: string;
    endpoint: string;
};
declare function resolveConfig(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig): Required<Pick<DeltexHttpConfig, "endpoint" | "timeoutMs" | "writeMode">> & DeltexHttpConfig;
/** A node-postgres-shaped query result. */
interface PgQueryResult<R = Record<string, unknown>> {
    command: string;
    rowCount: number;
    rows: R[];
    fields: Array<{
        name: string;
        dataTypeID: number;
    }>;
}
/** Low-level: execute one SQL statement over HTTP and return the engine envelope. */
declare function execEngine(cfg: ReturnType<typeof resolveConfig>, sql: string, params: SqlParam[]): Promise<EngineResponse>;
/** Convert JS params to JSON-safe values the engine understands. */
declare function serializeParams(params: SqlParam[]): unknown[];
declare function toPgResult(sql: string, res: EngineResponse): PgQueryResult;
interface NeonQueryFunction {
    /** Tagged-template query → rows. */
    <R = Record<string, unknown>>(strings: TemplateStringsArray, ...values: SqlParam[]): Promise<R[]>;
    /** Plain string query with positional params → rows. */
    <R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<R[]>;
    /** Full result envelope (rows, rowCount, fields, command). */
    query<R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<PgQueryResult<R>>;
    /** Run multiple statements atomically via /v1/transaction. */
    transaction<R = Record<string, unknown>>(statements: Array<string | {
        sql: string;
        params?: SqlParam[];
    }>, opts?: {
        isolation?: string;
    }): Promise<PgQueryResult<R>[]>;
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
declare function neon(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig): NeonQueryFunction;
type QueryConfig = {
    text: string;
    values?: SqlParam[];
} | string;
/**
 * A `pg` (node-postgres)-compatible client backed by Deltex's HTTP API.
 * `connect()` / `end()` / `release()` are no-ops (HTTP is connectionless) so
 * code and ORMs written for `pg` work unchanged.
 */
declare class Client {
    private cfg;
    constructor(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    release(): void;
    query<R = Record<string, unknown>>(queryTextOrConfig: QueryConfig, values?: SqlParam[]): Promise<PgQueryResult<R>>;
    /** Run a function inside a Deltex transaction (statements buffered + committed atomically). */
    transaction<T>(fn: (tx: TxRunner) => Promise<T>): Promise<T>;
}
interface TxRunner {
    query<R = Record<string, unknown>>(text: string, values?: SqlParam[]): Promise<PgQueryResult<R>>;
}
/**
 * A `pg.Pool`-compatible class. Since Deltex is connectionless, this composes a
 * single {@link Client}; `connect()` returns a pooled-client-like handle and
 * `query()` works directly on the pool, matching node-postgres usage.
 */
declare class Pool {
    private client;
    constructor(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig);
    connect(): Promise<Client>;
    query<R = Record<string, unknown>>(queryTextOrConfig: QueryConfig, values?: SqlParam[]): Promise<PgQueryResult<R>>;
    transaction<T>(fn: (tx: TxRunner) => Promise<T>): Promise<T>;
    end(): Promise<void>;
}
/** A `drizzle-orm/pg-proxy`-shaped result: rows as positional value arrays. */
interface PgProxyResult {
    rows: unknown[][];
}
/**
 * Build a `(sql, params, method) => { rows }` callback compatible with
 * `drizzle-orm/pg-proxy`. Rows are returned positionally (arrays), as the proxy
 * driver expects. Exposed so other HTTP ORM adapters can reuse it.
 */
declare function pgProxyQuery(connectionStringOrConfig?: string | DeltexHttpConfig, extra?: DeltexHttpConfig): (sql: string, params: SqlParam[], method: "all" | "execute") => Promise<PgProxyResult>;

export { Client, DeltexError, type DeltexHttpConfig, type NeonQueryFunction, type PgProxyResult, type PgQueryResult, Pool, type SqlParam, execEngine as _execEngine, serializeParams as _serializeParams, toPgResult as _toPgResult, neon, parseConnectionString, pgProxyQuery };
