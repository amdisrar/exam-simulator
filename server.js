import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { initializeStorage } from "./db/bootstrap.js";
import { createExam, examExists, getExamById, listExams } from "./repositories/exams.js";
import {
  createQuestion,
  deleteQuestion,
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

function parseQuestionPayload(body) {
  const text = String(body.text || "").trim();
  const type = ["multiple", "dragdrop"].includes(body.type) ? body.type : "single";

  const images = Array.isArray(body.images)
    ? body.images.map(image => String(image || "")).filter(Boolean)
    : String(body.image || "")
      ? [String(body.image)]
      : [];

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

function validateQuestion(question) {
  if (!question.text) return "Question text is required";

  if (question.type === "dragdrop") {
    if (question.dragItems.length < 2) return "At least two draggable items are required";
    if (!question.dropTargets.length) return "At least one drop target is required";

    const itemIds = question.dragItems.map(item => item.id);
    const itemIdSet = new Set(itemIds);
    if (itemIdSet.size !== itemIds.length) return "Draggable item IDs must be unique";

    const targetIds = question.dropTargets.map(target => target.id);
    if (new Set(targetIds).size !== targetIds.length) return "Drop target IDs must be unique";

    if (question.dropTargets.some(target => !target.label)) {
      return "Every drop target needs a label";
    }

    if (question.dropTargets.some(target => !itemIdSet.has(target.correctItemId))) {
      return "Every drop target must reference a valid correct draggable item";
    }

    const correctIds = question.dropTargets.map(target => target.correctItemId);
    if (new Set(correctIds).size !== correctIds.length) {
      return "A draggable item can only be the correct answer for one drop target";
    }

    return null;
  }

  if (question.options.length < 2) return "At least two options are required";
  if (!question.correct.length) return "At least one correct answer is required";

  if (question.type === "single" && question.correct.length !== 1) {
    return "Single-answer questions need exactly one correct answer";
  }

  if (question.correct.some(i => i < 0 || i >= question.options.length)) {
    return "Correct answer index is invalid";
  }

  return null;
}

app.get("/api/exams", (_req, res) => {
  res.json(listExams(db));
});

app.get("/api/exams/:id", (req, res) => {
  const exam = getExamById(db, req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found" });
  res.json(exam);
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

app.listen(PORT, () => {
  console.log(`Exam Simulator running at http://localhost:${PORT}`);
  console.log(`Storage: SQLite (${DB_PATH}) [${importResult.status}${importResult.reason ? `: ${importResult.reason}` : ""}]`);
});
