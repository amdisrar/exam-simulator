// Filesystem-backed storage for question images (Issue #6).
//
// Layout: uploads/exams/<exam id>/<question uid>/<image uid>.<ext>
//
// Responsibilities:
// - validate image payloads (declared type, magic bytes, size) before writing
// - write files and return paths relative to the upload root
// - delete files safely, refusing to touch anything outside the upload root
// - one-time, idempotent conversion of legacy inline Base64 rows to files
//
// Image URLs are never derived from user-supplied paths: clients address an
// image by its opaque `uid` and the server resolves it through the database.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { BACKUP_DIR, ROOT_DIR, nowIso } from "./index.js";

export const UPLOAD_ROOT = path.join(ROOT_DIR, "uploads");
export const EXAM_UPLOAD_ROOT = path.join(UPLOAD_ROOT, "exams");
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PUBLIC_IMAGE_PREFIX = "/api/images/";

const MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"]
]);

const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/x-png", "image/png"]
]);

const ALLOWED_LABEL = "PNG, JPEG, GIF or WebP";

const DATA_URL_PATTERN = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i;
const PUBLIC_IMAGE_PATTERN = /^\/api\/images\/([A-Za-z0-9-]+)$/;

export class ImageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImageValidationError";
    this.status = 400;
  }
}

export function isDataUrl(value) {
  return DATA_URL_PATTERN.test(String(value || "").trim());
}

export function parsePublicImageUrl(value) {
  const match = PUBLIC_IMAGE_PATTERN.exec(String(value || "").trim());
  return match ? match[1] : null;
}

function normalizeMime(mime) {
  const lower = String(mime || "").toLowerCase();
  return MIME_ALIASES.get(lower) || lower;
}

/** Sniff the real image type from the file signature. */
function detectImageMime(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("latin1");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Decode and validate a Base64 data URL.
 * Returns null when the value is not a data URL at all, and throws when it is
 * a data URL that is not an acceptable image.
 */
export function parseImageDataUrl(value) {
  const match = DATA_URL_PATTERN.exec(String(value || "").trim());
  if (!match) return null;

  const mime = normalizeMime(match[1]);
  if (!MIME_EXTENSIONS.has(mime)) {
    throw new ImageValidationError(`Unsupported image type "${match[1]}". Allowed types: ${ALLOWED_LABEL}.`);
  }

  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length) {
    throw new ImageValidationError("Image data is empty.");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageValidationError(
      `Image is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Maximum size is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`
    );
  }

  const detected = detectImageMime(buffer);
  if (!detected || detected !== mime) {
    throw new ImageValidationError(
      `Image content is not a valid ${mime.replace("image/", "").toUpperCase()} file. Allowed types: ${ALLOWED_LABEL}.`
    );
  }

  return { mime, buffer };
}

function sanitizeFilename(filename) {
  if (!filename) return null;
  const base = path.basename(String(filename)).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base || base === "." || base === "..") return null;
  return base.slice(0, 200);
}

/** Build the record for a brand new image without touching the filesystem. */
export function buildImageRecord(dataUrl, filename = null) {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) {
    throw new ImageValidationError("Image data must be a Base64 data URL.");
  }
  return {
    uid: crypto.randomUUID(),
    mime: parsed.mime,
    buffer: parsed.buffer,
    byteSize: parsed.buffer.length,
    sha256: crypto.createHash("sha256").update(parsed.buffer).digest("hex"),
    extension: MIME_EXTENSIONS.get(parsed.mime),
    originalFilename: sanitizeFilename(filename)
  };
}

