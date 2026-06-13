import { drizzle as drizzle$1 } from 'drizzle-orm/pg-proxy';
import { DeltexHttpConfig } from './serverless.mjs';

/**
 * @deltex/client/drizzle — Drizzle ORM driver for Deltex (edge-native, HTTP).
 *
 * Backed by `drizzle-orm/pg-proxy`, so every query becomes a single HTTPS
 * round-trip to Deltex's query API — no TCP, no pool. Works from Cloudflare
 * Workers, Vercel Edge, Deno, Bun and Node.
 *
 * @example
 * ```ts
 * import { drizzle } from "@deltex/client/drizzle";
 * import { pgTable, serial, text } from "drizzle-orm/pg-core";
 *
 * const users = pgTable("users", { id: serial("id").primaryKey(), name: text("name") });
 * const db = drizzle(process.env.DATABASE_URL);        // or drizzle({ apiKey })
 * const rows = await db.select().from(users).where(eq(users.id, 1));
 * ```
 *
 * Requires `drizzle-orm` (peer dependency).
 */

/**
 * Create a Drizzle database instance backed by Deltex over HTTP.
 *
 * @param connectionStringOrConfig A Postgres-style connection string (the
 *   password is used as the Deltex API key) or a `{ apiKey, endpoint }` object.
 * @param drizzleConfig Passed through to drizzle-orm (e.g. `{ schema, logger }`).
 */
declare function drizzle(connectionStringOrConfig?: string | DeltexHttpConfig, drizzleConfig?: Parameters<typeof drizzle$1>[1]): ReturnType<typeof drizzle$1>;

export { drizzle as default, drizzle };
