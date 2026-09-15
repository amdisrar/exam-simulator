// One-way import of the legacy data/exams.json into SQLite.
//
// Guarantees (Issue #5):
// - The source JSON is only ever read. It is never modified or deleted.
// - A timestamped backup is written to data/backups/ before the database is
//   touched, so the pre-migration state stays recoverable.
// - The import is idempotent: it is keyed on a hash of the source file and it
//   never inserts an exam id that already exists. Running it repeatedly (or on
//   every start) cannot duplicate records.
// - Exam ids, question ids, ordering, options, correct answers, drag & drop
//   mappings, explanations and images are preserved.
// - A failed import rolls back completely and leaves the JSON recoverable.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { BACKUP_DIR, DATA_DIR, ROOT_DIR, nowIso } from "./index.js";
import { readMeta, writeMeta } from "./meta.js";
import { examExists, insertExam } from "../repositories/exams.js";
import { insertQuestion } from "../repositories/questions.js";

export const SOURCE_PATH = path.join(DATA_DIR, "exams.json");
export const IMPORT_MARKER_KEY = "json_import:exams.json";

export { readMeta, writeMeta };

export function getImportStatus(db) {
  return readMeta(db, IMPORT_MARKER_KEY);
}

function hashContents(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function toText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function relativeToRoot(targetPath) {
  return path.relative(ROOT_DIR, targetPath).split(path.sep).join("/");
}

function uniqueId(candidate, used) {
  const base = candidate || crypto.randomUUID();
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const unique = `${base}-${suffix}`;
  used.add(unique);
  return unique;
}

function normalizeImages(source) {
  const list = Array.isArray(source.images)
    ? source.images
    : source.image
      ? [source.image]
      : [];
  return list.map(toText).filter(Boolean);
}

function normalizeDragDrop(source) {
  const remap = new Map();
  const usedItemIds = new Set();
  const dragItems = (Array.isArray(source.dragItems) ? source.dragItems : []).map(item => {
    const originalId = toText(item?.id) || `item-${crypto.randomUUID()}`;
    const id = uniqueId(originalId, usedItemIds);
    if (!remap.has(originalId)) remap.set(originalId, id);
    return { id, text: toText(item?.text) };
  });

  const usedTargetIds = new Set();
  const dropTargets = (Array.isArray(source.dropTargets) ? source.dropTargets : []).map(target => {
    const correctOriginal = toText(target?.correctItemId);
    return {
      id: uniqueId(toText(target?.id) || `target-${crypto.randomUUID()}`, usedTargetIds),
      label: toText(target?.label),
      // Unmappable references become NULL so the composite FK stays valid
      // instead of aborting the whole import.
      correctItemId: remap.get(correctOriginal) || null
    };
  });

  return { dragItems, dropTargets };
}

function normalizeQuestion(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const type = ["multiple", "dragdrop"].includes(source.type) ? source.type : "single";
  const payload = {
    text: toText(source.text),
    type,
    explanation: toText(source.explanation),
    images: normalizeImages(source)
  };

  if (type === "dragdrop") {
    Object.assign(payload, normalizeDragDrop(source));
    return { uid: toText(source.id), payload };
  }

  const options = (Array.isArray(source.options) ? source.options : []).map(toText);
  const correct = Array.isArray(source.correct)
    ? source.correct
        .map(Number)
        .filter(index => Number.isInteger(index) && index >= 0 && index < options.length)
    : [];

  payload.options = options;
  payload.correct = [...new Set(correct)];
  return { uid: toText(source.id), payload };
}

function normalizeExam(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const questions = (Array.isArray(source.questions) ? source.questions : []).map(normalizeQuestion);
  return {
    id: toText(source.id),
    title: toText(source.title) || "Untitled exam",
    description: toText(source.description),
    questions
  };
}

function createBackup(sourcePath, contents, logger) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parsed = path.parse(sourcePath);
  const target = path.join(BACKUP_DIR, `${parsed.name}-${stamp}${parsed.ext || ".json"}`);
  fs.writeFileSync(target, contents, "utf8");
  logger.log(`[db] backup written to ${relativeToRoot(target)}`);
  return target;
}

