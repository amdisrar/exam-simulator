// Centralized exam authorization (Issues #10 + #11).
//
// Every protected operation funnels through these predicates so the REST API
// (#16) and MCP server (#17) can reuse exactly the same rules instead of
// re-implementing checks per route.
//
// Model:
//   canView = admin | public | owner | assigned | unowned(legacy)
//   canEdit = admin | owner
//
// A note on status codes: an exam the caller may not *view* is reported as 404
// so private ids are not confirmed, while an exam they may view but not
// *modify* is reported as 403.

import { nowIso } from "../db/index.js";

export const ACCESS_ADMIN = "admin";
export const ACCESS_OWNER = "owner";
export const ACCESS_ASSIGNED = "assigned";
export const ACCESS_PUBLIC = "public";

export function isAdmin(user) {
  return Boolean(user && user.role === "admin");
}

/**
 * Where authorization is not enforced (Google not configured, development
 * only) there is no user, and every check passes so the app stays usable.
 * Production refuses to start without credentials, so this cannot ship.
 */
function unrestricted(user) {
  return !user || isAdmin(user);
}

export function hasActiveAssignment(db, examId, userId) {
  if (!userId || !examId) return false;
  const row = db.prepare(`
    SELECT 1 AS present
    FROM exam_assignments
    WHERE exam_id = ? AND assignee_user_id = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1
  `).get(examId, userId, nowIso());
  return Boolean(row);
}

/**
 * Describe how `user` reaches `exam`, or null when they cannot.
 * `exam` is an app-shaped record: { id, ownerUserId, visibility }.
 */
export function examAccess(db, exam, user) {
  if (!exam) return null;
  if (unrestricted(user)) return ACCESS_ADMIN;
  if (exam.ownerUserId != null && exam.ownerUserId === user.id) return ACCESS_OWNER;
  // Pre-authentication exams are system-owned and readable by everyone; the
  // first admin claims them on bootstrap (see claimLegacyExams).
  if (exam.ownerUserId == null) return ACCESS_PUBLIC;
  if (exam.visibility === "public") return ACCESS_PUBLIC;
  if (hasActiveAssignment(db, exam.id, user.id)) return ACCESS_ASSIGNED;
  return null;
}

export function canViewExam(db, exam, user) {
  return examAccess(db, exam, user) !== null;
}

export function canEditExam(db, exam, user) {
  if (!exam) return false;
  if (unrestricted(user)) return true;
  return exam.ownerUserId != null && exam.ownerUserId === user.id;
}

export function canAssignExam(db, exam, user) {
  // Assignment management itself arrives in #12; the rule is defined here so it
  // is not duplicated later.
  return canEditExam(db, exam, user);
}

/**
 * SQL fragment restricting an exam query to what `user` may view.
 * Returned as a parameterised fragment so callers never build SQL by hand.
 */
export function examAccessFilter(user) {
  if (unrestricted(user)) return { sql: "1 = 1", params: [] };
  return {
    sql: `(
      e.owner_user_id IS NULL
      OR e.visibility = 'public'
      OR e.owner_user_id = ?
      OR EXISTS (
        SELECT 1 FROM exam_assignments a
        WHERE a.exam_id = e.id
          AND a.assignee_user_id = ?
          AND a.revoked_at IS NULL
          AND (a.expires_at IS NULL OR a.expires_at > ?)
      )
    )`,
    params: [user.id, user.id, nowIso()]
  };
}

/**
 * Middleware: resolve the exam named by `req.params[paramName]` and require the
 * given access level. Attaches `req.exam`, `req.examAccess` and `req.canEdit`.
 */
export function requireExamAccess(db, config, level = "view", paramName = "id") {
  const enforced = Boolean(config && config.configured);

  return (req, res, next) => {
    const examId = req.params[paramName];
    const exam = findExamAccessRow(db, examId);

    if (!enforced) {
      // Development without Google configured: no checks, but still resolve the
      // exam so downstream handlers behave consistently.
      if (!exam) return res.status(404).json({ error: "Exam not found" });
      req.exam = exam;
      req.examAccess = ACCESS_ADMIN;
      req.canEdit = true;
      return next();
    }

    if (!exam) return res.status(404).json({ error: "Exam not found" });

    const access = examAccess(db, exam, req.user);
    if (access === null) {
      // Never confirm the existence of an exam the caller cannot view.
      return res.status(404).json({ error: "Exam not found" });
    }

    const editable = canEditExam(db, exam, req.user);
    if (level === "edit" && !editable) {
      return res.status(403).json({ error: "You do not have permission to modify this exam" });
    }

    req.exam = exam;
    req.examAccess = access;
    req.canEdit = editable;
    next();
  };
}

/** Minimal exam record used for authorization decisions. */
export function findExamAccessRow(db, id) {
  const row = db
    .prepare("SELECT id, title, owner_user_id, visibility FROM exams WHERE id = ? AND deleted_at IS NULL")
    .get(id);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility
  };
}
