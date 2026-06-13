/**
 * Live integration test for the Postgres-compatible serverless drivers.
 * Runs against a real Deltex engine — set DELTEX_API_KEY (and optionally
 * DELTEX_ENDPOINT) before running:
 *
 *   DELTEX_API_KEY=dtx_k_... node serverless.integration.mjs
 *
 * Exercises neon(), the pg-compatible Client/Pool, transactions, and the
 * Drizzle ORM adapter (both raw execute() and the query builder).
 */
import { neon, Client, Pool } from "./dist/serverless.mjs";
import { drizzle } from "./dist/drizzle.mjs";
import { sql as dsql, eq } from "drizzle-orm";
import { pgTable, integer, text, real } from "drizzle-orm/pg-core";

const apiKey = process.env.DELTEX_API_KEY;
if (!apiKey) {
  console.error("Set DELTEX_API_KEY to run the integration test.");
  process.exit(2);
}
const cfg = {
  apiKey,
  endpoint: process.env.DELTEX_ENDPOINT ?? "https://db.deltex.dev",
  writeMode: "sync",
  strongReads: true,
};

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { console.log("  PASS", label); pass++; }
  else { console.log("  FAIL", label, detail); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = "_sl_" + Math.floor(Math.random() * 100000);

const sqlfn = neon(cfg);
await sqlfn.query(`DROP TABLE IF EXISTS ${T}`);
await sqlfn.query(`CREATE TABLE ${T} (id INT PRIMARY KEY, name TEXT, score REAL)`);
await sleep(800);
await sqlfn.query(`INSERT INTO ${T} VALUES ($1,$2,$3),($4,$5,$6)`, [1, "alice", 9.5, 2, "bob", 7.0]);
await sleep(500);

console.log("[neon()]");
const r2 = await sqlfn(`SELECT id, name, score FROM ${T} ORDER BY id`);
ok("plain select returns rows", r2.length === 2 && r2[0].name === "alice", JSON.stringify(r2));
const r = await sqlfn.query(`SELECT * FROM ${T} WHERE id = $1`, [2]);
ok("query() pg-shape", r.command === "SELECT" && r.rowCount === 1 && r.rows[0].name === "bob" && r.fields.some((f) => f.name === "name"));
const inj = await sqlfn(`SELECT name FROM ${T} WHERE name = $1`, ["alice'; DROP TABLE x; --"]);
ok("param injection neutralized", inj.length === 0);

console.log("[pg Client]");
const client = new Client(cfg);
await client.connect();
const cr = await client.query(`SELECT COUNT(*) AS c FROM ${T}`);
ok("query() works", Number(cr.rows[0].c) === 2, JSON.stringify(cr.rows));
const cr2 = await client.query({ text: `SELECT * FROM ${T} WHERE id = $1`, values: [1] });
ok("query config object", cr2.rows[0].name === "alice");
await client.end();

console.log("[pg Pool]");
const pool = new Pool(cfg);
const pc = await pool.connect();
const pr = await pc.query(`SELECT MAX(score) AS m FROM ${T}`);
ok("pool.connect().query()", Number(pr.rows[0].m) === 9.5, JSON.stringify(pr.rows));

console.log("[transaction]");
await client.transaction(async (tx) => {
  await tx.query(`INSERT INTO ${T} VALUES ($1,$2,$3)`, [3, "carol", 8.0]);
  await tx.query(`UPDATE ${T} SET score = $1 WHERE id = $2`, [10.0, 1]);
});
await sleep(700);
const after = await sqlfn(`SELECT id,name,score FROM ${T} ORDER BY id`);
ok("transaction committed atomically", after.length === 3 && Number(after[0].score) === 10.0 && after[2].name === "carol", JSON.stringify(after));

console.log("[drizzle]");
const db = drizzle(cfg);
const dres = await db.execute(dsql`SELECT id, name FROM ${dsql.raw(T)} WHERE id = ${2}`);
ok("execute() positional rows", Array.isArray(dres) && dres.length === 1 && dres[0][1] === "bob", JSON.stringify(dres));
const tbl = pgTable(T, { id: integer("id").primaryKey(), name: text("name"), score: real("score") });
const sel = await db.select().from(tbl).where(eq(tbl.id, 1));
ok("query builder select/where", sel.length === 1 && sel[0].name === "alice" && Number(sel[0].score) === 10.0, JSON.stringify(sel));
const proj = await db.select({ name: tbl.name }).from(tbl).orderBy(tbl.id);
ok("query builder projection", proj.length === 3 && proj[0].name === "alice" && proj[2].name === "carol", JSON.stringify(proj));

// Aggregates the way ORMs emit them (count(*), grouped count, qualified GROUP BY/ORDER BY)
const { count } = await import("drizzle-orm");
const total = await db.select({ value: count() }).from(tbl);
ok("drizzle count()", Number(total[0].value) === 3, JSON.stringify(total));
const grouped = await db.select({ name: tbl.name, c: count() }).from(tbl).groupBy(tbl.name).orderBy(tbl.name);
ok("drizzle grouped count + groupBy/orderBy", grouped.length === 3 && grouped.every((r) => Number(r.c) === 1), JSON.stringify(grouped));

await sqlfn.query(`DROP TABLE IF EXISTS ${T}`);
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
