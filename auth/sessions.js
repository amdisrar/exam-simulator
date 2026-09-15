// Server-side sessions (Issue #8).
//
// The browser only ever holds an opaque random token in an HttpOnly cookie.
// The database stores a SHA-256 hash of that token, so a database leak does not
// hand out usable sessions.

import crypto from "crypto";
import { nowIso } from "../db/index.js";

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createSession(db, userId, { ttlDays = 30, userAgent = null, ipAddress = null } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(hashToken(token), userId, new Date(now).toISOString(), new Date(now).toISOString(), expiresAt, userAgent, ipAddress);

  return { token, expiresAt };
}

/**
 * Resolve a session token to its user.
 *
 * Returns null when the session is unknown, expired, or belongs to an account
 * that is no longer active — so disabling a user immediately ends their access.
 */
export function findSessionUser(db, token, { ttlDays = 30 } = {}) {
  if (!token) return null;

  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.picture_url, u.role, u.status, u.created_at, u.last_login_at,
           s.expires_at AS session_expires_at, s.last_seen_at AS session_last_seen_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));

  if (!row) return null;

  if (new Date(row.session_expires_at).getTime() <= Date.now()) {
    deleteSession(db, token);
    return null;
  }
  if (row.status !== "active") return null;

  const lastSeen = new Date(row.session_last_seen_at).getTime();
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > TOUCH_INTERVAL_MS) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(
      nowIso(),
      new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
      hashToken(token)
    );
  }

  return row;
}

export function deleteSession(db, token) {
  if (!token) return false;
  return db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token)).changes > 0;
}

export function deleteSessionsForUser(db, userId) {
  return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes;
}

export function deleteExpiredSessions(db) {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso()).changes;
}

/* ------------------------------------------------------------- cookie utils */

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  return parts.join("; ");
}
