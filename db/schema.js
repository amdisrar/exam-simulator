// Database schema definition.
//
// The schema is expressed as an ordered list of migrations. Each entry is
// applied exactly once and is tracked through `PRAGMA user_version` plus the
// `schema_migrations` table (see ./migrations.js).
//
// Design notes (Issue #5):
// - `exams.id` keeps the original stable identifier from exams.json (TEXT).
// - `questions` uses an internal INTEGER key plus a per-exam stable `uid`,
//   because legacy question ids ("q1") are only unique inside one exam.
//   The HTTP API still exposes `uid` as `id`, so client behaviour is unchanged.
// - Question answers/drag data are normalised just enough to stay relational,
//   but the original ordering is preserved with `position` columns so the
//   reconstructed JSON is byte-equivalent in meaning to the legacy shape.
// - Soft-delete columns exist for future phases (#13 Trash) but are not yet
//   used: the current DELETE route keeps hard-deleting to preserve behaviour.

import crypto from "crypto";

export const QUESTION_TYPES = ["single", "multiple", "dragdrop"];
export const EXAM_VISIBILITIES = ["public", "private"];
export const IMAGE_STORAGE_MODES = ["inline", "file"];

export const MIGRATIONS = [
  {
    version: 1,
    name: "initial-schema",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        -- Future phase 5/6: identity. Internal id is stable and independent of
        -- the Google subject identifier.
        CREATE TABLE IF NOT EXISTS users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          google_sub    TEXT UNIQUE,
          email         TEXT,
          name          TEXT,
          picture_url   TEXT,
          role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
          is_active     INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          last_login_at TEXT,
          deleted_at    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

        CREATE TABLE IF NOT EXISTS exams (
          id                 TEXT PRIMARY KEY,
          title              TEXT NOT NULL,
          description        TEXT NOT NULL DEFAULT '',
          owner_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
          visibility         TEXT NOT NULL DEFAULT 'public'
                               CHECK (visibility IN ('public', 'private')),
          sort_order         INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          deleted_at         TEXT,
          deleted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          purge_after        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_exams_owner ON exams(owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_exams_visibility ON exams(visibility);
        CREATE INDEX IF NOT EXISTS idx_exams_deleted ON exams(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_exams_sort ON exams(sort_order);

        CREATE TABLE IF NOT EXISTS questions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          exam_id     TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
          uid         TEXT NOT NULL,
          position    INTEGER NOT NULL DEFAULT 0,
          text        TEXT NOT NULL DEFAULT '',
          type        TEXT NOT NULL CHECK (type IN ('single', 'multiple', 'dragdrop')),
          explanation TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          deleted_at  TEXT,
          UNIQUE (exam_id, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id, position);
        CREATE INDEX IF NOT EXISTS idx_questions_deleted ON questions(deleted_at);

        -- Options for single/multiple answer questions. is_correct keeps the
        -- multi-answer set without an extra join table.
        CREATE TABLE IF NOT EXISTS question_options (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
          position    INTEGER NOT NULL,
          text        TEXT NOT NULL,
          is_correct  INTEGER NOT NULL DEFAULT 0,
          UNIQUE (question_id, position)
        );
        CREATE INDEX IF NOT EXISTS idx_question_options_question
          ON question_options(question_id);

        -- Drag & drop: draggable items belong to a question and keep their
        -- legacy client-generated ids as the item uid.
        CREATE TABLE IF NOT EXISTS drag_items (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
          uid         TEXT NOT NULL,
          position    INTEGER NOT NULL,
          text        TEXT NOT NULL,
          UNIQUE (question_id, uid),
          UNIQUE (question_id, position)
        );
        CREATE INDEX IF NOT EXISTS idx_drag_items_question ON drag_items(question_id);

        -- Drop targets map to a draggable item inside the same question. The
        -- composite foreign key keeps correct_item_uid referentially valid.
        CREATE TABLE IF NOT EXISTS drop_targets (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          question_id      INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
          uid              TEXT NOT NULL,
          position         INTEGER NOT NULL,
          label            TEXT NOT NULL,
          correct_item_uid TEXT,
          UNIQUE (question_id, uid),
          UNIQUE (question_id, position),
          FOREIGN KEY (question_id, correct_item_uid)
            REFERENCES drag_items(question_id, uid) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_drop_targets_question ON drop_targets(question_id);

        -- Images stay inline for Issue #5. storage and file_path let Issue #6
        -- move payloads to the filesystem without another schema change.
        CREATE TABLE IF NOT EXISTS question_images (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
          position    INTEGER NOT NULL,
          storage     TEXT NOT NULL DEFAULT 'inline'
                        CHECK (storage IN ('inline', 'file')),
          data        TEXT,
          file_path   TEXT,
          mime_type   TEXT,
          created_at  TEXT NOT NULL,
          UNIQUE (question_id, position)
        );
        CREATE INDEX IF NOT EXISTS idx_question_images_question
          ON question_images(question_id);

        CREATE TABLE IF NOT EXISTS exam_assignments (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          exam_id             TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
          assignee_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assigned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          permission          TEXT NOT NULL DEFAULT 'view'
                                CHECK (permission IN ('view', 'edit')),
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          expires_at          TEXT,
          revoked_at          TEXT,
          UNIQUE (exam_id, assignee_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_exam_assignments_exam
          ON exam_assignments(exam_id);
        CREATE INDEX IF NOT EXISTS idx_exam_assignments_assignee
          ON exam_assignments(assignee_user_id);
        CREATE INDEX IF NOT EXISTS idx_exam_assignments_active
          ON exam_assignments(revoked_at, expires_at);

        CREATE TABLE IF NOT EXISTS api_tokens (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name         TEXT NOT NULL DEFAULT '',
          token_prefix TEXT NOT NULL DEFAULT '',
          token_hash   TEXT NOT NULL UNIQUE,
          scopes       TEXT NOT NULL DEFAULT '',
          created_at   TEXT NOT NULL,
          last_used_at TEXT,
          expires_at   TEXT,
          revoked_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_api_tokens_active
          ON api_tokens(revoked_at, expires_at);

        CREATE TABLE IF NOT EXISTS audit_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          actor_type    TEXT NOT NULL DEFAULT 'system'
                          CHECK (actor_type IN ('user', 'api_token', 'system')),
          action        TEXT NOT NULL,
          entity_type   TEXT NOT NULL,
          entity_id     TEXT,
          exam_id       TEXT,
          details       TEXT,
          ip_address    TEXT,
          user_agent    TEXT,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_log_exam ON audit_log(exam_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_log_entity
          ON audit_log(entity_type, entity_id, created_at);

        -- Small key/value store for migration markers (JSON import status).
        CREATE TABLE IF NOT EXISTS app_meta (
          key        TEXT PRIMARY KEY,
          value      TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    // Issue #6: question images move out of the database and onto the
    // filesystem. `data` keeps holding a payload only for rows that are still
    // inline (legacy file references that are not Base64, or rows awaiting the
    // one-time conversion in db/image-store.js). New images are always written
    // as files and referenced by `file_path`, and are addressed publicly by
    // `uid` so no filesystem path is ever exposed to clients.
    version: 2,
    name: "question-images-filesystem",
    up(db) {
      db.exec(`
        ALTER TABLE question_images ADD COLUMN uid TEXT;
        ALTER TABLE question_images ADD COLUMN original_filename TEXT;
        ALTER TABLE question_images ADD COLUMN byte_size INTEGER;
        ALTER TABLE question_images ADD COLUMN sha256 TEXT;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_question_images_uid
          ON question_images(uid);
        CREATE INDEX IF NOT EXISTS idx_question_images_file_path
          ON question_images(file_path);
      `);

      // Every existing image needs a stable public id before it can be served.
      const rows = db.prepare("SELECT id FROM question_images WHERE uid IS NULL").all();
      const assignUid = db.prepare("UPDATE question_images SET uid = ? WHERE id = ?");
      for (const row of rows) {
        assignUid.run(crypto.randomUUID(), row.id);
      }
    }
  },
  {
    // Issue #8: local user accounts and server-side sessions.
    //
    // The users table is rebuilt to line up with the vocabulary used by the
    // authentication and administration issues: role is 'normal' or 'admin',
    // and status is 'active' or 'disabled' (replacing the is_active flag).
    // The table is empty when this runs, so no account data is at risk.
    version: 3,
    name: "auth-users-and-sessions",
    foreignKeysOff: true,
    up(db) {
      db.exec(`
        CREATE TABLE users_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          google_sub    TEXT UNIQUE,
          email         TEXT,
          name          TEXT,
          picture_url   TEXT,
          role          TEXT NOT NULL DEFAULT 'normal' CHECK (role IN ('normal', 'admin')),
          status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          last_login_at TEXT,
          deleted_at    TEXT
        );

        INSERT INTO users_new
          (id, google_sub, email, name, picture_url, role, status, created_at, updated_at, last_login_at, deleted_at)
        SELECT id, google_sub, email, name, picture_url,
               CASE WHEN role = 'admin' THEN 'admin' ELSE 'normal' END,
               CASE WHEN is_active = 1 THEN 'active' ELSE 'disabled' END,
               created_at, updated_at, last_login_at, deleted_at
        FROM users;

        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;

        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

        -- Server-side sessions. Only a hash of the cookie value is stored.
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash   TEXT PRIMARY KEY,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at   TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at   TEXT NOT NULL,
          user_agent   TEXT,
          ip_address   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      `);
    }
  }
];
