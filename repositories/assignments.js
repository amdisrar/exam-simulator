// Exam assignment access (Issue #10 read path; management arrives in #12).
//
// Assignments grant view/take access only. `permission` exists in the schema but
// is always 'view': #10 states that assignment never grants edit, delete,
// visibility-change or re-sharing rights.

import { nowIso } from "../db/index.js";

export const ASSIGNMENT_PERMISSION = "view";

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

export function listAssignmentsForExam(db, examId) {
  return db.prepare(`
    SELECT a.id, a.exam_id, a.assignee_user_id, a.assigned_by_user_id,
           a.permission, a.created_at, a.revoked_at, a.expires_at,
           u.email AS assignee_email, u.name AS assignee_name, u.status AS assignee_status
    FROM exam_assignments a
    JOIN users u ON u.id = a.assignee_user_id
    WHERE a.exam_id = ? AND a.revoked_at IS NULL
    ORDER BY lower(coalesce(u.name, u.email))
  `).all(examId);
}

export function listAssignmentsForUser(db, userId) {
  return db.prepare(`
    SELECT exam_id
    FROM exam_assignments
    WHERE assignee_user_id = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
  `).all(userId, nowIso()).map(row => row.exam_id);
}
