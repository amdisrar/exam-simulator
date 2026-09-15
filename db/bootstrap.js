// Storage bootstrap: opens SQLite, applies schema migrations, imports the
// legacy JSON source when needed and converts any remaining inline images to
// filesystem storage.

import { DB_PATH, getDb, openDatabase } from "./index.js";
import { importJsonIfNeeded } from "./json-import.js";
import { migrateInlineImages } from "./image-store.js";

export function initializeStorage({ logger = console } = {}) {
  const db = getDb({ logger });
  // Order matters: the JSON import can introduce inline Base64 images, so the
  // image conversion must run after it.
  const importResult = importJsonIfNeeded(db, { logger });
  const imageResult = migrateInlineImages(db, { logger });

  return { db, path: DB_PATH, importResult, imageResult };
}

export { openDatabase, getDb, DB_PATH };
