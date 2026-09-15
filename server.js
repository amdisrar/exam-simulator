import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { initializeStorage } from "./db/bootstrap.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { db, path: DB_PATH, importResult } = initializeStorage();

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
});
