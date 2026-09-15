// Question persistence.
//
// Reads reconstruct the exact JSON shape the browser already expects:
//   single/multiple -> { id, text, type, explanation, images, options, correct }
//   dragdrop        -> { id, text, type, explanation, images, dragItems, dropTargets }
//
// Images are addressed by an opaque public URL ("/api/images/<uid>") once they
// live on the filesystem; legacy inline values are passed through unchanged.
//
// Writes only ever touch a single question; ordering is preserved through the
// `position` columns.

import crypto from "crypto";
import fs from "fs";
import { nowIso } from "../db/index.js";
import {
  buildImageRecord,
  copyImageIntoStore,
  isDataUrl,
  parsePublicImageUrl,
  removeUnreferencedFiles,
  writeImageFile,
  ImageValidationError
} from "../db/image-store.js";

const QUESTION_ROWS_SQL = `
  SELECT id, uid, position, text, type, explanation
  FROM questions
  WHERE exam_id = ? AND deleted_at IS NULL
  ORDER BY position, id
`;

// Joined through questions so we never build an unbounded IN (...) clause.
const OPTIONS_SQL = `
  SELECT o.question_id AS question_id, o.position AS position, o.text AS text,
         o.is_correct AS is_correct
  FROM question_options o
  JOIN questions q ON q.id = o.question_id
  WHERE q.exam_id = ? AND q.deleted_at IS NULL
  ORDER BY o.question_id, o.position
`;

const DRAG_ITEMS_SQL = `
  SELECT d.question_id AS question_id, d.uid AS uid, d.position AS position, d.text AS text
  FROM drag_items d
  JOIN questions q ON q.id = d.question_id
  WHERE q.exam_id = ? AND q.deleted_at IS NULL
  ORDER BY d.question_id, d.position
`;

const DROP_TARGETS_SQL = `
  SELECT t.question_id AS question_id, t.uid AS uid, t.position AS position,
         t.label AS label, t.correct_item_uid AS correct_item_uid
  FROM drop_targets t
  JOIN questions q ON q.id = t.question_id
  WHERE q.exam_id = ? AND q.deleted_at IS NULL
  ORDER BY t.question_id, t.position
`;

const IMAGES_SQL = `
  SELECT i.question_id AS question_id, i.position AS position, i.storage AS storage,
         i.data AS data, i.file_path AS file_path, i.uid AS uid
  FROM question_images i
  JOIN questions q ON q.id = i.question_id
  WHERE q.exam_id = ? AND q.deleted_at IS NULL
  ORDER BY i.question_id, i.position
`;

function groupByQuestion(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.question_id)) grouped.set(row.question_id, []);
    grouped.get(row.question_id).push(row);
  }
  return grouped;
}

function imageValue(row) {
  if (row.storage === "file" && row.uid) return `/api/images/${row.uid}`;
  return row.data || "";
}

function buildQuestion(row, grouped) {
  const base = {
    id: row.uid,
    text: row.text,
    type: row.type,
    explanation: row.explanation,
    images: (grouped.images.get(row.id) || []).map(imageValue).filter(Boolean)
  };

  if (row.type === "dragdrop") {
    return {
      ...base,
      dragItems: (grouped.dragItems.get(row.id) || []).map(item => ({
        id: item.uid,
        text: item.text
      })),
      dropTargets: (grouped.dropTargets.get(row.id) || []).map(target => ({
        id: target.uid,
        label: target.label,
        correctItemId: target.correct_item_uid || ""
      }))
    };
  }

  const options = grouped.options.get(row.id) || [];
  return {
    ...base,
    options: options.map(option => option.text),
    correct: options
      .map((option, index) => (option.is_correct ? index : -1))
      .filter(index => index >= 0)
  };
}

export function getQuestionsForExam(db, examId) {
  const rows = db.prepare(QUESTION_ROWS_SQL).all(examId);
  if (!rows.length) return [];

  const grouped = {
    options: groupByQuestion(db.prepare(OPTIONS_SQL).all(examId)),
    dragItems: groupByQuestion(db.prepare(DRAG_ITEMS_SQL).all(examId)),
    dropTargets: groupByQuestion(db.prepare(DROP_TARGETS_SQL).all(examId)),
    images: groupByQuestion(db.prepare(IMAGES_SQL).all(examId))
  };

  return rows.map(row => buildQuestion(row, grouped));
}

