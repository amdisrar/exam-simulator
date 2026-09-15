// Express middleware for authentication and authorization (Issue #8).
//
// Server-side checks only: hiding UI controls is never treated as protection.

import { findSessionUser, parseCookies } from "./sessions.js";
import { toPublicUser } from "./users.js";

/** True when requests must carry an authenticated session. */
export function authEnforced(config) {
  return Boolean(config.configured);
}

/** Resolve the session cookie into `req.user` (or null). Never rejects. */
export function attachUser(db, config) {
  return (req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.cookieName] || null;

    req.sessionToken = token;
    req.user = null;

    if (token) {
      const row = findSessionUser(db, token, { ttlDays: config.sessionTtlDays });
      if (row) req.user = toPublicUser(row);
    }

    next();
  };
}

export function requireAuth(config) {
  return (req, res, next) => {
    if (!authEnforced(config)) return next();
    if (req.user) return next();
    res.status(401).json({ error: "Authentication required" });
  };
}

export function requireAdmin(config) {
  return (req, res, next) => {
    if (!authEnforced(config)) return next();
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Administrator access required" });
    }
    next();
  };
}
