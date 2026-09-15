#!/usr/bin/env node
// Explicit storage migration entry point.
//
//   npm run db:migrate
//
// Applies any pending schema migrations and imports data/exams.json when it has
// not been imported yet. Safe to run repeatedly.

import { initializeStorage } from "../db/bootstrap.js";
import { getSchemaVersion } from "../db/migrations.js";
import { getImportStatus } from "../db/json-import.js";

const logger = console;
const { db, path: dbPath, importResult, imageResult } = initializeStorage({ logger });

const schemaVersion = getSchemaVersion(db);
const journalMode = db.pragma("journal_mode", { simple: true });
const foreignKeys = db.pragma("foreign_keys", { simple: true });
const examCount = db.prepare("SELECT COUNT(*) AS count FROM exams").get().count;
const questionCount = db.prepare("SELECT COUNT(*) AS count FROM questions").get().count;
const importStatus = getImportStatus(db);

console.log("");
console.log(`database        : ${dbPath}`);
console.log(`schema version  : ${schemaVersion}`);
console.log(`journal mode    : ${journalMode}`);
console.log(`foreign keys    : ${foreignKeys ? "on" : "off"}`);
console.log(`exams/questions : ${examCount} / ${questionCount}`);
console.log(`json import     : ${importResult.status}${importResult.reason ? ` (${importResult.reason})` : ""}`);
if (imageResult) {
  console.log(`inline images   : ${imageResult.migrated} moved to disk, ${imageResult.skipped} left inline`);
}
if (importStatus) {
  console.log(`last import     : ${importStatus.status} at ${importStatus.at}${importStatus.backup ? ` (backup: ${importStatus.backup})` : ""}`);
}

db.close();

if (importResult.status === "failed") {
  console.error("\nJSON import failed. The database was left unchanged and data/exams.json is intact.");
  process.exitCode = 1;
}
