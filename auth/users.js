// Local user accounts and Google account provisioning (Issue #8).

import { nowIso } from "../db/index.js";

export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || "",
    name: row.name || "",
    pictureUrl: row.picture_url || "",
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  };
}

export function findUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

export function findUserByGoogleSub(db, sub) {
  if (!sub) return null;
  return db.prepare("SELECT * FROM users WHERE google_sub = ?").get(sub) || null;
}

export function findUserByEmail(db, email) {
  if (!email) return null;
  return db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email) || null;
}

export function countActiveAdmins(db) {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL")
    .get();
  return Number(row.count);
}

export function listUsers(db, { search = "" } = {}) {
  const term = String(search || "").trim();
  if (term) {
    const like = `%${term}%`;
    return db.prepare(`
      SELECT * FROM users
      WHERE deleted_at IS NULL AND (name LIKE ? OR email LIKE ?)
      ORDER BY role = 'admin' DESC, lower(coalesce(name, email)) ASC, id ASC
    `).all(like, like);
  }
  return db.prepare(`
    SELECT * FROM users
    WHERE deleted_at IS NULL
    ORDER BY role = 'admin' DESC, lower(coalesce(name, email)) ASC, id ASC
  `).all();
}

/**
 * Create or refresh the local account for a verified Google identity.
 *
 * - Matches on the Google subject first, then adopts a pre-provisioned account
 *   with the same verified email address.
 * - A disabled account is returned untouched with `blocked: true` so the caller
 *   can refuse the login without recording it.
 * - Local role and status are never derived from Google attributes; the only
 *   automatic promotion is the one-time bootstrap administrator.
 */
export function upsertGoogleUser(db, profile, { initialAdminEmail = "", logger = console } = {}) {
  const now = nowIso();
  const email = String(profile.email || "").trim();
  const name = String(profile.name || "").trim();
  const picture = String(profile.picture || "").trim();
  const sub = String(profile.sub || "").trim();

  let row = findUserByGoogleSub(db, sub);

  if (!row && email && profile.emailVerified) {
    const byEmail = findUserByEmail(db, email);
    if (byEmail && !byEmail.google_sub) row = byEmail;
  }

  if (row && (row.status !== "active" || row.deleted_at)) {
    return { user: row, created: false, blocked: true };
  }

  let created = false;
  let bootstrapped = false;

  const run = db.transaction(() => {
    if (!row) {
      const info = db.prepare(`
        INSERT INTO users (google_sub, email, name, picture_url, role, status, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, 'normal', 'active', ?, ?, ?)
      `).run(sub || null, email || null, name || null, picture || null, now, now, now);
      row = findUserById(db, Number(info.lastInsertRowid));
      created = true;
    } else {
      db.prepare(`
        UPDATE users
        SET google_sub = COALESCE(?, google_sub),
            email = COALESCE(?, email),
            name = ?,
            picture_url = ?,
            updated_at = ?,
            last_login_at = ?
        WHERE id = ?
      `).run(sub || null, email || null, name || null, picture || null, now, now, row.id);
      row = findUserById(db, row.id);
    }

    // Bootstrap administrator: only while the instance has no active admin at
    // all, and only for the configured address.
    if (
      initialAdminEmail &&
      email &&
      email.toLowerCase() === initialAdminEmail &&
      row.role !== "admin" &&
      countActiveAdmins(db) === 0
    ) {
      db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?").run(now, row.id);
      row = findUserById(db, row.id);
      bootstrapped = true;
      logger.log(`[auth] granted the bootstrap admin role to user ${row.id}`);
    }
  });

  run();

  return { user: row, created, blocked: false, bootstrapped };
}
