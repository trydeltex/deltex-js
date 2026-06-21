"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/serverless.ts
var serverless_exports = {};
__export(serverless_exports, {
  Client: () => Client,
  DeltexError: () => DeltexError,
  Pool: () => Pool,
  _execEngine: () => execEngine,
  _serializeParams: () => serializeParams,
  _toPgResult: () => toPgResult,
  neon: () => neon,
  parseConnectionString: () => parseConnectionString,
  pgProxyQuery: () => pgProxyQuery
});
module.exports = __toCommonJS(serverless_exports);
var DeltexError = class extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "DeltexError";
    this.code = opts.code ?? "DELTEX_ERROR";
    this.status = opts.status ?? 0;
  }
};
var DEFAULT_ENDPOINT = "https://db.deltex.dev";
var WRITE_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\(?\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|MERGE|CALL|REPLACE|UPSERT|REINDEX|VACUUM|COMMENT)\b/i;
var COMMAND_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\(?\s*([A-Za-z]+)/;
function envGet(name) {
  try {
    return globalThis.process?.env?.[name];
  } catch {
    return void 0;
  }
}
function parseConnectionString(input) {
  if (/^https?:\/\//i.test(input)) {
    return { endpoint: input.replace(/\/+$/, "") };
  }
  let u;
  try {
    u = new URL(input.replace(/^(postgres(ql)?|deltex):\/\//i, "https://"));
  } catch {
    throw new DeltexError(`Invalid connection string: ${input}`, { code: "BAD_CONNECTION_STRING" });
  }
  const apiKey = decodeURIComponent(u.password || u.username || "") || void 0;
  const port = u.port && u.port !== "5432" ? `:${u.port}` : "";
  return { apiKey, endpoint: `https://${u.hostname}${port}` };
}
function resolveConfig(connectionStringOrConfig, extra) {
  let base = {};
  if (typeof connectionStringOrConfig === "string") {
    base = parseConnectionString(connectionStringOrConfig);
  } else if (connectionStringOrConfig) {
    base = { ...connectionStringOrConfig };
  }
  const cfg = { ...base, ...extra };
  const apiKey = cfg.apiKey ?? envGet("DELTEX_API_KEY");
  const endpoint = (cfg.endpoint ?? envGet("DELTEX_ENDPOINT") ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  if (!apiKey) {
    throw new DeltexError(
      "No API key. Pass one via the connection string, { apiKey }, or DELTEX_API_KEY.",
      { code: "NO_API_KEY" }
    );
  }
  return {
    ...cfg,
    apiKey,
    endpoint,
    writeMode: cfg.writeMode ?? "sync",
    timeoutMs: cfg.timeoutMs ?? 3e4
  };
}
async function execEngine(cfg, sql, params) {
  const doFetch = cfg.fetch ?? globalThis.fetch;
  if (!doFetch) {
    throw new DeltexError("No fetch available; pass { fetch } in this runtime.", { code: "NO_FETCH" });
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    "X-Write-Mode": cfg.writeMode
  };
  if (cfg.strongReads) headers["X-Consistency"] = "strong";
  const body = JSON.stringify({ sql, params: serializeParams(params) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let resp;
  try {
    resp = await doFetch(`${cfg.endpoint}/v1/query`, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal
    });
  } catch (e) {
    throw new DeltexError(`Network error: ${e.message}`, { code: "NETWORK", status: 0 });
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = await resp.json();
  } catch {
    throw new DeltexError(`Non-JSON response (HTTP ${resp.status})`, { code: "BAD_RESPONSE", status: resp.status });
  }
  if (!resp.ok || json.success === false) {
    throw new DeltexError(json.message || `Query failed (HTTP ${resp.status})`, {
      code: resp.status === 429 ? "RATE_LIMITED" : "QUERY_ERROR",
      status: resp.status
    });
  }
  return json;
}
function serializeParams(params) {
  return params.map((p) => {
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "bigint") return p.toString();
    if (p !== null && typeof p === "object") return JSON.stringify(p);
    return p;
  });
}
function commandTag(sql) {
  const m = COMMAND_RE.exec(sql);
  return m ? m[1].toUpperCase() : "SELECT";
}
function toPgResult(sql, res) {
  const rows = res.rows ?? [];
  const columns = res.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const affected = res.affected_rows ?? res.rows_affected ?? rows.length;
  return {
    command: commandTag(sql),
    rowCount: WRITE_RE.test(sql) ? affected : rows.length,
    rows,
    fields: columns.map((name) => ({ name, dataTypeID: 0 }))
  };
}
function fromTemplate(strings, values) {
  let sql = strings[0];
  for (let i = 0; i < values.length; i++) sql += `$${i + 1}${strings[i + 1]}`;
  return { sql, params: values };
}
function neon(connectionStringOrConfig, extra) {
  const cfg = resolveConfig(connectionStringOrConfig, extra);
  const fn = (async (first, ...rest) => {
    let sql;
    let params;
    if (typeof first === "string") {
      sql = first;
      params = rest[0] ?? [];
    } else {
      ({ sql, params } = fromTemplate(first, rest));
    }
    const res = await execEngine(cfg, sql, params);
    return res.rows ?? [];
  });
  fn.query = async (sql, params = []) => toPgResult(sql, await execEngine(cfg, sql, params));
  fn.transaction = async (statements, opts) => {
    const stmts = statements.map(
      (s) => typeof s === "string" ? { sql: s } : { sql: s.sql, params: s.params ?? [] }
    );
    const results = await execTransaction(cfg, stmts, opts?.isolation);
    return results;
  };
  return fn;
}
var Client = class {
  constructor(connectionStringOrConfig, extra) {
    this.cfg = resolveConfig(connectionStringOrConfig, extra);
  }
  async connect() {
  }
  async end() {
  }
  release() {
  }
  async query(queryTextOrConfig, values) {
    const text = typeof queryTextOrConfig === "string" ? queryTextOrConfig : queryTextOrConfig.text;
    const params = values ?? (typeof queryTextOrConfig === "object" ? queryTextOrConfig.values ?? [] : []);
    return toPgResult(text, await execEngine(this.cfg, text, params));
  }
  /** Run a function inside a Deltex transaction (statements buffered + committed atomically). */
  async transaction(fn) {
    const buffer = [];
    const tx = {
      query: async (text, vals) => {
        buffer.push({ sql: text, params: vals ?? [] });
        return { command: commandTag(text), rowCount: 0, rows: [], fields: [] };
      }
    };
    const out = await fn(tx);
    if (buffer.length) await execTransaction(this.cfg, buffer, void 0);
    return out;
  }
};
var Pool = class {
  constructor(connectionStringOrConfig, extra) {
    this.client = new Client(connectionStringOrConfig, extra);
  }
  async connect() {
    return this.client;
  }
  query(queryTextOrConfig, values) {
    return this.client.query(queryTextOrConfig, values);
  }
  transaction(fn) {
    return this.client.transaction(fn);
  }
  async end() {
  }
};
async function execTransaction(cfg, statements, isolation) {
  const doFetch = cfg.fetch ?? globalThis.fetch;
  if (!doFetch) throw new DeltexError("No fetch available.", { code: "NO_FETCH" });
  const inlined = statements.map((s) => inlineParams(s.sql, s.params ?? []));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let resp;
  try {
    resp = await doFetch(`${cfg.endpoint}/v1/transaction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        "X-Write-Mode": cfg.writeMode === "async" ? "sync" : cfg.writeMode
      },
      body: JSON.stringify(isolation ? { statements: inlined, isolation } : { statements: inlined }),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new DeltexError(`Network error: ${e.message}`, { code: "NETWORK" });
  } finally {
    clearTimeout(timer);
  }
  const json = await resp.json();
  if (!resp.ok || json.success === false) {
    throw new DeltexError(json.message || "Transaction failed", {
      code: "TXN_ERROR",
      status: resp.status
    });
  }
  return [toPgResult("COMMIT", json)];
}
function inlineParams(sql, params) {
  if (!params.length) return sql;
  const vals = serializeParams(params);
  return sql.replace(/\$(\d+)/g, (m, d) => {
    const idx = Number(d) - 1;
    return idx >= 0 && idx < vals.length ? toLiteral(vals[idx]) : m;
  });
}
function toLiteral(v) {
  if (v === null || v === void 0) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
}
function pgProxyQuery(connectionStringOrConfig, extra) {
  const cfg = resolveConfig(connectionStringOrConfig, extra);
  return async (sql, params) => {
    const res = await execEngine(cfg, sql, params ?? []);
    const objs = res.rows ?? [];
    const columns = res.columns ?? (objs[0] ? Object.keys(objs[0]) : []);
    const rows = objs.map((r) => columns.map((c) => r[c]));
    return { rows };
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Client,
  DeltexError,
  Pool,
  _execEngine,
  _serializeParams,
  _toPgResult,
  neon,
  parseConnectionString,
  pgProxyQuery
});
