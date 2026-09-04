import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, "data", "exams.json");

const app = express();
const PORT = process.env.PORT || 3000;

// Multiple base64 images can make a question payload larger than before.
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function readExams() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeExams(exams) {
  await fs.writeFile(DATA_FILE, JSON.stringify(exams, null, 2), "utf8");
}

function parseQuestionPayload(body) {
  const text = String(body.text || "").trim();
  const type = body.type === "multiple" ? "multiple" : "single";
  const options = Array.isArray(body.options)
    ? body.options.map(x => String(x).trim()).filter(Boolean)
    : [];
  const correct = Array.isArray(body.correct)
    ? body.correct.map(Number).filter(Number.isInteger)
    : [];

  const images = Array.isArray(body.images)
    ? body.images.map(image => String(image || "")).filter(Boolean)
    : String(body.image || "")
      ? [String(body.image)]
      : [];

  return {
    text,
    type,
    options,
    correct,
    explanation: String(body.explanation || "").trim(),
    images
  };
}

function validateQuestion(question) {
  if (!question.text) return "Question text is required";
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

app.get("/api/exams", async (_req, res) => {
  const exams = await readExams();
  res.json(exams.map(e => ({
    id: e.id,
    title: e.title,
    description: e.description || "",
    questionCount: e.questions?.length || 0
  })));
});

app.get("/api/exams/:id", async (req, res) => {
  const exams = await readExams();
  const exam = exams.find(e => e.id === req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found" });
  res.json(exam);
});

app.post("/api/exams", async (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Title is required" });

  const exams = await readExams();
  const exam = {
    id: crypto.randomUUID(),
    title,
    description: String(req.body.description || "").trim(),
    questions: []
  };

  exams.push(exam);
  await writeExams(exams);
  res.status(201).json(exam);
});

app.post("/api/exams/:id/questions", async (req, res) => {
  const exams = await readExams();
  const exam = exams.find(e => e.id === req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found" });

  const payload = parseQuestionPayload(req.body);
  const validationError = validateQuestion(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  const question = {
    id: crypto.randomUUID(),
    ...payload
  };

  exam.questions.push(question);
  await writeExams(exams);
  res.status(201).json(question);
});

app.put("/api/exams/:examId/questions/:questionId", async (req, res) => {
  const exams = await readExams();
  const exam = exams.find(e => e.id === req.params.examId);
  if (!exam) return res.status(404).json({ error: "Exam not found" });

  const questionIndex = exam.questions.findIndex(q => q.id === req.params.questionId);
  if (questionIndex === -1) {
    return res.status(404).json({ error: "Question not found" });
  }

  const payload = parseQuestionPayload(req.body);
  const validationError = validateQuestion(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  const updatedQuestion = {
    ...exam.questions[questionIndex],
    ...payload,
    id: exam.questions[questionIndex].id
  };

  // The new `images` field replaces the old single-image representation.
  delete updatedQuestion.image;

  exam.questions[questionIndex] = updatedQuestion;
  await writeExams(exams);
  res.json(updatedQuestion);
});

app.delete("/api/exams/:examId/questions/:questionId", async (req, res) => {
  const exams = await readExams();
  const exam = exams.find(e => e.id === req.params.examId);
  if (!exam) return res.status(404).json({ error: "Exam not found" });

  const exists = exam.questions.some(q => q.id === req.params.questionId);
  if (!exists) return res.status(404).json({ error: "Question not found" });

  exam.questions = exam.questions.filter(q => q.id !== req.params.questionId);
  await writeExams(exams);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Exam Simulator running at http://localhost:${PORT}`);
});
