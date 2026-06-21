// src/index.ts
var VERSION = "1.4.2";
var DeltexError = class extends Error {
  constructor(message, status = 0, sql = null, engineMessage = message) {
    super(message);
    this.name = "DeltexError";
    this.status = status;
    this.sql = sql;
    this.engineMessage = engineMessage;
  }
};
var DeltexRateLimitError = class extends DeltexError {
  constructor(retryAfter, sql = null) {
    super(`Rate limit exceeded. Retry after ${retryAfter}s.`, 429, sql, "Rate limit exceeded");
    this.name = "DeltexRateLimitError";
    this.retryAfter = retryAfter;
  }
};
var POSITIONAL_RE = /\$(\d+)/g;
var SINGLE_QUOTE_RE = /'/g;
var TIMING_RE = /total;dur=([\d.]+)/;
function interpolate(template, values) {
  const n = values.length;
  if (n === 0) return template[0] ?? "";
  const parts = new Array(2 * n + 1);
  parts[0] = template[0];
  for (let i = 0; i < n; i++) {
    parts[2 * i + 1] = formatParam(values[i]);
    parts[2 * i + 2] = template[i + 1];
  }
  return parts.join("");
}
function formatParam(v) {
  if (v === null || v === void 0) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new DeltexError(`Non-finite number in SQL parameter: ${v}`);
    return String(v);
  }
  if (typeof v === "string") return "'" + v.replace(SINGLE_QUOTE_RE, "''") + "'";
  return "'" + JSON.stringify(v).replace(SINGLE_QUOTE_RE, "''") + "'";
}
function bindPositional(sql, params) {
  if (!params.length) return sql;
  POSITIONAL_RE.lastIndex = 0;
  return sql.replace(POSITIONAL_RE, (_match, idx) => {
    const i = parseInt(idx, 10) - 1;
    if (i < 0 || i >= params.length) {
      throw new DeltexError(`Missing SQL parameter $${idx} (${params.length} provided)`);
    }
    return formatParam(params[i]);
  });
}
var COMMIT_STATUS_RE = /^(committed|edge-accepted|async-queued)$/;
async function runQuery(sql, opts) {
  let lastErr;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    let controller;
    let timer;
    if (opts.timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    }
    let resp;
    try {
      resp = await opts.fetchFn(opts.url, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify({ sql }),
        signal: controller?.signal
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new DeltexError(`Request timed out after ${opts.timeoutMs}ms`, 0, sql);
      }
      throw new DeltexError(`Network error: ${String(err)}`, 0, sql);
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get("retry-after") ?? "") || 1;
      if (attempt < opts.maxRetries) {
        lastErr = new DeltexRateLimitError(retryAfter, sql);
        await sleep(retryAfter * 1e3);
        continue;
      }
      throw new DeltexRateLimitError(retryAfter, sql);
    }
    let body;
    try {
      body = await resp.json();
    } catch {
      throw new DeltexError(`Invalid JSON response (HTTP ${resp.status})`, resp.status, sql);
    }
    if (typeof body !== "object" || body === null) {
      throw new DeltexError(`Unexpected response format`, resp.status, sql);
    }
    const b = body;
    if (b["success"] === false || resp.status >= 400 && !b["columns"]) {
      const msg = String(b["message"] ?? b["error"] ?? "Unknown engine error");
      throw new DeltexError(msg, resp.status, sql, msg);
    }
    let executionMs = null;
    const st = resp.headers.get("server-timing");
    if (st) {
      const m = TIMING_RE.exec(st);
      if (m) executionMs = parseFloat(m[1]);
    }
    const rawStatus = resp.headers.get("x-commit-status")?.trim() ?? "";
    const commitStatus = COMMIT_STATUS_RE.test(rawStatus) ? rawStatus : void 0;
    const rawSchema = resp.headers.get("x-schema-version")?.trim() ?? "";
    const schemaVersion = /^\d+$/.test(rawSchema) ? parseInt(rawSchema, 10) : void 0;
    const columns = Array.isArray(b["columns"]) ? b["columns"] : [];
    const rawRows = Array.isArray(b["rows"]) ? b["rows"] : [];
    const rowsAffected = typeof b["affected_rows"] === "number" ? b["affected_rows"] : typeof b["rows_affected"] === "number" ? b["rows_affected"] : typeof b["affected"] === "number" ? b["affected"] : rawRows.length;
    return { rows: rawRows, columns, rowsAffected, executionMs, commitStatus, schemaVersion };
  }
  throw lastErr ?? new DeltexError("Retry loop exhausted", 429, sql);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveOptions(options) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) {
    throw new DeltexError(
      "No fetch API available. Pass `fetch` via options (or use Node 18+, Deno, Bun, or Cloudflare Workers)."
    );
  }
  const apiKey = options.apiKey ?? (typeof process !== "undefined" ? process.env?.DELTEX_API_KEY : void 0) ?? "";
  if (!apiKey) {
    throw new DeltexError(
      "No API key. Set DELTEX_API_KEY env var or pass apiKey to createClient()."
    );
  }
  const endpoint = (options.endpoint ?? (typeof process !== "undefined" ? process.env?.DELTEX_ENDPOINT : void 0) ?? "https://db.deltex.dev").replace(/\/$/, "");
  const writeMode = options.writeMode ?? "sync";
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-Write-Mode": writeMode
  };
  if (options.tag) headers["X-Query-Tag"] = options.tag;
  return {
    apiKey,
    endpoint,
    writeMode,
    timeoutMs: options.timeoutMs ?? 3e4,
    maxRetries: options.maxRetries ?? 3,
    fetchFn,
    url: `${endpoint}/v1/query`,
    txUrl: `${endpoint}/v1/transaction`,
    headers
  };
}
function makeClient(opts) {
  const client = async function(template, ...values) {
    return (await runQuery(interpolate(template, values), opts)).rows;
  };
  client.one = async (template, ...values) => (await runQuery(interpolate(template, values), opts)).rows[0];
  client.exec = async (template, ...values) => (await runQuery(interpolate(template, values), opts)).rowsAffected;
  client.raw = (template, ...values) => runQuery(interpolate(template, values), opts);
  client.transaction = async (fn) => {
    const statements = [];
    const txCollector = makeClient(opts);
    const origExec = txCollector.exec;
    txCollector.exec = async (template, ...values) => {
      const sql = interpolate(template, values);
      statements.push(sql);
      return 0;
    };
    const origExecute = txCollector.execute;
    txCollector.execute = async (sql, params = []) => {
      statements.push(bindPositional(sql, params));
      return 0;
    };
    const userResult = await fn(txCollector);
    if (statements.length === 0) {
      return userResult;
    }
    await sendStatements(statements, "SERIALIZABLE");
    return userResult;
  };
  const sendStatements = async (statements, isolation) => {
    let controller;
    let timer;
    if (opts.timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    }
    try {
      const resp = await opts.fetchFn(opts.txUrl, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify({ statements, isolation }),
        signal: controller?.signal
      });
      const body = await resp.json();
      if (body["success"] === false || resp.status >= 400) {
        const msg = String(body["message"] ?? body["error"] ?? "Transaction failed");
        throw new DeltexError(msg, resp.status, statements.join("; "), msg);
      }
      return typeof body["affected_rows"] === "number" ? body["affected_rows"] : 0;
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  };
  client.batch = async (statements) => {
    if (statements.length === 0) return 0;
    return sendStatements(statements, "SERIALIZABLE");
  };
  client.withWriteMode = (mode) => {
    if (mode === opts.writeMode) return client;
    return makeClient({
      ...opts,
      writeMode: mode,
      headers: { ...opts.headers, "X-Write-Mode": mode }
    });
  };
  Object.defineProperty(client, "strong", {
    get: () => makeClient({
      ...opts,
      headers: { ...opts.headers, "X-Consistency": "strong" }
    }),
    enumerable: false
  });
  client.withIdempotencyKey = (key) => makeClient({ ...opts, headers: { ...opts.headers, "X-Idempotency-Key": key } });
  client.withTag = (tag) => makeClient({ ...opts, headers: { ...opts.headers, "X-Query-Tag": tag } });
  client.query = async (sql, params = []) => (await runQuery(bindPositional(sql, params), opts)).rows;
  client.queryOne = async (sql, params = []) => (await runQuery(bindPositional(sql, params), opts)).rows[0];
  client.execute = async (sql, params = []) => (await runQuery(bindPositional(sql, params), opts)).rowsAffected;
  client.executeRaw = async (sql, params = []) => runQuery(bindPositional(sql, params), opts);
  return client;
}
function createClient(options = {}) {
  return makeClient(resolveOptions(options));
}
var index_default = createClient;
export {
  DeltexError,
  DeltexRateLimitError,
  VERSION,
  createClient,
  index_default as default
};
