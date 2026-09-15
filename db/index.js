// SQLite connection handling.
//
// The database file lives under data/ and is local-only (never committed).
// WAL mode and foreign key enforcement are enabled on every connection.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const DB_PATH = process.env.EXAM_SIMULATOR_DB || path.join(DATA_DIR, "exam-simulator.db");

let connection = null;

export function nowIso() {
  return new Date().toISOString();
}

function configure(db) {
  // WAL is persistent in the database file; re-applying it is harmless.
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return journalMode;
}

export function openDatabase(dbPath = DB_PATH, { logger = console } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  const journalMode = configure(db);
  const migrationResult = runMigrations(db, { logger });

  if (String(journalMode).toLowerCase() !== "wal") {
    logger.warn(`[db] WAL mode was not enabled (journal_mode=${journalMode})`);
  }

  return { db, journalMode, migrationResult, path: dbPath };
}

export function getDb({ logger = console } = {}) {
  if (!connection) {
    const { db } = openDatabase(DB_PATH, { logger });
    connection = db;
  }
  return connection;
}

export function closeDb() {
  if (connection) {
    connection.close();
    connection = null;
  }
}