export function findQuestionRow(db, examId, uid) {
  return db
    .prepare("SELECT id, uid, position FROM questions WHERE exam_id = ? AND uid = ? AND deleted_at IS NULL")
    .get(examId, uid);
}

export function findImageByUid(db, uid) {
  return db
    .prepare("SELECT uid, storage, file_path, data, mime_type FROM question_images WHERE uid = ?")
    .get(uid) || null;
}

export function nextQuestionPosition(db, examId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(position), -1) AS maxPosition FROM questions WHERE exam_id = ?")
    .get(examId);
  return Number(row.maxPosition) + 1;
}

function normalizeImageInput(entry) {
  if (entry && typeof entry === "object") {
    return { value: String(entry.data ?? ""), filename: entry.name ?? null };
  }
  return { value: String(entry ?? ""), filename: null };
}

/**
 * Persist the images for one question in order.
 *
 * Each entry is either an existing public image URL (kept as is), a Base64 data
 * URL (validated and written to the filesystem), or a legacy external reference
 * (stored inline verbatim). Returns absolute paths of files written so the
 * caller can clean them up if the surrounding transaction fails.
 */
function writeQuestionImages(db, { questionId, questionUid, examId, existingImages = new Map() }, images, timestamp) {
  const insertImage = db.prepare(`
    INSERT INTO question_images
      (question_id, position, storage, data, file_path, mime_type, original_filename,
       byte_size, sha256, uid, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const writtenFiles = [];
  let position = 0;

  for (const entry of images || []) {
    // Canonical JSON import: copy an already-stored file into this question's
    // own directory so the imported copy owns its images.
    if (entry && typeof entry === "object" && entry.copyFrom) {
      const { record, relativePath, absolutePath } = copyImageIntoStore(entry.copyFrom, {
        examId,
        questionUid
      });
      writtenFiles.push(absolutePath);
      insertImage.run(
        questionId, position, "file", null, relativePath, record.mime,
        record.originalFilename, record.byteSize, record.sha256, record.uid, timestamp
      );
      position += 1;
      continue;
    }

    const { value, filename } = normalizeImageInput(entry);
    if (!value) continue;

    const existingUid = parsePublicImageUrl(value);
    if (existingUid) {
      // Looked up from the snapshot taken before the question's rows were
      // cleared, so kept images survive a replace-in-place update.
      const row = existingImages.get(existingUid);
      if (!row) {
        throw new ImageValidationError("An image in this question no longer exists. Reload the exam and try again.");
      }
      insertImage.run(
        questionId, position, row.storage, row.data, row.file_path, row.mime_type,
        row.original_filename, row.byte_size, row.sha256, row.uid, row.created_at
      );
      position += 1;
      continue;
    }

    if (isDataUrl(value)) {
      const record = buildImageRecord(value, filename);
      const { relativePath, absolutePath } = writeImageFile(record, { examId, questionUid });
      writtenFiles.push(absolutePath);
      insertImage.run(
        questionId, position, "file", null, relativePath, record.mime,
        record.originalFilename, record.byteSize, record.sha256, record.uid, timestamp
      );
      position += 1;
      continue;
    }

    // Legacy external reference (bare filename or remote URL): keep it as is.
    insertImage.run(
      questionId, position, "inline", value, null, null, filename, null, null,
      crypto.randomUUID(), timestamp
    );
    position += 1;
  }

  return writtenFiles;
}

function cleanupWrittenFiles(paths, logger = console) {
  for (const absolutePath of paths) {
    try {
      fs.unlinkSync(absolutePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.warn(`[images] could not clean up ${absolutePath}: ${error.message}`);
      }
    }
  }
}

function insertQuestionBody(db, questionId, payload, timestamp) {
  if (payload.type === "dragdrop") {
    const insertItem = db.prepare(
      "INSERT INTO drag_items (question_id, uid, position, text) VALUES (?, ?, ?, ?)"
    );
    payload.dragItems.forEach((item, index) =>
      insertItem.run(questionId, item.id, index, item.text)
    );

    const insertTarget = db.prepare(`
      INSERT INTO drop_targets (question_id, uid, position, label, correct_item_uid)
      VALUES (?, ?, ?, ?, ?)
    `);
    payload.dropTargets.forEach((target, index) =>
      insertTarget.run(
        questionId,
        target.id,
        index,
        target.label,
        target.correctItemId ? target.correctItemId : null
      )
    );
    return;
  }

  const insertOption = db.prepare(`
    INSERT INTO question_options (question_id, position, text, is_correct)
    VALUES (?, ?, ?, ?)
  `);
  const correctIndexes = new Set(payload.correct);
  payload.options.forEach((text, index) =>
    insertOption.run(questionId, index, text, correctIndexes.has(index) ? 1 : 0)
  );
}

function clearQuestionData(db, questionId) {
  // drop_targets first: their composite FK points at drag_items.
  db.prepare("DELETE FROM drop_targets WHERE question_id = ?").run(questionId);
  db.prepare("DELETE FROM drag_items WHERE question_id = ?").run(questionId);
  db.prepare("DELETE FROM question_options WHERE question_id = ?").run(questionId);
  db.prepare("DELETE FROM question_images WHERE question_id = ?").run(questionId);
}

function imageRowsForQuestion(db, questionId) {
  return db.prepare("SELECT * FROM question_images WHERE question_id = ?").all(questionId);
}

/**
 * Insert a question. `options.uid`/`options.position` are used by the JSON
 * importer to preserve the legacy stable ids and ordering.
 */
export function insertQuestion(db, examId, payload, options = {}) {
  const uid = options.uid ? String(options.uid) : crypto.randomUUID();
  const position = options.position === undefined ? nextQuestionPosition(db, examId) : Number(options.position);
  const timestamp = options.createdAt || nowIso();
  let writtenFiles = [];

  const run = db.transaction(() => {
    const result = db
      .prepare(`
        INSERT INTO questions (exam_id, uid, position, text, type, explanation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(examId, uid, position, payload.text, payload.type, payload.explanation, timestamp, timestamp);

    const questionId = Number(result.lastInsertRowid);
    writtenFiles = writeQuestionImages(
      db, { questionId, questionUid: uid, examId }, payload.images, timestamp
    );
    insertQuestionBody(db, questionId, payload, timestamp);
  });

  try {
    run();
  } catch (error) {
    cleanupWrittenFiles(writtenFiles);
    throw error;
  }

  return uid;
}

