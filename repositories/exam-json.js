// Versioned JSON import/export for exams (Issue #7).
//
// SQLite stays the authoritative runtime store; JSON is a portable interchange
// format for backup, sharing, migration and tooling. Exports reference image
// files by their path relative to the uploads root and never embed Base64.

import crypto from "crypto";
import fs from "fs";
import { nowIso } from "../db/index.js";
import { isDataUrl, resolveImagePath } from "../db/image-store.js";
import { examExists, insertExam } from "./exams.js";
import { getQuestionsForExam, insertQuestion } from "./questions.js";
import { validateQuestion } from "./question-rules.js";

export const SCHEMA_NAME = "exam-simulator/exam";
export const SCHEMA_VERSION = 1;
export const VISIBILITIES = ["public", "private"];

export class ExamImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExamImportError";
    this.status = 400;
  }
}

const toText = value => (value === undefined || value === null ? "" : String(value));

/* ------------------------------------------------------------------ export */

export function exportExam(db, examId) {
  const exam = db
    .prepare("SELECT id, title, description, visibility, created_at FROM exams WHERE id = ? AND deleted_at IS NULL")
    .get(examId);
  if (!exam) return null;

  const questions = getQuestionsForExam(db, examId);
  const imageRows = db.prepare(`
    SELECT q.uid AS question_uid, i.uid AS uid, i.position AS position, i.storage AS storage,
           i.file_path AS file_path, i.data AS data, i.mime_type AS mime_type,
           i.byte_size AS byte_size, i.sha256 AS sha256, i.original_filename AS original_filename
    FROM question_images i
    JOIN questions q ON q.id = i.question_id
    WHERE q.exam_id = ? AND q.deleted_at IS NULL
    ORDER BY i.question_id, i.position
  `).all(examId);

  const imagesByQuestion = new Map();
  for (const row of imageRows) {
    if (!imagesByQuestion.has(row.question_uid)) imagesByQuestion.set(row.question_uid, []);
    imagesByQuestion.get(row.question_uid).push(row);
  }

  const warnings = [];
  const exportedQuestions = questions.map(question => {
    const rows = imagesByQuestion.get(question.id) || [];
    const images = rows.map(row => {
      if (row.storage === "file" && row.file_path) {
        return {
          id: row.uid,
          path: row.file_path,
          mimeType: row.mime_type,
          byteSize: row.byte_size,
          sha256: row.sha256,
          originalFilename: row.original_filename,
          position: row.position
        };
      }
      if (isDataUrl(row.data)) {
        warnings.push(`Question ${question.id}: image ${row.uid} is still inline Base64 and was omitted from the export.`);
        return { id: row.uid, position: row.position, omitted: "inline-base64" };
      }
      return { id: row.uid, reference: row.data, position: row.position };
    });

    const base = {
      id: question.id,
      text: question.text,
      type: question.type,
      explanation: question.explanation,
      images
    };

    return question.type === "dragdrop"
      ? { ...base, dragItems: question.dragItems, dropTargets: question.dropTargets }
      : { ...base, options: question.options, correct: question.correct };
  });

  return {
    document: {
      schema: SCHEMA_NAME,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      exam: {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        visibility: exam.visibility,
        questions: exportedQuestions
      }
    },
    warnings
  };
}

/* ------------------------------------------------------------------ import */

