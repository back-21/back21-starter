/**
 * Which database this app talks to, and that there is only ever one of it.
 *
 * Run with `npm test` (Node 22+, no test framework installed).
 *
 * WHY THIS FILE EXISTS. `lib/db.ts` is the one place that decides whether the
 * app talks to the customer's PostgreSQL (deployed) or to an in-process PGlite
 * (preview, local dev). Both failure modes it guards against were measured in
 * the Back21 preview container on 2026-08-16 before the file was written:
 *
 *   - The branch inverting would either point a preview at a database that is
 *     not there, or silently swallow a customer's real database behind an
 *     in-memory one.
 *   - Without the `globalThis` memo, `next dev` constructed one 174 MB PGlite
 *     per module evaluation and the person watching the preview saw their rows
 *     vanish mid-session.
 *
 * Each test observes BEHAVIOR, not internals: the pg branch is recognized by
 * the pg driver's own connection failure, the PGlite branch by a query that
 * answers with no server anywhere, and the singleton by data written through
 * one module evaluation being readable through another.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sql } from "drizzle-orm";

import { getDb } from "../lib/db.ts";

const g = globalThis as unknown as { __back21DbPromise?: Promise<unknown> };

/** A fresh first call: the world before any request has touched the db. */
function resetDbSingleton(): void {
  delete g.__back21DbPromise;
}

/** Walk `.cause` chains and AggregateError lists for a system error code. */
function hasCode(err: unknown, code: string): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown[];
  };
  if (e.code === code) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => hasCode(x, code))) {
    return true;
  }
  return hasCode(e.cause, code);
}

function setEnv(name: string, value: string | undefined): () => void {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  };
}

test("deployed (WEBSITE_SITE_NAME set) chooses the pg driver, not PGlite", async () => {
  const restoreSite = setEnv("WEBSITE_SITE_NAME", "some-app");
  // Port 1 is reserved and nothing listens on it, so the pg driver fails with
  // its own ECONNREFUSED. PGlite would answer this query without any network
  // at all, so a success here means the branch inverted.
  const restoreUrl = setEnv(
    "DATABASE_URL",
    "postgres://nobody:nothing@127.0.0.1:1/nothing",
  );
  resetDbSingleton();
  try {
    const db = (await getDb()) as unknown as {
      execute: (q: unknown) => Promise<unknown>;
    };
    await assert.rejects(
      () => db.execute(sql`select 1`),
      (err: unknown) => {
        assert.ok(
          hasCode(err, "ECONNREFUSED"),
          `expected the pg driver's ECONNREFUSED, got: ${String(err)}`,
        );
        return true;
      },
    );
  } finally {
    resetDbSingleton();
    restoreSite();
    restoreUrl();
  }
});

test("not deployed answers queries with no database server anywhere", async () => {
  const restoreSite = setEnv("WEBSITE_SITE_NAME", undefined);
  const restoreUrl = setEnv("DATABASE_URL", undefined);
  resetDbSingleton();
  try {
    const db = await getDb();
    const result = (await db.execute(sql`select 1 as one`)) as {
      rows: Array<Record<string, unknown>>;
    };
    // Mutation check: on the pg branch this rejects (nothing is listening on
    // any default address), so a green here is PGlite and only PGlite.
    assert.equal(result.rows.length, 1);
    assert.equal(Number(result.rows[0]?.one), 1);
  } finally {
    restoreSite();
    restoreUrl();
    // The instance is left memoized on purpose: the next test asserts that a
    // second module evaluation joins THIS one instead of building its own.
  }
});

test("concurrent first calls and separate module evaluations share one instance", async () => {
  const restoreSite = setEnv("WEBSITE_SITE_NAME", undefined);
  resetDbSingleton();
  try {
    // Concurrent first requests: both callers must get the SAME promise, which
    // is what makes five parallel cold POSTs construct exactly one PGlite.
    const first = getDb();
    const second = getDb();
    assert.equal(first, second, "getDb() must memoize the promise itself");
    const dbA = await first;

    // `next dev` evaluates lib/db.ts once per route bundle. A query string
    // forces a genuinely separate evaluation of the same file, the way a
    // second route does; the memo lives on globalThis, so it must join the
    // instance above rather than construct its own.
    const twin = (await import("../lib/db.ts?second-evaluation")) as {
      getDb: typeof getDb;
    };
    const dbB = await twin.getDb();
    assert.equal(
      dbA as unknown,
      dbB as unknown,
      "a second module evaluation must reuse the same database instance",
    );

    // The property the person in the preview actually cares about: a row
    // written through one evaluation is readable through the other. Without
    // the shared instance this select would fail on a missing table.
    await dbA.execute(sql`create table singleton_probe (id int)`);
    await dbA.execute(sql`insert into singleton_probe values (21)`);
    const read = (await dbB.execute(sql`select id from singleton_probe`)) as {
      rows: Array<Record<string, unknown>>;
    };
    assert.equal(read.rows.length, 1);
    assert.equal(Number(read.rows[0]?.id), 21);
  } finally {
    resetDbSingleton();
    restoreSite();
  }
});
