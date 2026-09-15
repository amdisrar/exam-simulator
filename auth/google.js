// Google OpenID Connect login (Issue #8).
//
// Implemented directly against Google's endpoints with node:crypto so no extra
// dependency is required. The authorization code flow uses PKCE, and the
// returned id_token is verified against Google's published signing keys before
// any claim is trusted.
//
// Google access tokens and refresh tokens are never persisted: only the claims
// needed to provision the local account are read, and the token response is
// discarded.

import crypto from "crypto";
import { fetchWithRetry } from "./http.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const JWKS_TTL_MS = 60 * 60 * 1000;
// Clock skew tolerated when validating id_token timestamps. Virtual machines
// (WSL in particular, after a suspend/resume) can drift by minutes, and a
// too-tight window rejects otherwise valid tokens.
const CLOCK_SKEW_SECONDS = 300;

let jwksCache = { keys: null, fetchedAt: 0 };

const base64url = value => Buffer.from(value).toString("base64url");

export function resetJwksCache() {
  jwksCache = { keys: null, fetchedAt: 0 };
}

/** Build the authorization redirect and the transaction values to remember. */
export function createAuthRequest({ config, redirectUri }) {
  const state = base64url(crypto.randomBytes(24));
  const nonce = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");

  return { url: url.toString(), transaction: { state, nonce, verifier } };
}

export async function exchangeCodeForTokens({ code, verifier, redirectUri, config, fetchImpl = fetchWithRetry }) {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier
  });

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  // Google reports OAuth failures as a structured body alongside a 4xx status
  // (invalid_grant, invalid_client, redirect_uri_mismatch, ...). Prefer that
  // detail over the bare status code so the reason is actually visible.
  if (data && data.error) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error}`);
  }
  if (!response.ok || !data) {
    throw new Error(`Google token exchange failed (HTTP ${response.status})`);
  }
  if (!data.id_token) {
    throw new Error("Google token response did not include an id_token");
  }

  return data;
}

async function getSigningKeys(fetchImpl) {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;

  const response = await fetchImpl(JWKS_URI);
  if (!response.ok) throw new Error(`Could not fetch Google signing keys (HTTP ${response.status})`);

  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error("Unexpected signing key response from Google");

  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

function decodeJsonSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Verify a Google id_token: signature, issuer, audience, expiry and nonce.
 * Only after all checks pass are the claims returned.
 */
export async function verifyIdToken(idToken, { clientId, nonce, fetchImpl = fetchWithRetry }) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");

  const header = decodeJsonSegment(parts[0]);
  if (header.alg !== "RS256") throw new Error(`Unsupported id_token algorithm "${header.alg}"`);

  let keys = await getSigningKeys(fetchImpl);
  let jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) {
    // The key may have rotated since we cached it.
    resetJwksCache();
    keys = await getSigningKeys(fetchImpl);
    jwk = keys.find(key => key.kid === header.kid);
  }
  if (!jwk) throw new Error("No matching Google signing key for id_token");

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signatureValid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], "base64url")
  );
  if (!signatureValid) throw new Error("id_token signature verification failed");

  const claims = decodeJsonSegment(parts[1]);
  const now = Math.floor(Date.now() / 1000);

  if (!ISSUERS.has(claims.iss)) throw new Error("Unexpected id_token issuer");
  if (claims.aud !== clientId) throw new Error("id_token was issued for a different application");
  if (typeof claims.exp !== "number" || claims.exp <= now - CLOCK_SKEW_SECONDS) {
    throw new Error("id_token has expired");
  }
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) {
    throw new Error(
      `id_token was issued in the future (this server's clock is about ${claims.iat - now}s behind; check time synchronisation)`
    );
  }
  if (!claims.sub) throw new Error("id_token is missing a subject");
  if (nonce && claims.nonce !== nonce) throw new Error("id_token nonce mismatch");

  return claims;
}

export function profileFromClaims(claims) {
  return {
    sub: String(claims.sub || ""),
    email: String(claims.email || ""),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: String(claims.name || ""),
    picture: String(claims.picture || "")
  };
}
