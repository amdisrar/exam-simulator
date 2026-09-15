// Small key/value marker store backed by app_meta.
//
// Kept separate so both the JSON importer and the repositories can use it
// without importing each other.

import { nowIso } from "./index.js";

export function readMeta(db, key) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), nowIso());
}
