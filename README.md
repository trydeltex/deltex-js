# @deltex/client

Official TypeScript/JavaScript client for [Deltex](https://deltex.dev) — edge-native SQL database.

## Install

```bash
npm install @deltex/client
# or
pnpm add @deltex/client
```

## Quick start

```ts
import { createClient } from "@deltex/client";

// Auto-reads DELTEX_API_KEY from environment
const db = createClient();

type User = { id: number; name: string; email: string };

// Tagged template literals — primary API (injection-safe)
const users = await db<User[]>`SELECT id, name FROM users WHERE active = ${true}`;

// Single row
const user = await db.one<User>`SELECT * FROM users WHERE email = ${"alice@example.com"}`;
if (!user) throw new Error("Not found");

// Mutations
const n = await db.exec`
  UPDATE users SET last_login = NOW()
  WHERE id = ${user.id}
`;
console.log(`${n} row updated`);
```

## Postgres-compatible drivers (edge-native)

Deltex runs on Fastly Compute (HTTP-only at the edge), so there's no raw TCP
Postgres port. Instead, `@deltex/client/serverless` exposes the familiar shapes of
[`@neondatabase/serverless`](https://github.com/neondatabase/serverless) (`neon()`)
and [`pg`](https://node-postgres.com/) (`Client` / `Pool`) — each query is a single
HTTPS round-trip, so it works from any edge or serverless runtime (Cloudflare
Workers, Vercel Edge, Deno, Bun, Node ≥18) with **no connection pool and no gateway**.

### `neon()` — Neon-compatible

```ts
import { neon } from "@deltex/client/serverless";

const sql = neon(process.env.DATABASE_URL);          // or neon({ apiKey })
const users = await sql`SELECT * FROM users WHERE id = ${id}`;
const r = await sql.query("SELECT * FROM users WHERE id = $1", [id]); // { rows, rowCount, fields, command }
```

The connection string's password is used as the Deltex API key:
`postgresql://user:dtx_k_xxx@db.deltex.dev/db`.

### `pg`-compatible `Client` / `Pool`

```ts
import { Client, Pool } from "@deltex/client/serverless";

const client = new Client({ apiKey: process.env.DELTEX_API_KEY });
await client.connect();                 // no-op (connectionless)
const { rows } = await client.query("SELECT * FROM users WHERE id = $1", [id]);

// Atomic transaction (statements are committed together via /v1/transaction)
await client.transaction(async (tx) => {
  await tx.query("INSERT INTO orders (user_id, total) VALUES ($1, $2)", [id, 99]);
  await tx.query("UPDATE users SET order_count = order_count + 1 WHERE id = $1", [id]);
});
```

### Drizzle ORM

```ts
import { drizzle } from "@deltex/client/drizzle";  // requires `drizzle-orm`
import { pgTable, integer, text } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";

const users = pgTable("users", { id: integer("id").primaryKey(), name: text("name") });
const db = drizzle(process.env.DATABASE_URL);       // or drizzle({ apiKey })

const rows = await db.select().from(users).where(eq(users.id, 1));
```

Backed by `drizzle-orm/pg-proxy` — fully edge-native, no TCP.

## API

### `createClient(options?)`

```ts
// Node/Deno/Bun — reads DELTEX_API_KEY and DELTEX_ENDPOINT from env
const db = createClient();

// Cloudflare Workers, edge runtimes (no process.env)
const db = createClient({ apiKey: env.DELTEX_API_KEY });

// Custom endpoint + write mode
const db = createClient({
  apiKey: env.DELTEX_API_KEY,
  endpoint: "https://db.deltex.dev",
  writeMode: "edge", // "edge" (default) | "sync" | "async"
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `DELTEX_API_KEY` env | API key from Deltex dashboard |
| `endpoint` | `string` | `DELTEX_ENDPOINT` env or `https://db.deltex.dev` | Engine URL |
| `writeMode` | `"edge" \| "sync" \| "async"` | `"edge"` | Write durability mode |
| `timeoutMs` | `number` | `30000` | Request timeout |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch (Node < 18) |

### Tagged template literal — `db\`sql\``

Primary API. SQL is split at interpolation boundaries — values are never concatenated as raw strings.

```ts
const id = 42;
const users = await db<User[]>`SELECT * FROM users WHERE id = ${id}`;
//                                                                ^^^
//                              Safely formatted as: ... WHERE id = 42
```

### `db.one\`sql\`` — Single row

Returns the first row or `undefined`.

```ts
const user = await db.one<User>`SELECT * FROM users WHERE id = ${id}`;
// user: User | undefined
```

### `db.exec\`sql\`` — Mutations

Returns rows affected count.

```ts
const n = await db.exec`DELETE FROM sessions WHERE expires_at < NOW()`;
// n: number
```

### `db.raw\`sql\`` — Full result envelope

```ts
const result = await db.raw`SELECT * FROM users`;
// result.rows: Row[]
// result.columns: string[]
// result.rowsAffected: number
// result.executionMs: number | null
```

### `db.transaction(fn)` — Transactions

Runs `BEGIN` → your function → `COMMIT` on success, `ROLLBACK` on error.

```ts
const order = await db.transaction(async (tx) => {
  const [account] = await tx<Account[]>`
    SELECT balance FROM accounts WHERE id = ${userId} FOR UPDATE
  `;

  if (account.balance < amount) throw new Error("Insufficient funds");

  await tx`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${userId}`;
  await tx`INSERT INTO transactions (user_id, amount) VALUES (${userId}, ${amount})`;

  const [created] = await tx<Transaction[]>`
    SELECT * FROM transactions ORDER BY id DESC LIMIT 1
  `;
  return created;
});
```

### `db.withWriteMode(mode)` — Per-operation write mode

```ts
const syncDb = db.withWriteMode("sync");  // Wait for durable KV write (~350ms)
const fastDb = db.withWriteMode("async"); // Fire and forget (~5ms)

await syncDb.exec`INSERT INTO audit_log (event) VALUES (${"payment"})`;
```

### `db.query(sql, params?)` — Positional parameters

For dynamic SQL generation where tagged templates aren't convenient:

```ts
const cols = ["id", "name", "email"].join(", ");
const users = await db.query<User>(`SELECT ${cols} FROM users WHERE id = $1`, [42]);
```

## Write Modes

| Mode | Latency | Durability | Use When |
|------|---------|------------|----------|
| `edge` (default) | ~10ms | CAS-protected async | Normal writes, ASIA/AUS PoPs |
| `sync` | ~350ms | Synchronous KV ack | Financial, audit logs, critical data |
| `async` | ~5ms | Fire-and-forget | High-volume events, telemetry |

## Error Handling

```ts
import { DeltexError } from "@deltex/client";

try {
  await db`SELECT * FROM nonexistent_table`;
} catch (err) {
  if (err instanceof DeltexError) {
    console.error(err.message);        // "Table does not exist"
    console.error(err.engineMessage);  // Raw engine error
    console.error(err.status);         // HTTP status (400)
    console.error(err.sql);            // The SQL that failed
  }
}
```

## Examples

### Next.js App Router

```ts
// lib/db.ts
import { createClient } from "@deltex/client";
export const db = createClient(); // reads DELTEX_API_KEY from env

// app/users/[id]/page.tsx
import { db } from "@/lib/db";
export default async function UserPage({ params }: { params: { id: string } }) {
  const user = await db.one`SELECT * FROM users WHERE id = ${Number(params.id)}`;
  if (!user) notFound();
  return <div>{user.name}</div>;
}
```

### Cloudflare Workers

```ts
import { createClient } from "@deltex/client";

export default {
  async fetch(req: Request, env: Env) {
    const db = createClient({ apiKey: env.DELTEX_API_KEY });
    const products = await db`SELECT id, name, price FROM products LIMIT 20`;
    return Response.json(products);
  },
};
```

### Batch insert

```ts
const items = [{ name: "Apple", price: 0.99 }, { name: "Banana", price: 0.59 }];

await db.transaction(async (tx) => {
  for (const item of items) {
    await tx`INSERT INTO products (name, price) VALUES (${item.name}, ${item.price})`;
  }
});
```

## License

MIT
