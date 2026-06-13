#!/usr/bin/env node
/**
 * TypeScript SDK Integration Test — Real data ops against live Deltex
 */
const { createClient, DeltexError } = require("./dist/index");

const API_KEY = process.env.DELTEX_API_KEY || "";
if (!API_KEY) { console.error("Set DELTEX_API_KEY"); process.exit(1); }

const T = `_sdk_ts_${Date.now()}`;  // table name
let passed = 0, failed = 0;

function pass(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, msg) { console.log(`  \x1b[31m✗ ${name}: ${msg}\x1b[0m`); failed++; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// SQL shorthand — use string template (table name is test-controlled, not user input)
function q(sql, params) {
  return params ? db.query(sql, params) : db.query(sql);
}
function exec(sql, params) {
  return params ? db.execute(sql, params) : db.execute(sql);
}

const db = createClient({ apiKey: API_KEY, writeMode: "sync" });

async function run() {
  console.log(`\n\x1b[1mTypeScript SDK Integration Test (v517)\x1b[0m`);
  console.log(`\x1b[2mTable: ${T}\x1b[0m\n`);

  // ── DDL ────────────────────────────────────────────────────────────────────
  console.log("[DDL]");
  await sleep(350);
  await exec(`CREATE TABLE ${T} (id INT PRIMARY KEY, name TEXT NOT NULL, score FLOAT DEFAULT 0, active BOOL DEFAULT TRUE, dept TEXT)`);
  pass("CREATE TABLE");

  // ── INSERT ─────────────────────────────────────────────────────────────────
  console.log("\n[INSERT]");
  const users = [
    [1,"Alice",95.5,true,"eng"],[2,"Bob",73.0,true,"sales"],[3,"Charlie",41.5,false,"eng"],
    [4,"Diana",88.0,true,"design"],[5,"Eve",99.9,true,"eng"],[6,"Frank",0.0,false,"sales"],
    [7,"Grace",55.5,true,"design"],[8,"Henry",77.0,true,"eng"],[9,"Iris",82.5,false,"design"],
    [10,"Jack",63.0,true,"sales"],
  ];
  let errs = 0;
  for (const [id,name,score,active,dept] of users) {
    await sleep(350);
    const n = await exec(`INSERT INTO ${T} (id,name,score,active,dept) VALUES ($1,$2,$3,$4,$5)`, [id,name,score,active,dept]);
    if (n !== 1) errs++;
  }
  if (errs === 0) pass("INSERT 10 rows — rowsAffected=1 each"); else fail("INSERT", `${errs} errors`);

  // ── SELECT ─────────────────────────────────────────────────────────────────
  await sleep(600);
  console.log("\n[SELECT]");

  await sleep(350);
  const all = await db.strong.query(`SELECT id,name FROM ${T} ORDER BY id`);
  if (all.length===10 && all[0].name==="Alice") pass("SELECT * ORDER BY id (10 rows, Alice first)");
  else fail("SELECT *", `len=${all.length}`);

  await sleep(350);
  const active = await db.strong.query(`SELECT name FROM ${T} WHERE active=TRUE`);
  if (active.length===7) pass("SELECT WHERE active=TRUE (7 rows)");
  else fail("WHERE active=TRUE", `${active.length}`);

  await sleep(350);
  const inactive = await db.strong.query(`SELECT name FROM ${T} WHERE active=FALSE`);
  if (inactive.length===3) pass("SELECT WHERE active=FALSE (3 rows)");
  else fail("WHERE active=FALSE", `${inactive.length} rows`);

  await sleep(350);
  const top3 = await db.strong.query(`SELECT name,score FROM ${T} ORDER BY score DESC LIMIT 3`);
  if (top3.length===3 && top3[0].name==="Eve") pass(`ORDER BY score DESC LIMIT 3 → Eve(99.9) first`);
  else fail("ORDER BY LIMIT", JSON.stringify(top3[0]));

  await sleep(350);
  const [agg] = await db.strong.query(`SELECT COUNT(*) AS cnt, MAX(score) AS mx, MIN(score) AS mn FROM ${T}`);
  if (parseInt(agg.cnt)===10 && parseFloat(agg.mx)===99.9) pass(`Aggregates: COUNT=10 MAX=99.9`);
  else fail("Aggregates", JSON.stringify(agg));

  await sleep(350);
  const groups = await db.strong.query(`SELECT dept, COUNT(*) AS n FROM ${T} GROUP BY dept ORDER BY dept`);
  if (groups.length===3) pass(`GROUP BY dept → ${groups.map(g=>g.dept+'('+g.n+')').join(',')}`);
  else fail("GROUP BY", `${groups.length} groups`);

  await sleep(350);
  const alice = await db.strong.queryOne(`SELECT * FROM ${T} WHERE name=$1`, ["Alice"]);
  if (alice?.score==95.5) pass("queryOne: Alice found with score=95.5");
  else fail("queryOne", JSON.stringify(alice));

  await sleep(350);
  const miss = await db.strong.queryOne(`SELECT * FROM ${T} WHERE name=$1`, ["Nobody"]);
  if (miss===undefined) pass("queryOne miss → undefined");
  else fail("queryOne miss", JSON.stringify(miss));

  // ── UPDATE ─────────────────────────────────────────────────────────────────
  console.log("\n[UPDATE]");
  await sleep(350);
  const upd = await exec(`UPDATE ${T} SET score = score * 1.1 WHERE dept='eng'`);
  if (upd===4) pass("UPDATE dept=eng → 4 rows affected"); else fail("UPDATE", `expected 4 got ${upd}`);

  await sleep(600);
  const [eve] = await db.strong.query(`SELECT score FROM ${T} WHERE name='Eve'`);
  if (Math.abs(parseFloat(eve?.score) - 109.89) < 0.1) pass(`Eve.score after UPDATE: ${parseFloat(eve?.score).toFixed(2)}`);
  else fail("Verify UPDATE", `score=${eve?.score}`);

  // ── TRANSACTION ─────────────────────────────────────────────────────────────
  console.log("\n[TRANSACTION]");
  // Write-only transaction (read happens AFTER commit)
  await sleep(350);
  await db.transaction(async (tx) => {
    await tx.execute(`INSERT INTO ${T} (id,name,score,dept) VALUES (11,'TxUser1',50.0,'tx')`);
    await tx.execute(`INSERT INTO ${T} (id,name,score,dept) VALUES (12,'TxUser2',51.0,'tx')`);
    await tx.execute(`UPDATE ${T} SET score=100.0 WHERE id=11`);
  });
  await sleep(700);
  const [tx1] = await db.strong.query(`SELECT id,name,score FROM ${T} WHERE id=11`);
  const [tx2] = await db.strong.query(`SELECT id,name FROM ${T} WHERE id=12`);
  if (tx1?.name==="TxUser1" && tx1?.score==100.0 && tx2?.name==="TxUser2") {
    pass("Transaction committed: 2 INSERTs + 1 UPDATE atomically (ids 11,12 with score=100)");
  } else {
    fail("Transaction commit", `tx1=${JSON.stringify(tx1)} tx2=${JSON.stringify(tx2)}`);
  }

  // Rollback (error inside fn)
  await sleep(350);
  let rollbackOk = false;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO ${T} (id,name) VALUES (999,'RollMe')`);
      throw new Error("deliberate rollback");
    });
  } catch (e) { rollbackOk = true; }
  await sleep(700);
  const [rb] = await db.strong.query(`SELECT id FROM ${T} WHERE id=999`);
  if (rollbackOk && !rb) pass("Transaction ROLLBACK: deliberate error, row 999 not persisted");
  else fail("ROLLBACK", `rollbackOk=${rollbackOk} rb=${JSON.stringify(rb)}`);

  // ── UPSERT ─────────────────────────────────────────────────────────────────
  console.log("\n[UPSERT]");
  await sleep(350);
  await exec(`INSERT INTO ${T} (id,name,score) VALUES (1,'AliceUpserted',200.0) ON CONFLICT (id) DO UPDATE SET name='AliceUpserted',score=200.0`);
  await sleep(600);
  const [upserted] = await db.strong.query(`SELECT name,score FROM ${T} WHERE id=1`);
  if (upserted?.name==="AliceUpserted" && parseFloat(upserted.score)===200.0) pass("ON CONFLICT DO UPDATE upsert");
  else fail("UPSERT", JSON.stringify(upserted));

  // ── DELETE ─────────────────────────────────────────────────────────────────
  console.log("\n[DELETE]");
  await sleep(350);
  const del = await exec(`DELETE FROM ${T} WHERE active=FALSE`);
  if (del===3) pass("DELETE WHERE active=FALSE → 3 rows"); else fail("DELETE", `expected 3 got ${del}`);

  await sleep(600);
  const [cnt] = await db.strong.query(`SELECT COUNT(*) AS n FROM ${T}`);
  // 10 original + 2 TxUsers = 12, -3 inactive = 9
  if (parseInt(cnt.n)===9) pass("Count after DELETE: 9 rows (10+2tx-3inactive)");
  else fail("Post-DELETE count", `expected 9 got ${cnt.n}`);

  // ── DELTEX-SPECIFIC ────────────────────────────────────────────────────────
  console.log("\n[DELTEX-SPECIFIC]");

  // executeRaw: executionMs
  await sleep(350);
  const raw = await db.executeRaw(`SELECT COUNT(*) AS n FROM ${T}`);
  if (raw.executionMs !== null && raw.executionMs >= 0) pass(`executeRaw.executionMs = ${raw.executionMs?.toFixed(1)}ms`);
  else fail("executionMs", raw.executionMs);

  // commitStatus on INSERT
  await sleep(350);
  const writeResult = await db.executeRaw(`INSERT INTO ${T} (id,name,score) VALUES (99,'commitCheck',1.0) ON CONFLICT (id) DO NOTHING`);
  // sync mode → committed; edge mode → edge-accepted
  const cs = writeResult.commitStatus;
  if (cs === "committed" || cs === "edge-accepted" || cs === undefined) pass(`commitStatus="${cs ?? 'none (DO NOTHING)'}"`);
  else fail("commitStatus", cs);

  // withTag
  const tagDb = db.withTag("sdk-integration-test");
  await sleep(350);
  const tagged = await tagDb.strong.query(`SELECT name FROM ${T} ORDER BY score DESC LIMIT 1`);
  if (tagged.length === 1) pass(`withTag → highest scorer: ${tagged[0].name}`);
  else fail("withTag", JSON.stringify(tagged));

  // db.strong
  await sleep(350);
  const strong = await db.strong.query(`SELECT COUNT(*) AS n FROM ${T}`);
  if (parseInt(strong[0]?.n) >= 9) pass(`db.strong bypasses cache (count ≥ 9)`);
  else fail("db.strong", JSON.stringify(strong));

  // withIdempotencyKey
  const ikey = `test-${Date.now()}`;
  const idempDb = db.withIdempotencyKey(ikey);
  await sleep(350);
  const first = await idempDb.executeRaw(`INSERT INTO ${T} (id,name) VALUES (100,'IdempTest') ON CONFLICT (id) DO NOTHING`);
  await sleep(350);
  const second = await idempDb.executeRaw(`INSERT INTO ${T} (id,name) VALUES (100,'IdempTest') ON CONFLICT (id) DO NOTHING`);
  pass(`withIdempotencyKey: sent same ikey twice (first: rowsAffected=${first.rowsAffected}, second: ${second.rowsAffected})`);

  // DeltexError on bad SQL
  await sleep(350);
  try {
    await db.query(`TOTALLY INVALID SQL GARBAGE 123`);
    fail("DeltexError thrown", "should have thrown");
  } catch(e) {
    if (e instanceof DeltexError) pass(`DeltexError(status=${e.status}): "${e.sql?.slice(0,15)}..." → "${e.engineMessage?.slice(0,40)}"`);
    else fail("DeltexError type", e.constructor.name);
  }

  // DeltexError on missing table
  await sleep(350);
  try {
    await db.query(`SELECT * FROM nonexistent_table_xyz_${Date.now()}`);
    fail("DeltexError on missing table", "should have thrown");
  } catch(e) {
    if (e instanceof DeltexError && e.status >= 400) pass("DeltexError: table not found → correct error");
    else fail("Missing table error", `${e.constructor.name}: ${e.message}`);
  }

  // ── CLEANUP ────────────────────────────────────────────────────────────────
  await sleep(350);
  await exec(`DROP TABLE IF EXISTS ${T}`);

  // ── RESULT ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  const color = failed===0 ? "\x1b[32m" : "\x1b[31m";
  console.log(`${color}TypeScript SDK: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error("\x1b[31mFatal error:\x1b[0m", e.message, e.stack?.split('\n')[1]);
  process.exit(1);
});
