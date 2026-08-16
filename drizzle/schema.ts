/**
 * The app's database tables, described in code.
 *
 * EMPTY ON PURPOSE. A fresh app has no tables, and `lib/db.ts` imports this
 * module, so it has to exist for every app to compile whether or not the app
 * ever gets a database. The first time the app touches a database this file is
 * replaced with real `pgTable` definitions (drizzle-orm/pg-core), and every
 * change to it becomes a generated SQL migration in `db/migrations/` - the
 * same files that later run against the customer's own PostgreSQL.
 *
 * Deliberately imports nothing: an empty schema is "this app has no database
 * code yet", and importing drizzle-orm from here would make it look like data
 * code to anything that reads imports.
 */
export {};