function normalizeImages(raw, label, warnings) {
  let entries;
  if (Array.isArray(raw.images)) {
    entries = raw.images;
  } else if (raw.image) {
    entries = [raw.image];
  } else {
    return [];
  }

  return entries.map((entry, index) => {
    const where = `${label}, image ${index + 1}`;

    if (typeof entry === "string") {
      if (/^\/api\/images\//.test(entry.trim())) {
        throw new ExamImportError(
          `${where}: internal image URLs cannot be imported. Use the exported "path" form.`
        );
      }
      return entry;
    }

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ExamImportError(`${where}: must be a string or an object.`);
    }

    if (entry.omitted) {
      warnings.push(`${where}: was omitted at export time and has been skipped.`);
      return null;
    }

    if (entry.path !== undefined) {
      const relativePath = toText(entry.path);
      if (!relativePath) throw new ExamImportError(`${where}: "path" must not be empty.`);
      try {
        resolveImagePath(relativePath);
      } catch {
        throw new ExamImportError(`${where}: image path "${relativePath}" is not allowed.`);
      }
      return {
        copyFrom: {
          sourcePath: relativePath,
          mimeType: entry.mimeType ? toText(entry.mimeType) : null,
          originalFilename: entry.originalFilename ? toText(entry.originalFilename) : null
        }
      };
    }

    if (entry.reference !== undefined) {
      const reference = toText(entry.reference);
      if (!reference) throw new ExamImportError(`${where}: "reference" must not be empty.`);
      return reference;
    }

    if (entry.data !== undefined) {
      return { data: toText(entry.data), name: entry.name ? toText(entry.name) : null };
    }

    throw new ExamImportError(`${where}: expected "path", "reference" or "data".`);
  }).filter(entry => entry !== null);
}

function normalizeQuestion(raw, index, examLabel, warnings) {
  const label = `${examLabel}, question ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExamImportError(`${label}: must be a JSON object.`);
  }
  if (!["single", "multiple", "dragdrop"].includes(raw.type)) {
    throw new ExamImportError(
      `${label}: unsupported type "${raw.type}". Expected single, multiple or dragdrop.`
    );
  }

  const payload = {
    text: toText(raw.text),
    type: raw.type,
    explanation: toText(raw.explanation),
    images: normalizeImages(raw, label, warnings)
  };

  if (raw.type === "dragdrop") {
    if (raw.dragItems !== undefined && !Array.isArray(raw.dragItems)) {
      throw new ExamImportError(`${label}: "dragItems" must be an array.`);
    }
    if (raw.dropTargets !== undefined && !Array.isArray(raw.dropTargets)) {
      throw new ExamImportError(`${label}: "dropTargets" must be an array.`);
    }
    payload.dragItems = (raw.dragItems || []).map((item, itemIndex) => ({
      id: toText(item?.id) || `item-${index + 1}-${itemIndex + 1}`,
      text: toText(item?.text)
    }));
    payload.dropTargets = (raw.dropTargets || []).map((target, targetIndex) => ({
      id: toText(target?.id) || `target-${index + 1}-${targetIndex + 1}`,
      label: toText(target?.label),
      correctItemId: toText(target?.correctItemId)
    }));
  } else {
    if (raw.options !== undefined && !Array.isArray(raw.options)) {
      throw new ExamImportError(`${label}: "options" must be an array.`);
    }
    if (raw.correct !== undefined && !Array.isArray(raw.correct)) {
      throw new ExamImportError(`${label}: "correct" must be an array of option indexes.`);
    }
    payload.options = (raw.options || []).map(toText);
    const correct = (raw.correct || []).map(Number);
    if (correct.some(value => !Number.isInteger(value))) {
      throw new ExamImportError(`${label}: "correct" must contain integer option indexes only.`);
    }
    payload.correct = correct;
  }

  const problem = validateQuestion(payload);
  if (problem) throw new ExamImportError(`${label}: ${problem}`);

  return { uid: toText(raw.id), payload };
}

function normalizeExam(raw, index, warnings) {
  const label = `Exam ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExamImportError(`${label}: must be a JSON object.`);
  }
  if (raw.title !== undefined && typeof raw.title !== "string") {
    throw new ExamImportError(`${label}: "title" must be a string.`);
  }
  const title = toText(raw.title).trim();
  if (!title) throw new ExamImportError(`${label}: a title is required.`);
  if (raw.questions !== undefined && !Array.isArray(raw.questions)) {
    throw new ExamImportError(`${label}: "questions" must be an array.`);
  }

  const questions = (raw.questions || []).map((question, questionIndex) =>
    normalizeQuestion(question, questionIndex, label, warnings)
  );

  return {
    id: toText(raw.id),
    title,
    description: toText(raw.description),
    exportedVisibility: VISIBILITIES.includes(raw.visibility) ? raw.visibility : null,
    questions
  };
}

