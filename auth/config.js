// Authentication configuration, read from the environment.
//
// No secrets are ever hard-coded and nothing here is exposed to the browser.

export function loadAuthConfig(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
  const isProduction = env.NODE_ENV === "production";

  const ttlDays = Number(env.SESSION_TTL_DAYS);
  const sessionTtlDays = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30;

  return {
    clientId,
    clientSecret,
    initialAdminEmail: String(env.INITIAL_ADMIN_EMAIL || "").trim().toLowerCase(),
    baseUrl: String(env.APP_BASE_URL || "").trim().replace(/\/+$/, ""),
    isProduction,
    sessionTtlDays,
    cookieName: String(env.SESSION_COOKIE_NAME || "exam_session"),
    configured: Boolean(clientId && clientSecret)
  };
}

/**
 * Authentication is enforced only when Google is configured. Running without
 * it is a development affordance and is refused in production.
 */
export function describeAuthState(config) {
  if (config.configured) return "google";
  if (config.isProduction) {
    throw new Error(
      "Google authentication is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before running in production."
    );
  }
  return "disabled";
}
