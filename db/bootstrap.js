// Storage bootstrap: opens SQLite, applies schema migrations and, when needed,
// imports the legacy JSON source into the database.

import { DB_PATH, getDb, openDatabase } from "./index.js";
import { importJsonIfNeeded } from "./json-import.js";

export function initializeStorage({ logger = console } = {}) {
  const db = getDb({ logger });
  const importResult = importJsonIfNeeded(db, { logger });

  return { db, path: DB_PATH, importResult };
}

export { openDatabase, getDb, DB_PATH };
