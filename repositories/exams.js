// Exam persistence.
//
// `getExamById` returns the same object shape the previous JSON store served:
// { id, title, description, questions: [...] }
//
// Listing is filtered by authorization so callers never post-filter, and each
// row carries its access relationship for the UI.

import crypto from "crypto";
import { nowIso } from "../db/index.js";
import { readMeta, writeMeta } from "../db/meta.js";
import { canEditExam, examAccess, examAccessFilter } from "../auth/authorization.js";
import { countQuestionsByExam, getQuestionsForExam } from "./questions.js";

export const DEFAULT_VISIBILITY = "private";
export const VISIBILITIES = ["public", "private"];

const LEGACY_CLAIM_KEY = "legacy_exam_claim";

export function listExams(db, user = null) {
  const filter = examAccessFilter(user);
  const rows = db.prepare(`
    SELECT e.id, e.title, e.description, e.owner_user_id, e.visibility
    FROM exams e
    WHERE e.deleted_at IS NULL AND ${filter.sql}
    ORDER BY e.sort_order, e.id
  `).all(...filter.params);

  const counts = countQuestionsByExam(db);

  return rows.map(row => {
    const exam = {
      id: row.id,
      ownerUserId: row.owner_user_id,
      visibility: row.visibility
    };
    return {
      id: row.id,
      title: row.title,
      description: row.description || "",
      questionCount: counts.get(row.id) || 0,
      visibility: row.visibility,
      access: examAccess(db, exam, user),
      canEdit: canEditExam(db, exam, user)
    };
  });
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
 *
 * New exams default to private (Issue #11). The legacy file importer passes
 * "public" explicitly to preserve pre-authentication behaviour.
 */
export function insertExam(db, { title, description = "" }, options = {}) {
  const id = options.id ? String(options.id) : crypto.randomUUID();
  const sortOrder = options.sortOrder === undefined ? nextExamSortOrder(db) : Number(options.sortOrder);
  const timestamp = options.createdAt || nowIso();

  db.prepare(`
    INSERT INTO exams (id, title, description, owner_user_id, visibility, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, title, description,
    options.ownerUserId ?? null,
    options.visibility || DEFAULT_VISIBILITY,
    sortOrder, timestamp, timestamp
  );

  return id;
}

export function createExam(db, { title, description = "" }, options = {}) {
  const visibility = VISIBILITIES.includes(options.visibility) ? options.visibility : DEFAULT_VISIBILITY;
  const id = insertExam(db, { title, description }, {
    ownerUserId: options.ownerUserId ?? null,
    visibility
  });

  return { id, title, description, visibility, questions: [] };
}

export function updateExamVisibility(db, id, visibility) {
  const info = db.prepare(
    "UPDATE exams SET visibility = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
  ).run(visibility, nowIso(), id);
  return info.changes > 0;
}

/**
 * Hand every pre-authentication exam (owner_user_id IS NULL) to the first
 * admin, exactly once. Recorded in app_meta so a later admin never re-claims
 * exams an owner has since taken responsibility for.
 */
export function claimLegacyExams(db, adminUserId, { logger = console } = {}) {
  if (!adminUserId) return { claimed: 0, alreadyClaimed: false };

  const marker = readMeta(db, LEGACY_CLAIM_KEY);
  if (marker && marker.done) return { claimed: 0, alreadyClaimed: true };

  const apply = db.transaction(() => {
    const info = db.prepare(`
      UPDATE exams
      SET owner_user_id = ?, updated_at = ?
      WHERE owner_user_id IS NULL AND deleted_at IS NULL
    `).run(adminUserId, nowIso());

    writeMeta(db, LEGACY_CLAIM_KEY, {
      done: true,
      ownerUserId: adminUserId,
      claimed: info.changes,
      at: nowIso()
    });

    return info.changes;
  });

  const claimed = apply();
  if (claimed > 0) {
    logger.log(`[auth] claimed ${claimed} pre-authentication exam(s) for user ${adminUserId}`);
  }
  return { claimed, alreadyClaimed: false };
}

export function getLegacyClaim(db) {
  return readMeta(db, LEGACY_CLAIM_KEY);
}

/* ------------------------------------------------------------------- trash */

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * Retention window in days, overridable with TRASH_RETENTION_DAYS. Read lazily
 * so a value loaded from .env after module import is still honoured.
 */
export function trashRetentionDays() {
  const configured = Number(process.env.TRASH_RETENTION_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TRASH_RETENTION_DAYS;
}

/**
 * Soft-delete an exam: metadata only. The exam row, its questions, its
 * assignments and its image files are all left untouched.
 */
export function deleteExam(db, id, { deletedByUserId = null } = {}) {
  const now = Date.now();
  const deletedAt = new Date(now).toISOString();
  const restoreUntil = new Date(now + trashRetentionDays() * DAY_MS).toISOString();

  const info = db.prepare(`
    UPDATE exams
    SET deleted_at = ?, deleted_by_user_id = ?, restore_until = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(deletedAt, deletedByUserId, restoreUntil, deletedAt, id);

  if (info.changes === 0) return null;
  return { id, deletedAt, restoreUntil };
}

/** Clear the soft-delete metadata, returning the exam to the normal rules. */
export function restoreExam(db, id) {
  const info = db.prepare(`
    UPDATE exams
    SET deleted_at = NULL, deleted_by_user_id = NULL, restore_until = NULL, updated_at = ?
    WHERE id = ? AND deleted_at IS NOT NULL
  `).run(nowIso(), id);
  return info.changes > 0;
}

export function findTrashedExam(db, id) {
  return db.prepare(`
    SELECT id, title, owner_user_id, deleted_at, deleted_by_user_id, restore_until
    FROM exams
    WHERE id = ? AND deleted_at IS NOT NULL
  `).get(id) || null;
}

/** True while the exam is still inside its restore window. */
export function isWithinRestoreWindow(row, now = Date.now()) {
  const until = row.restore_until ? Date.parse(row.restore_until) : Number.NaN;
  if (Number.isFinite(until)) return now <= until;

  // Defensive: a deleted row without a deadline falls back to deleted_at + window.
  const base = row.deleted_at ? Date.parse(row.deleted_at) : Number.NaN;
  if (Number.isFinite(base)) return now <= base + trashRetentionDays() * DAY_MS;
  return true;
}

/**
 * Deleted exams visible in the caller's Trash: their own, or everything for an
 * admin. Exams whose restore window has passed are omitted from the UI even
 * though they remain stored on disk and in the database.
 */
export function listTrash(db, user = null) {
  const unrestricted = !user || user.role === "admin";
  const rows = db.prepare(`
    SELECT e.id, e.title, e.description, e.owner_user_id, e.deleted_at,
           e.deleted_by_user_id, e.restore_until,
           u.name AS owner_name, u.email AS owner_email
    FROM exams e
    LEFT JOIN users u ON u.id = e.owner_user_id
    WHERE e.deleted_at IS NOT NULL
      AND (? = 1 OR e.owner_user_id = ?)
    ORDER BY e.deleted_at DESC
  `).all(unrestricted ? 1 : 0, user ? user.id : -1);

  const counts = countQuestionsByExam(db);
  const now = Date.now();

  return rows
    .filter(row => isWithinRestoreWindow(row, now))
    .map(row => ({
      id: row.id,
      title: row.title,
      description: row.description || "",
      questionCount: counts.get(row.id) || 0,
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name || "",
      ownerEmail: row.owner_email || "",
      deletedAt: row.deleted_at,
      restoreUntil: row.restore_until,
      deletedByUserId: row.deleted_by_user_id
    }));
}
