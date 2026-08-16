/**
 * The app's one database connection, and the one place that decides which
 * database that is.
 *
 * TWO BRANCHES, ONE DISCRIMINATOR. `isDeployed()` from `lib/identity.ts` is
 * the same fact the sign-in stand-in already branches on, imported rather than
 * copied so the two can never disagree:
 *
 *   - Deployed (`WEBSITE_SITE_NAME` set by App Service): a `pg` Pool against
 *     `DATABASE_URL`, which Back21 resolves from the customer's own Key Vault.
 *     Never ask for that value and never hardcode one.
 *   - Everywhere else (the Back21 preview, local dev, tests): PGlite, real
 *     PostgreSQL compiled to WASM, running inside this very process. Same
 *     drizzle API, same schema, and it applies the same SQL migrations from
 *     `db/migrations/` that later run against the customer's database. No
 *     server, no connection string. The rows live in this process's memory
 *     and are gone when it restarts; nothing typed into a preview reaches any
 *     real database.
 *
 * The imports below are intentionally RELATIVE (`./identity.ts`, not
 * `@/lib/identity`). This file is starter plumbing, and plumbing importing the
 * identity module must not read as "the app asks who is signed in".
 *
 * WHY `getDb()` IS ASYNC and there is no `export const db`. PGlite has to
 * await `waitReady` and run migrations before the first query, and neither can
 * happen synchronously at module scope. Route handlers do:
 *
 *     const db = await getDb();
 *     const rows = await db.select().from(things);
 *
 * WHY THE PROMISE IS MEMOIZED ON `globalThis`, which is a requirement and not
 * an optimization. Measured 2026-08-16 in the Back21 preview container:
 *
 *   - `next dev` evaluates this module once per route bundle, and again after
 *     file edits. Without the global, each evaluation constructed its own
 *     PGlite (174 MB of WASM memory each, never freed) and re-ran migrations
 *     against a fresh empty instance - the person watching the preview saw
 *     their rows vanish mid-session (rowCount 6 -> 0).
 *   - Memoizing the PROMISE (not the instance) is what makes concurrent first
 *     requests safe: five parallel POSTs against a cold server all got 201
 *     with exactly one construction and one migration run.
 *
 * A failed construction stays memoized on purpose. Retrying per request would
 * boot another 174 MB instance each time only to fail the same way; the loud,
 * stable error is the honest state, and restarting the dev server (which a
 * repaired migration needs anyway) clears it.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../drizzle/schema.ts";
import { isDeployed } from "./identity.ts";

/**
 * Both branches are a drizzle PgDatabase over the same schema; they differ
 * only in driver session types, so the pg shape is the one the app codes
 * against.
 */
export type Db = NodePgDatabase<typeof schema>;

const g = globalThis as unknown as { __back21DbPromise?: Promise<Db> };

async function createDb(): Promise<Db> {
  if (isDeployed()) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    return drizzle(pool, { schema });
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema });

  // A fresh app has no migrations yet, and an empty database is its true
  // state. Only when drizzle-kit has generated migrations (the journal file
  // is written alongside them) is there anything to apply.
  const { existsSync } = await import("node:fs");
  if (existsSync("db/migrations/meta/_journal.json")) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db, { migrationsFolder: "db/migrations" });
  }

  return db as unknown as Db;
}

/**
 * The database this app talks to. Route handlers and server actions are the
 * only places that should call this; client components go through a fetch to
 * a route handler, never here.
 */
export function getDb(): Promise<Db> {
  if (!g.__back21DbPromise) g.__back21DbPromise = createDb();
  return g.__back21DbPromise;
}
