/**
 * drizzle.integration.mjs — real Drizzle ORM end-to-end test against a live Deltex engine.
 *
 * Proves ORM compatibility: Drizzle's generated SQL (insert/select/where/projection/
 * count/groupBy/orderBy/update/delete) runs over @deltex/client/drizzle (HTTP /v1/query).
 *
 * Runs against a real Deltex engine — set DELTEX_API_KEY (and optionally DELTEX_ENDPOINT):
 *   DELTEX_API_KEY=dtx_k_... node drizzle.integration.mjs
 */
import { drizzle } from "./dist/drizzle.mjs";
import { pgTable, integer, text, boolean } from "drizzle-orm/pg-core";
import { eq, gt, and, desc, count } from "drizzle-orm";

const API_KEY = process.env.DELTEX_API_KEY;
if (!API_KEY) { console.error("Set DELTEX_API_KEY to run the integration test."); process.exit(2); }
const ENDPOINT = process.env.DELTEX_ENDPOINT ?? "https://db.deltex.dev";

const users = pgTable("dz_users", {
  id: integer("id").primaryKey(),
  name: text("name"),
  age: integer("age"),
  active: boolean("active"),
});

const db = drizzle({ apiKey: API_KEY, endpoint: ENDPOINT });

async function raw(q) {
  const r = await fetch(`${ENDPOINT}/v1/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: q }),
  });
  return r.json();
}

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  \u2713 ${label}`); }
  else { fail++; console.log(`  \u2717 ${label}  ${JSON.stringify(detail)}`); }
}
const settle = () => new Promise((r) => setTimeout(r, 1500));

async function main() {
  await raw("DROP TABLE IF EXISTS dz_users");
  await raw("CREATE TABLE dz_users (id INT PRIMARY KEY, name TEXT, age INT, active BOOL)");
  await settle();

  await db.insert(users).values([
    { id: 1, name: "alice", age: 30, active: true },
    { id: 2, name: "bob", age: 25, active: false },
    { id: 3, name: "carol", age: 40, active: true },
  ]);
  await settle();

  const all = await db.select().from(users).orderBy(users.id);
  check("select all → 3 rows", all.length === 3, all);
  check("select all → first is alice", all[0]?.name === "alice", all[0]);

  const one = await db.select().from(users).where(eq(users.id, 1));
  check("where id=1 → alice", one[0]?.name === "alice", one);

  const filtered = await db.select({ id: users.id }).from(users)
    .where(and(gt(users.age, 26), eq(users.active, true))).orderBy(users.id);
  check("where age>26 AND active → [1,3]", JSON.stringify(filtered.map((r) => r.id)) === "[1,3]", filtered);

  const proj = await db.select({ uid: users.id, uname: users.name }).from(users).where(eq(users.id, 2));
  check("projection alias → bob", proj[0]?.uname === "bob" && proj[0]?.uid === 2, proj);

  const cnt = await db.select({ c: count() }).from(users);
  check("count() → 3", Number(cnt[0]?.c) === 3, cnt);

  const grouped = await db.select({ active: users.active, c: count() }).from(users).groupBy(users.active);
  check("grouped count → 2 groups", grouped.length === 2, grouped);

  const top = await db.select({ id: users.id }).from(users).orderBy(desc(users.age)).limit(1);
  check("order age desc limit 1 → carol(3)", top[0]?.id === 3, top);

  await db.update(users).set({ age: 99 }).where(eq(users.id, 1));
  await settle();
  const updated = await db.select({ age: users.age }).from(users).where(eq(users.id, 1));
  check("update age=99 → read back 99", Number(updated[0]?.age) === 99, updated);

  await db.delete(users).where(eq(users.id, 2));
  await settle();
  const afterDel = await db.select({ id: users.id }).from(users).orderBy(users.id);
  check("delete id=2 → [1,3]", JSON.stringify(afterDel.map((r) => r.id)) === "[1,3]", afterDel);

  await raw("DROP TABLE IF EXISTS dz_users");
  console.log(`\n=== Drizzle ORM E2E: ${pass}/${pass + fail} passed ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });
