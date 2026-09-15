// Exam persistence.
//
// `getExamById` returns the same object shape the previous JSON store served:
// { id, title, description, questions: [...] }

import crypto from "crypto";
import { nowIso } from "../db/index.js";
import { countQuestionsByExam, getQuestionsForExam } from "./questions.js";

export function listExams(db) {
  const rows = db
    .prepare(`
      SELECT id, title, description
      FROM exams
      WHERE deleted_at IS NULL
      ORDER BY sort_order, id
    `)
    .all();
  const counts = countQuestionsByExam(db);

  return rows.map(row => ({
    id: row.id,
    title: row.title,
    description: row.description || "",
    questionCount: counts.get(row.id) || 0
  }));
}

export function getExamById(db, id) {
  const row = db
    .prepare("SELECT id, title, description FROM exams WHERE id = ? AND deleted_at IS NULL")
    .get(id);
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    questions: getQuestionsForExam(db, row.id)
  };
}

export function examExists(db, id) {
  return Boolean(db.prepare("SELECT 1 FROM exams WHERE id = ?").get(id));
}

export function nextExamSortOrder(db) {
  const row = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM exams").get();
  return Number(row.maxSort) + 1;
}

/**
 * Insert an exam row. `options.id`/`options.sortOrder`/`options.createdAt` are
 * used by the JSON importer to preserve legacy stable ids and file ordering.
 */
export function insertExam(db, { title, description = "" }, options = {}) {
  const id = options.id ? String(options.id) : crypto.randomUUID();
  const sortOrder = options.sortOrder === undefined ? nextExamSortOrder(db) : Number(options.sortOrder);
  const timestamp = options.createdAt || nowIso();

  db.prepare(`
    INSERT INTO exams (id, title, description, visibility, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description, options.visibility || "public", sortOrder, timestamp, timestamp);

  return id;
}

export function createExam(db, { title, description = "" }) {
  const id = insertExam(db, { title, description });
  return { id, title, description, questions: [] };
}
