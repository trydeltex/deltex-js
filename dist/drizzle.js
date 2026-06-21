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

// src/drizzle.ts
var drizzle_exports = {};
__export(drizzle_exports, {
  default: () => drizzle_default,
  drizzle: () => drizzle
});
module.exports = __toCommonJS(drizzle_exports);
var import_pg_proxy = require("drizzle-orm/pg-proxy");

// src/serverless.ts
var DeltexError = class extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "DeltexError";
    this.code = opts.code ?? "DELTEX_ERROR";
    this.status = opts.status ?? 0;
  }
};
var DEFAULT_ENDPOINT = "https://db.deltex.dev";
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

// src/drizzle.ts
function drizzle(connectionStringOrConfig, drizzleConfig) {
  return (0, import_pg_proxy.drizzle)(pgProxyQuery(connectionStringOrConfig), drizzleConfig);
}
var drizzle_default = drizzle;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  drizzle
});
