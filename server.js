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

app.use(express.json({ limit: "10mb" }));
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

  const text = String(req.body.text || "").trim();
  const type = req.body.type === "multiple" ? "multiple" : "single";
  const options = Array.isArray(req.body.options)
    ? req.body.options.map(x => String(x).trim()).filter(Boolean)
    : [];
  const correct = Array.isArray(req.body.correct)
    ? req.body.correct.map(Number).filter(Number.isInteger)
    : [];

  if (!text) return res.status(400).json({ error: "Question text is required" });
  if (options.length < 2) return res.status(400).json({ error: "At least two options are required" });
  if (!correct.length) return res.status(400).json({ error: "At least one correct answer is required" });
  if (type === "single" && correct.length !== 1) {
    return res.status(400).json({ error: "Single-answer questions need exactly one correct answer" });
  }
  if (correct.some(i => i < 0 || i >= options.length)) {
    return res.status(400).json({ error: "Correct answer index is invalid" });
  }

  const question = {
    id: crypto.randomUUID(),
    text,
    type,
    options,
    correct,
    explanation: String(req.body.explanation || "").trim(),
    image: String(req.body.image || "")
  };
  exam.questions.push(question);
  await writeExams(exams);
  res.status(201).json(question);
});

app.delete("/api/exams/:examId/questions/:questionId", async (req, res) => {
  const exams = await readExams();
  const exam = exams.find(e => e.id === req.params.examId);
  if (!exam) return res.status(404).json({ error: "Exam not found" });

  exam.questions = exam.questions.filter(q => q.id !== req.params.questionId);
  await writeExams(exams);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Exam Simulator running at http://localhost:${PORT}`);
});
