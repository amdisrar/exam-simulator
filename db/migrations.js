// Versioned schema migration runner.
//
// Safe to run on every start: only migrations with a version greater than the
// database's current `PRAGMA user_version` are applied, each inside its own
// transaction so a failure leaves the database untouched.

import { MIGRATIONS } from "./schema.js";

export function getSchemaVersion(db) {
  return db.pragma("user_version", { simple: true });
}

export function runMigrations(db, { logger = console } = {}) {
  const from = getSchemaVersion(db);
  const pending = MIGRATIONS
    .filter(migration => migration.version > from)
    .sort((a, b) => a.version - b.version);

  if (!pending.length) {
    return { from, to: from, applied: [] };
  }

  // Bootstrap table so migration rows can be recorded even on a fresh file.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = [];
  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
      db.prepare(
        "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(migration.version, migration.name, new Date().toISOString());
    });

    apply();
    applied.push(migration.version);
    logger.log(`[db] applied migration ${migration.version} (${migration.name})`);
  }

  return { from, to: getSchemaVersion(db), applied };
}
