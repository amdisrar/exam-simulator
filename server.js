import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { initializeStorage } from "./db/bootstrap.js";
import { ROOT_DIR } from "./db/index.js";
import { describeAuthState, loadAuthConfig } from "./auth/config.js";
import { createAuthRequest, exchangeCodeForTokens, profileFromClaims, verifyIdToken } from "./auth/google.js";
import { attachUser, authEnforced, requireAdmin, requireAuth } from "./auth/middleware.js";
import { createSession, deleteSession, parseCookies, serializeCookie } from "./auth/sessions.js";
import { countActiveAdmins, listUsers, toPublicUser, updateUserAccess, upsertGoogleUser } from "./auth/users.js";
import { resolveImagePath } from "./db/image-store.js";
import { createExam, examExists, getExamById, listExams } from "./repositories/exams.js";
import { exportExam, importExams } from "./repositories/exam-json.js";
import { validateQuestion } from "./repositories/question-rules.js";
import {
  createQuestion,
  deleteQuestion,
  findImageByUid,
  findQuestionRow,
  updateQuestion
} from "./repositories/questions.js";

// Load a local .env when present so a plain `node server.js` behaves the same
// as `npm start`. Variables already present in the environment always win.
try {
  process.loadEnvFile(path.join(ROOT_DIR, ".env"));
} catch {
  // No .env file: use the process environment as-is.
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { db, path: DB_PATH, importResult } = initializeStorage();

const authConfig = loadAuthConfig();
let authState;
try {
  authState = describeAuthState(authConfig);
} catch (error) {
  console.error(`[auth] ${error.message}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

function fileSlug(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "exam";
}

function parseQuestionPayload(body) {
  const text = String(body.text || "").trim();
  const type = ["multiple", "dragdrop"].includes(body.type) ? body.type : "single";

  // Images arrive either as a plain string (an existing image URL, a Base64
  // data URL, or a legacy external reference) or as { data, name } when the
  // editor knows the original filename. They are persisted as files, so the
  // Base64 payload never reaches the database.
  const imageInputs = Array.isArray(body.images)
    ? body.images
    : String(body.image || "")
      ? [body.image]
      : [];

  const images = imageInputs
    .map(image => {
      if (image && typeof image === "object") {
        return { data: String(image.data || ""), name: image.name ? String(image.name) : null };
      }
      return { data: String(image || ""), name: null };
    })
    .filter(image => image.data);

  const base = {
    text,
    type,
    explanation: String(body.explanation || "").trim(),
    images
  };

  if (type === "dragdrop") {
    const dragItems = Array.isArray(body.dragItems)
      ? body.dragItems
          .map(item => ({
            id: String(item?.id || crypto.randomUUID()),
            text: String(item?.text || "").trim()
          }))
          .filter(item => item.text)
      : [];

    const validIds = new Set(dragItems.map(item => item.id));

    const dropTargets = Array.isArray(body.dropTargets)
      ? body.dropTargets
          .map(target => ({
            id: String(target?.id || crypto.randomUUID()),
            label: String(target?.label || "").trim(),
            correctItemId: String(target?.correctItemId || "")
          }))
          .filter(target => target.label || target.correctItemId)
      : [];

    return {
      ...base,
      dragItems,
      dropTargets: dropTargets.map(target => ({
        ...target,
        correctItemId: validIds.has(target.correctItemId) ? target.correctItemId : target.correctItemId
      }))
    };
  }

  const options = Array.isArray(body.options)
    ? body.options.map(x => String(x).trim()).filter(Boolean)
    : [];
  const correct = Array.isArray(body.correct)
    ? body.correct.map(Number).filter(Number.isInteger)
    : [];

  return {
    ...base,
    options,
    correct
  };
}

app.use(attachUser(db, authConfig));

const OAUTH_TX_COOKIE = "exam_oauth_tx";

function callbackUrl(req) {
  if (authConfig.baseUrl) return `${authConfig.baseUrl}/auth/google/callback`;
  return `${req.protocol}://${req.get("host")}/auth/google/callback`;
}

function transactionCookie(value, maxAge) {
  return serializeCookie(OAUTH_TX_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: authConfig.isProduction,
    path: "/",
    maxAge
  });
}

function sessionCookie(value, maxAge) {
  return serializeCookie(authConfig.cookieName, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: authConfig.isProduction,
    path: "/",
    maxAge
  });
}