export function getQuestionByUid(db, examId, uid) {
  return getQuestionsForExam(db, examId).find(question => question.id === uid) || null;
}

export function createQuestion(db, examId, payload) {
  const uid = insertQuestion(db, examId, payload);
  return getQuestionByUid(db, examId, uid);
}

export function updateQuestion(db, examId, uid, payload) {
  const existing = findQuestionRow(db, examId, uid);
  if (!existing) return null;

  const previousImages = imageRowsForQuestion(db, existing.id);
  const existingImages = new Map(previousImages.map(row => [row.uid, row]));
  const timestamp = nowIso();
  let writtenFiles = [];

  const run = db.transaction(() => {
    clearQuestionData(db, existing.id);
    db.prepare(`
      UPDATE questions SET text = ?, type = ?, explanation = ?, updated_at = ?
      WHERE id = ?
    `).run(payload.text, payload.type, payload.explanation, timestamp, existing.id);

    writtenFiles = writeQuestionImages(
      db,
      { questionId: existing.id, questionUid: existing.uid, examId, existingImages },
      payload.images,
      timestamp
    );
    insertQuestionBody(db, existing.id, payload, timestamp);
  });

  try {
    run();
  } catch (error) {
    cleanupWrittenFiles(writtenFiles);
    throw error;
  }

  // Files that are still referenced (kept images) are left untouched.
  removeUnreferencedFiles(db, previousImages);

  return getQuestionByUid(db, examId, existing.uid);
}

export function deleteQuestion(db, examId, uid) {
  const row = db
    .prepare("SELECT id FROM questions WHERE exam_id = ? AND uid = ?")
    .get(examId, uid);
  if (!row) return false;

  const images = imageRowsForQuestion(db, row.id);
  db.prepare("DELETE FROM questions WHERE id = ?").run(row.id);
  removeUnreferencedFiles(db, images);
  return true;
}

export function countQuestionsByExam(db) {
  const rows = db
    .prepare("SELECT exam_id, COUNT(*) AS count FROM questions WHERE deleted_at IS NULL GROUP BY exam_id")
    .all();
  return new Map(rows.map(row => [row.exam_id, Number(row.count)]));
}