/**
 * Turn any accepted payload into a list of normalised exams.
 *
 * Accepted forms:
 * - canonical export: { schema, schemaVersion, exam: {...} }
 * - a single legacy exam object: { id, title, questions: [...] }
 * - a legacy array of exam objects
 */
export function normalizePayload(payload, warnings) {
  if (Array.isArray(payload)) {
    if (!payload.length) throw new ExamImportError("The import array is empty.");
    return payload.map((exam, index) => normalizeExam(exam, index, warnings));
  }

  if (!payload || typeof payload !== "object") {
    throw new ExamImportError("The import body must be a JSON object or an array of exams.");
  }

  if (payload.schema !== undefined || payload.schemaVersion !== undefined) {
    if (payload.schema !== SCHEMA_NAME) {
      throw new ExamImportError(
        `Unsupported schema "${toText(payload.schema)}". Expected "${SCHEMA_NAME}".`
      );
    }
    if (Number(payload.schemaVersion) !== SCHEMA_VERSION) {
      throw new ExamImportError(
        `Unsupported schema version "${toText(payload.schemaVersion)}". This server supports version ${SCHEMA_VERSION}.`
      );
    }
    if (!payload.exam || typeof payload.exam !== "object" || Array.isArray(payload.exam)) {
      throw new ExamImportError('Canonical imports must contain an "exam" object.');
    }
    return [normalizeExam(payload.exam, 0, warnings)];
  }

  // Legacy shape: a bare exam object (the pre-SQLite exams.json entry format).
  return [normalizeExam(payload, 0, warnings)];
}

/**
 * Validate and import one or more exams.
 *
 * Nothing is written until every exam has been validated, and the writes run in
 * a single transaction, so malformed input can never leave partial records.
 */
export function importExams(db, payload, { ownerUserId = null, visibility = "private", logger = console } = {}) {
  if (!VISIBILITIES.includes(visibility)) {
    throw new ExamImportError(`"visibility" must be either "public" or "private".`);
  }

  const warnings = [];
  const exams = normalizePayload(payload, warnings);

  const summaries = db.transaction(() => {
    const usedExamIds = new Set();
    const results = [];

    exams.forEach((exam, examIndex) => {
      let examId = exam.id;
      let renamedExam = false;
      if (!examId || usedExamIds.has(examId) || examExists(db, examId)) {
        examId = crypto.randomUUID();
        renamedExam = Boolean(exam.id);
      }
      usedExamIds.add(examId);

      insertExam(
        db,
        { title: exam.title, description: exam.description },
        { id: examId, visibility, ownerUserId }
      );

      const usedQuestionIds = new Set();
      let imagesImported = 0;
      let imagesSkipped = 0;

      exam.questions.forEach((question, questionIndex) => {
        let uid = question.uid;
        if (!uid || usedQuestionIds.has(uid)) {
          uid = crypto.randomUUID();
          if (question.uid) {
            warnings.push(`Exam ${examIndex + 1}: duplicate question id "${question.uid}" replaced with a new id.`);
          }
        }
        usedQuestionIds.add(uid);

        const images = [];
        for (const image of question.payload.images) {
          if (image && typeof image === "object" && image.copyFrom) {
            const absolute = resolveImagePath(image.copyFrom.sourcePath);
            if (!fs.existsSync(absolute)) {
              imagesSkipped += 1;
              warnings.push(`Question ${uid}: image file "${image.copyFrom.sourcePath}" was not found and was skipped.`);
              continue;
            }
            images.push(image);
            imagesImported += 1;
            continue;
          }
          images.push(image);
        }

        insertQuestion(db, examId, { ...question.payload, images }, { uid, position: questionIndex });
      });

      results.push({
        id: examId,
        title: exam.title,
        questionCount: exam.questions.length,
        imagesImported,
        imagesSkipped,
        renamedExam,
        exportedVisibility: exam.exportedVisibility
      });
    });

    return results;
  })();

  if (warnings.length) {
    logger.warn(`[import] completed with ${warnings.length} warning(s)`);
  }

  return { exams: summaries, warnings };
}