function escapeHtmlText(value) {
  return String(value ?? "").replace(/[<>&"]/g, character =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[character]));
}

function authErrorPage(message, details = null) {
  // The reason is only shown when not running in production, so a
  // misconfiguration is diagnosable locally without leaking internals.
  const detailBlock = details && !authConfig.isProduction
    ? `<p class="muted small">Reason (shown outside production):</p>
<pre class="error-detail">${escapeHtmlText(details)}</pre>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><main class="shell"><div class="card auth-card">
<h2>Sign-in failed</h2>
<p class="muted">${escapeHtmlText(message)}</p>
${detailBlock}
<p><a class="auth-button" href="/auth/google">Try again</a></p>
</div></main></body></html>`;
}

app.get("/api/me", (req, res) => {
  res.json({ authEnabled: authEnforced(authConfig), user: req.user });
});

app.get("/auth/google", (req, res) => {
  if (!authConfig.configured) {
    return res.status(503).json({ error: "Google authentication is not configured" });
  }
  const { url, transaction } = createAuthRequest({ config: authConfig, redirectUri: callbackUrl(req) });
  res.setHeader("Set-Cookie", transactionCookie(JSON.stringify(transaction), 600));
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const clearTransaction = transactionCookie("", 0);

  if (!authConfig.configured) {
    return res.status(503).json({ error: "Google authentication is not configured" });
  }

  try {
    let transaction = null;
    try {
      const cookies = parseCookies(req.headers.cookie);
      transaction = cookies[OAUTH_TX_COOKIE] ? JSON.parse(cookies[OAUTH_TX_COOKIE]) : null;
    } catch {
      transaction = null;
    }

    const fail = message => {
      res.setHeader("Set-Cookie", clearTransaction);
      return res.status(400).send(authErrorPage(message));
    };

    if (req.query.error) {
      return fail(`Google returned an error: ${String(req.query.error)}.`);
    }
    // The state parameter is compared against the value we stored before the
    // redirect, which is what protects the callback against CSRF.
    if (!transaction || !req.query.state || req.query.state !== transaction.state) {
      return fail("This sign-in link is no longer valid. Please start again.");
    }
    if (!req.query.code) {
      return fail("Google did not return an authorization code.");
    }

    const tokens = await exchangeCodeForTokens({
      code: String(req.query.code),
      verifier: transaction.verifier,
      redirectUri: callbackUrl(req),
      config: authConfig
    });

    const claims = await verifyIdToken(tokens.id_token, {
      clientId: authConfig.clientId,
      nonce: transaction.nonce
    });
    const profile = profileFromClaims(claims);

    if (!profile.emailVerified) {
      return fail("Your Google account email address is not verified.");
    }

    const { user, blocked } = upsertGoogleUser(db, profile, {
      initialAdminEmail: authConfig.initialAdminEmail
    });

    if (blocked) {
      res.setHeader("Set-Cookie", clearTransaction);
      return res.status(403).send(authErrorPage("This account has been disabled. Please contact an administrator."));
    }

    const { token } = createSession(db, user.id, {
      ttlDays: authConfig.sessionTtlDays,
      userAgent: req.get("user-agent") || null,
      ipAddress: req.ip || null
    });

    res.setHeader("Set-Cookie", [
      sessionCookie(token, authConfig.sessionTtlDays * 24 * 60 * 60),
      clearTransaction
    ]);
    res.redirect("/");
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message;
    const details = `${error.message}${cause ? ` [${cause}]` : ""}`;
    console.error(`[auth] sign-in failed: ${details}`);
    res.setHeader("Set-Cookie", clearTransaction);
    res.status(400).send(
      authErrorPage("We could not complete the Google sign-in. Please try again.", details)
    );
  }
});

app.post("/auth/logout", (req, res) => {
  if (req.sessionToken) deleteSession(db, req.sessionToken);
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.status(204).end();
});

// Everything below requires an authenticated user once Google is configured.
app.use("/api", requireAuth(authConfig));

// ---------------------------------------------------------------- admin users

app.get("/api/admin/users", requireAdmin(authConfig), (req, res) => {
  const search = req.query.search === undefined ? "" : String(req.query.search);
  res.json({
    users: listUsers(db, { search }).map(toPublicUser),
    activeAdmins: countActiveAdmins(db)
  });
});

app.patch("/api/admin/users/:id", requireAdmin(authConfig), (req, res) => {
  const body = req.body || {};
  const role = body.role === undefined ? undefined : String(body.role);
  const status = body.status === undefined ? undefined : String(body.status);

  const user = updateUserAccess(db, req.params.id, { role, status });
  res.json({ user: toPublicUser(user), activeAdmins: countActiveAdmins(db) });
});

app.get("/api/exams", (_req, res) => {
  res.json(listExams(db));
});

app.get("/api/exams/:id", (req, res) => {
  const exam = getExamById(db, req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found" });
  res.json(exam);
});

app.get("/api/exams/:id/export", (req, res) => {
  const result = exportExam(db, req.params.id);
  if (!result) return res.status(404).json({ error: "Exam not found" });

  for (const warning of result.warnings) console.warn(`[export] ${warning}`);

  const filename = `${fileSlug(result.document.exam.title)}.exam.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.json(result.document);
});

app.post("/api/exams/import", (req, res) => {
  const body = req.body;
  // The importing user explicitly chooses visibility; otherwise imports stay
  // private. A visibility recorded inside the payload is only informational.
  const requested = body && !Array.isArray(body) ? body.visibility : undefined;
  const visibility = requested === undefined ? "private" : String(requested);
  const ownerUserId = req.user ? req.user.id : null;

  const result = importExams(db, body, { ownerUserId, visibility });
  res.status(201).json(result);
});

app.post("/api/exams", (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Title is required" });

  const exam = createExam(db, {
    title,
    description: String(req.body.description || "").trim()
  });

  res.status(201).json(exam);
});

app.post("/api/exams/:id/questions", (req, res) => {
  if (!examExists(db, req.params.id)) {
    return res.status(404).json({ error: "Exam not found" });
  }

  const payload = parseQuestionPayload(req.body);
  const validationError = validateQuestion(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  res.status(201).json(createQuestion(db, req.params.id, payload));
});

app.put("/api/exams/:examId/questions/:questionId", (req, res) => {
  if (!examExists(db, req.params.examId)) {
    return res.status(404).json({ error: "Exam not found" });
  }

  if (!findQuestionRow(db, req.params.examId, req.params.questionId)) {
    return res.status(404).json({ error: "Question not found" });
  }

  const payload = parseQuestionPayload(req.body);
  const validationError = validateQuestion(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  const updatedQuestion = updateQuestion(db, req.params.examId, req.params.questionId, payload);
  if (!updatedQuestion) return res.status(404).json({ error: "Question not found" });

  res.json(updatedQuestion);
});

app.delete("/api/exams/:examId/questions/:questionId", (req, res) => {
  if (!examExists(db, req.params.examId)) {
    return res.status(404).json({ error: "Exam not found" });
  }

  if (!deleteQuestion(db, req.params.examId, req.params.questionId)) {
    return res.status(404).json({ error: "Question not found" });
  }

  res.status(204).end();
});

app.get("/api/images/:uid", (req, res) => {
  const image = findImageByUid(db, req.params.uid);
  // Only filesystem-backed records are served here; inline legacy values are
  // returned directly inside the question payload.
  if (!image || image.storage !== "file" || !image.file_path) {
    return res.status(404).json({ error: "Image not found" });
  }

  let absolutePath;
  try {
    // The path comes from our own database and is re-validated against the
    // upload root, so a crafted URL can never escape it.
    absolutePath = resolveImagePath(image.file_path);
  } catch {
    return res.status(404).json({ error: "Image not found" });
  }

  res.type(image.mime_type || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(absolutePath, error => {
    if (error && !res.headersSent) res.status(404).json({ error: "Image not found" });
  });
});

app.use((error, _req, res, _next) => {
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Exam Simulator running at http://localhost:${PORT}`);
  console.log(`Storage: SQLite (${DB_PATH}) [${importResult.status}${importResult.reason ? `: ${importResult.reason}` : ""}]`);
  if (authState === "disabled") {
    console.warn("[auth] Google authentication is NOT configured - running WITHOUT authentication.");
    console.warn("[auth] Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable sign-in.");
  } else {
    console.log(`Auth: Google sign-in enabled${authConfig.initialAdminEmail ? ` (bootstrap admin: ${authConfig.initialAdminEmail})` : ""}`);
  }
});
