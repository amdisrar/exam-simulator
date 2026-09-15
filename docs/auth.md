# Authentication

The Exam Simulator uses **Google OpenID Connect** for sign-in and provisions a
local account on first successful login. There are no passwords and no Google
tokens are stored.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | OAuth client id from the Google Cloud console |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret — **never commit this** |
| `INITIAL_ADMIN_EMAIL` | no | Address that receives the `admin` role while the instance has no active admin |
| `APP_BASE_URL` | no | Public base URL, used to build the OAuth redirect (e.g. `https://exams.example.com`) |
| `SESSION_TTL_DAYS` | no | Session lifetime in days (default `30`) |
| `SESSION_COOKIE_NAME` | no | Session cookie name (default `exam_session`) |
| `NODE_ENV` | no | `production` enables `Secure` cookies and refuses to start unauthenticated |

Add `https://<your-host>/auth/google/callback` to the authorised redirect URIs
of the Google OAuth client.

### Running without credentials

When Google is not configured the server starts with authentication
**disabled** and logs a loud warning. This keeps local development usable. With
`NODE_ENV=production` the server refuses to start instead, so a misconfigured
deployment cannot serve the application unprotected.

## Flow

1. `GET /auth/google` creates a `state`, `nonce` and PKCE verifier, stores them
   in a short-lived `HttpOnly` transaction cookie and redirects to Google.
2. Google returns the user to `GET /auth/google/callback`.
3. The callback verifies `state`, exchanges the code, then verifies the
   `id_token` with Google's published RS256 signing keys: signature, issuer,
   audience, expiry and nonce.
4. The local account is created or refreshed, and a session is issued.

## Local accounts

- Identified internally by an auto-increment `users.id`; the Google subject is
  stored separately, so the internal id never depends on Google.
- New accounts get role `normal` and status `active`.
- Name, avatar and `last_login_at` are refreshed on every login. Role and
  status are **never** derived from Google attributes.
- Disabled accounts are refused even when Google authentication succeeds, and
  any existing session stops working immediately.
- `INITIAL_ADMIN_EMAIL` promotes that address to `admin` only while the instance
  has no active admin at all. Role management afterwards happens in the
  application, not through Google.

## Sessions

- A random 32-byte token lives in an `HttpOnly`, `SameSite=Lax` cookie, marked
  `Secure` in production.
- Only the SHA-256 hash of the token is stored in the `sessions` table, so a
  database leak does not yield usable sessions.
- Sessions expire after `SESSION_TTL_DAYS` and slide forward on use.
- `POST /auth/logout` deletes the session and clears the cookie.

## Protected routes

Once Google is configured, every `/api/*` route except `/api/me` requires a
session and returns `401` otherwise. Authorization is always enforced
server-side; hiding UI elements is never treated as protection.

## Administration

Users with role `admin` get an **Admin · Users** page in the application and the
matching API:

- `GET /api/admin/users` — list accounts (optional `?search=` by name or email)
- `PATCH /api/admin/users/:id` — change `role` (`normal`/`admin`) and/or `status`
  (`active`/`disabled`)

Rules enforced on the server:

- Normal users receive `403` from both endpoints.
- The **last active administrator** cannot be demoted or disabled (`409`).
- Unknown users return `404`; invalid role/status values and empty changes
  return `400`.
- Changes apply to existing sessions immediately, because the user record is
  read on every request.
- Disabling a user deletes their sessions.
- User records are never physically deleted in this phase.

When authentication is not configured (development only) the API is open, as it
is for the rest of the application. In `NODE_ENV=production` the server refuses
to start without credentials, so this cannot happen in a real deployment.