function safeSegment(value) {
  const cleaned = String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

/** Path relative to the upload root, using forward slashes. */
export function relativeImagePath(examId, questionUid, imageUid, extension) {
  return [
    "exams",
    safeSegment(examId),
    safeSegment(questionUid),
    `${safeSegment(imageUid)}.${safeSegment(extension)}`
  ].join("/");
}

/**
 * Resolve a stored relative path to an absolute path, refusing anything that
 * escapes the upload root.
 */
export function resolveImagePath(relativePath) {
  const candidate = String(relativePath || "");
  if (!candidate) throw new Error("Empty image path");
  // Stored paths are always relative to the upload root; anything that looks
  // absolute is rejected outright rather than silently re-rooted.
  if (candidate.startsWith("/") || candidate.startsWith("\\") || /^[A-Za-z]:/.test(candidate)) {
    throw new Error("Unsafe image path");
  }
  const absolute = path.resolve(UPLOAD_ROOT, ...candidate.split("/"));
  const relative = path.relative(UPLOAD_ROOT, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe image path");
  }
  return absolute;
}

export function writeImageFile(record, { examId, questionUid }) {
  const relativePath = relativeImagePath(examId, questionUid, record.uid, record.extension);
  const absolutePath = resolveImagePath(relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, record.buffer);
  return { relativePath, absolutePath };
}

export function deleteImageFile(relativePath, { logger = console } = {}) {
  if (!relativePath) return false;
  let absolutePath;
  try {
    absolutePath = resolveImagePath(relativePath);
  } catch (error) {
    logger.warn(`[images] refused to delete unsafe path: ${relativePath}`);
    return false;
  }
  try {
    fs.unlinkSync(absolutePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    logger.warn(`[images] could not delete ${relativePath}: ${error.message}`);
    return false;
  }
}

/**
 * Delete the files behind rows that are no longer referenced by any image row.
 * Files shared by another row are left alone.
 */
export function removeUnreferencedFiles(db, rows, { logger = console } = {}) {
  if (!rows.length) return 0;
  const countReferences = db.prepare("SELECT COUNT(*) AS count FROM question_images WHERE file_path = ?");
  const seen = new Set();
  let removed = 0;
  for (const row of rows) {
    if (!row.file_path || seen.has(row.file_path)) continue;
    seen.add(row.file_path);
    if (Number(countReferences.get(row.file_path).count) > 0) continue;
    if (deleteImageFile(row.file_path, { logger })) removed += 1;
  }
  return removed;
}

function backupDatabase(db, { logger = console } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `exam-simulator-${stamp}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  logger.log(`[images] database snapshot written to ${path.relative(ROOT_DIR, target).split(path.sep).join("/")}`);
  return target;
}

/**
 * Convert legacy inline Base64 images into files on disk.
 *
 * Idempotent: only rows with storage = 'inline' that actually hold a data URL
 * are considered, so a second run is a no-op. A database snapshot is taken
 * before the first conversion, and the legacy payload is only cleared once the
 * file has been written inside the same transaction.
 */
export function migrateInlineImages(db, { logger = console } = {}) {
  const rows = db.prepare(`
    SELECT i.id, i.data, i.uid, i.question_id,
           q.uid AS question_uid, e.id AS exam_id
    FROM question_images i
    JOIN questions q ON q.id = i.question_id
    JOIN exams e ON e.id = q.exam_id
    WHERE i.storage = 'inline' AND i.data IS NOT NULL AND i.data <> ''
    ORDER BY i.question_id, i.position
  `).all();

  if (!rows.length) return { migrated: 0, skipped: 0, backup: null };

  const convertible = rows.filter(row => isDataUrl(row.data));
  if (!convertible.length) {
    return { migrated: 0, skipped: rows.length, backup: null };
  }

  const backup = backupDatabase(db, { logger });
  const update = db.prepare(`
    UPDATE question_images
    SET storage = 'file', data = NULL, file_path = ?, mime_type = ?,
        byte_size = ?, sha256 = ?
    WHERE id = ?
  `);

  let migrated = 0;
  const skipped = [];

  const run = db.transaction(() => {
    for (const row of convertible) {
      let record;
      try {
        record = buildImageRecord(row.data);
      } catch (error) {
        skipped.push({ id: row.id, reason: error.message });
        continue;
      }
      const { relativePath } = writeImageFile(record, {
        examId: row.exam_id,
        questionUid: row.question_uid
      });
      update.run(relativePath, record.mime, record.byteSize, record.sha256, row.id);
      migrated += 1;
    }
  });

  run();

  if (migrated > 0) {
    logger.log(`[images] moved ${migrated} inline image(s) to ${path.relative(ROOT_DIR, EXAM_UPLOAD_ROOT).split(path.sep).join("/")}/`);
  }
  for (const item of skipped) {
    logger.warn(`[images] image ${item.id} left inline: ${item.reason}`);
  }

  return { migrated, skipped: skipped.length, backup };
}
