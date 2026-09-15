// Question persistence.
//
// Reads reconstruct the exact JSON shape the browser already expects:
//   single/multiple -> { id, text, type, explanation, images, options, correct }
//   dragdrop        -> { id, text, type, explanation, images, dragItems, dropTargets }
//
// Writes only ever touch a single question; ordering is preserved through the
// `position` columns.

import crypto from "crypto";
import { nowIso } from "../db/index.js";

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
         i.data AS data, i.file_path AS file_path
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
  if (row.storage === "file") return row.file_path || "";
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

export function nextQuestionPosition(db, examId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(position), -1) AS maxPosition FROM questions WHERE exam_id = ?")
    .get(examId);
  return Number(row.maxPosition) + 1;
}

function insertQuestionData(db, questionId, payload, timestamp) {
  const insertImage = db.prepare(`
    INSERT INTO question_images (question_id, position, storage, data, file_path, mime_type, created_at)
    VALUES (?, ?, 'inline', ?, NULL, NULL, ?)
  `);
  payload.images.forEach((image, index) => insertImage.run(questionId, index, image, timestamp));

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

/**
 * Insert a question. `options.uid`/`options.position` are used by the JSON
 * importer to preserve the legacy stable ids and ordering.
 */
export function insertQuestion(db, examId, payload, options = {}) {
  const uid = options.uid ? String(options.uid) : crypto.randomUUID();
  const position = options.position === undefined ? nextQuestionPosition(db, examId) : Number(options.position);
  const timestamp = options.createdAt || nowIso();

  const run = db.transaction(() => {
    const result = db
      .prepare(`
        INSERT INTO questions (exam_id, uid, position, text, type, explanation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(examId, uid, position, payload.text, payload.type, payload.explanation, timestamp, timestamp);

    insertQuestionData(db, Number(result.lastInsertRowid), payload, timestamp);
  });

  run();
  return uid;
}

export function createQuestion(db, examId, payload) {
  const uid = insertQuestion(db, examId, payload);
  return { id: uid, ...payload };
}

export function updateQuestion(db, examId, uid, payload) {
  const existing = findQuestionRow(db, examId, uid);
  if (!existing) return null;

  const timestamp = nowIso();
  const run = db.transaction(() => {
    clearQuestionData(db, existing.id);
    db.prepare(`
      UPDATE questions SET text = ?, type = ?, explanation = ?, updated_at = ?
      WHERE id = ?
    `).run(payload.text, payload.type, payload.explanation, timestamp, existing.id);
    insertQuestionData(db, existing.id, payload, timestamp);
  });

  run();
  return { id: existing.uid, ...payload };
}

export function deleteQuestion(db, examId, uid) {
  const result = db
    .prepare("DELETE FROM questions WHERE exam_id = ? AND uid = ?")
    .run(examId, uid);
  return result.changes > 0;
}

export function countQuestionsByExam(db) {
  const rows = db
    .prepare("SELECT exam_id, COUNT(*) AS count FROM questions WHERE deleted_at IS NULL GROUP BY exam_id")
    .all();
  return new Map(rows.map(row => [row.exam_id, Number(row.count)]));
}
