// Exam assignment (sharing) — Issue #12.
//
// Assignments grant **view/take access only**. `permission` is always 'view':
// recipients can never edit, delete, re-share or change visibility.
//
// Removal is a soft revoke (`revoked_at`) rather than a delete, so the record of
// who shared what is preserved, and re-sharing the same person revives the
// existing row instead of creating a duplicate.

import { nowIso } from "../db/index.js";

export const ASSIGNMENT_PERMISSION = "view";
export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_RESULTS = 50;

export class AssignmentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AssignmentError";
    this.status = status;
  }
}

export function hasActiveAssignment(db, examId, userId) {
  if (!userId || !examId) return false;
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM exam_assignments
    WHERE exam_id = ? AND assignee_user_id = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1
  `).get(examId, userId, nowIso()));
}

/** Active assignments for an exam, with the recipient's display details. */
export function listAssignmentsForExam(db, examId) {
  return db.prepare(`
    SELECT a.id, a.exam_id, a.assignee_user_id, a.assigned_by_user_id,
           a.permission, a.created_at, a.revoked_at, a.expires_at,
           u.email AS assignee_email, u.name AS assignee_name,
           u.picture_url AS assignee_picture, u.status AS assignee_status
    FROM exam_assignments a
    JOIN users u ON u.id = a.assignee_user_id
    WHERE a.exam_id = ? AND a.revoked_at IS NULL
    ORDER BY lower(coalesce(u.name, u.email)) ASC
  `).all(examId);
}

export function findAssignmentById(db, examId, assignmentId) {
  const id = Number(assignmentId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(`
    SELECT a.id, a.exam_id, a.assignee_user_id, a.assigned_by_user_id,
           a.permission, a.created_at, a.revoked_at, a.expires_at,
           u.email AS assignee_email, u.name AS assignee_name,
           u.picture_url AS assignee_picture, u.status AS assignee_status
    FROM exam_assignments a
    JOIN users u ON u.id = a.assignee_user_id
    WHERE a.id = ? AND a.exam_id = ? AND a.revoked_at IS NULL
  `).get(id, examId) || null;
}

export function listAssignmentsForUser(db, userId) {
  return db.prepare(`
    SELECT exam_id
    FROM exam_assignments
    WHERE assignee_user_id = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
  `).all(userId, nowIso()).map(row => row.exam_id);
}

/* ------------------------------------------------------------ user lookup */

/** Only an active, non-deleted account may receive a share. */
export function findAssignableUser(db, userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(`
    SELECT id, name, email, picture_url
    FROM users
    WHERE id = ? AND status = 'active' AND deleted_at IS NULL
  `).get(id) || null;
}

export function findAssignableUserByEmail(db, email) {
  const value = String(email || "").trim();
  if (!value) return null;
  return db.prepare(`
    SELECT id, name, email, picture_url
    FROM users
    WHERE lower(email) = lower(?) AND status = 'active' AND deleted_at IS NULL
  `).get(value) || null;
}

/**
 * Search active users eligible to be shared with.
 *
 * Deliberately terse so an owner can find a colleague without being able to
 * browse the whole directory: a minimum search length is enforced by the route,
 * the caller is excluded, inactive accounts are omitted, only display fields are
 * returned, and the result set is capped.
 */
export function searchAssignableUsers(db, { search, excludeUserId = null, limit = MAX_SEARCH_RESULTS } = {}) {
  const term = String(search || "").trim();
  const like = `%${term}%`;
  return db.prepare(`
    SELECT id, name, email, picture_url
    FROM users
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND (? IS NULL OR id <> ?)
      AND (lower(coalesce(name, '')) LIKE lower(?) OR lower(coalesce(email, '')) LIKE lower(?))
    ORDER BY lower(coalesce(name, email)) ASC
    LIMIT ?
  `).all(excludeUserId, excludeUserId, like, like, Number(limit) || MAX_SEARCH_RESULTS);
}

/* ------------------------------------------------------------- mutations */

/**
 * Share an exam with a user. A previously revoked share is revived rather than
 * duplicated, because (exam, assignee) is unique.
 */
export function createAssignment(db, { examId, assigneeUserId, assignedByUserId }) {
  const now = nowIso();

  const apply = db.transaction(() => {
    const existing = db.prepare(
      "SELECT id, revoked_at FROM exam_assignments WHERE exam_id = ? AND assignee_user_id = ?"
    ).get(examId, assigneeUserId);

    if (existing && existing.revoked_at === null) {
      throw new AssignmentError("That user already has access to this exam.", 409);
    }

    if (existing) {
      db.prepare(`
        UPDATE exam_assignments
        SET revoked_at = NULL, expires_at = NULL, permission = ?,
            assigned_by_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(ASSIGNMENT_PERMISSION, assignedByUserId, now, existing.id);
      return existing.id;
    }

    const info = db.prepare(`
      INSERT INTO exam_assignments
        (exam_id, assignee_user_id, assigned_by_user_id, permission, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(examId, assigneeUserId, assignedByUserId, ASSIGNMENT_PERMISSION, now, now);

    return Number(info.lastInsertRowid);
  });

  return findAssignmentById(db, examId, apply());
}

/** Soft-revoke a share. Access ends immediately unless another rule still applies. */
export function revokeAssignment(db, examId, assignmentId) {
  const id = Number(assignmentId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const now = nowIso();
  const info = db.prepare(`
    UPDATE exam_assignments
    SET revoked_at = ?, updated_at = ?
    WHERE id = ? AND exam_id = ? AND revoked_at IS NULL
  `).run(now, now, id, examId);
  return info.changes > 0;
}