/**
 * Import data/exams.json into SQLite when needed.
 *
 * @returns {{status: "imported"|"skipped"|"failed", reason?: string, ...}}
 */
export function importJsonIfNeeded(db, { sourcePath = SOURCE_PATH, logger = console } = {}) {
  const source = relativeToRoot(sourcePath);

  if (!fs.existsSync(sourcePath)) {
    return { status: "skipped", reason: "source-missing", source };
  }

  let contents;
  try {
    contents = fs.readFileSync(sourcePath, "utf8");
  } catch (error) {
    logger.error(`[db] could not read ${source}: ${error.message}`);
    return { status: "failed", reason: "read-error", error: error.message, source };
  }

  const sourceHash = hashContents(contents);
  const marker = readMeta(db, IMPORT_MARKER_KEY);

  if (marker && marker.status === "completed" && marker.sourceHash === sourceHash) {
    return { status: "skipped", reason: "already-imported", source, sourceHash };
  }

  let exams;
  try {
    exams = JSON.parse(contents);
    if (!Array.isArray(exams)) throw new Error("root value must be a JSON array of exams");
  } catch (error) {
    writeMeta(db, IMPORT_MARKER_KEY, {
      status: "failed",
      reason: "parse-error",
      error: error.message,
      source,
      sourceHash,
      at: nowIso()
    });
    logger.error(`[db] ${source} could not be parsed (${error.message}); database left unchanged`);
    return { status: "failed", reason: "parse-error", error: error.message, source };
  }

  let backupPath;
  try {
    backupPath = createBackup(sourcePath, contents, logger);
  } catch (error) {
    writeMeta(db, IMPORT_MARKER_KEY, {
      status: "failed",
      reason: "backup-error",
      error: error.message,
      source,
      sourceHash,
      at: nowIso()
    });
    logger.error(`[db] backup failed (${error.message}); aborting import to keep data recoverable`);
    return { status: "failed", reason: "backup-error", error: error.message, source };
  }

  try {
    const stats = db.transaction(() => {
      const usedExamIds = new Set();
      let importedExams = 0;
      let importedQuestions = 0;
      let skippedExams = 0;

      exams.forEach((rawExam, examIndex) => {
        const exam = normalizeExam(rawExam);
        const examId = uniqueId(exam.id, usedExamIds);

        // Insert-only: an exam that already exists is never duplicated or
        // overwritten, so re-running the import is always safe.
        if (examExists(db, examId)) {
          skippedExams += 1;
          return;
        }

        insertExam(
          db,
          { title: exam.title, description: exam.description },
          { id: examId, sortOrder: examIndex, visibility: "public" }
        );

        const usedQuestionIds = new Set();
        exam.questions.forEach((question, questionIndex) => {
          insertQuestion(db, examId, question.payload, {
            uid: uniqueId(question.uid, usedQuestionIds),
            position: questionIndex
          });
          importedQuestions += 1;
        });

        importedExams += 1;
      });

      return { importedExams, importedQuestions, skippedExams };
    })();

    writeMeta(db, IMPORT_MARKER_KEY, {
      status: "completed",
      source,
      sourceHash,
      backup: relativeToRoot(backupPath),
      ...stats,
      at: nowIso()
    });

    if (stats.importedExams > 0) {
      logger.log(
        `[db] imported ${stats.importedExams} exam(s) and ${stats.importedQuestions} question(s) from ${source}`
      );
    } else {
      logger.log(`[db] ${source} contained no new exams (${stats.skippedExams} already present)`);
    }

    return { status: "imported", source, sourceHash, backupPath, ...stats };
  } catch (error) {
    writeMeta(db, IMPORT_MARKER_KEY, {
      status: "failed",
      reason: "import-error",
      error: error.message,
      source,
      sourceHash,
      at: nowIso()
    });
    logger.error(
      `[db] import from ${source} failed and was rolled back (${error.message}); ${source} is unchanged`
    );
    return { status: "failed", reason: "import-error", error: error.message, source };
  }
}
