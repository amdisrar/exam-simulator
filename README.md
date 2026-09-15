# Exam Simulator

A simple, lightweight, persistent exam simulator built with Node.js, Express, HTML, CSS, and vanilla JavaScript.

The application supports multiple exams, randomized question selection, shuffled questions and answers, single-answer and multiple-answer questions, images, answer review, and a simple question editor.

## Features

- Multiple exams
- Persistent exam storage using SQLite
- Single-answer questions
- Multiple-answer questions
- Optional question images
- Random question selection
- Shuffle questions
- Shuffle answers
- Answer choices displayed as A, B, C, D, etc.
- Show / Hide Answers
- Correct answers highlighted in green
- Incorrect selected answers highlighted in red
- Correct-answer details and explanations
- Final exam scoring
- Create new exams
- Add questions through the web interface
- Delete questions
- Responsive web interface
- Local, file-based database (no database server required)

## Technology Stack

- Node.js
- Express
- better-sqlite3 (SQLite, WAL mode)
- HTML5
- CSS3
- Vanilla JavaScript

## Project Structure

```text
exam-simulator/
├── data/
│   ├── exams.json          # legacy JSON source (imported once, no longer authoritative)
│   ├── exam-simulator.db   # runtime database (local only, git-ignored)
│   └── backups/            # timestamped JSON backups (git-ignored)
├── db/
│   ├── index.js            # connection + pragmas (WAL, foreign keys)
│   ├── schema.js           # schema definition / migrations
│   ├── migrations.js       # versioned migration runner
│   ├── json-import.js      # one-way, idempotent JSON -> SQLite import
│   ├── image-store.js      # image validation + filesystem storage
│   └── bootstrap.js        # storage initialization
├── repositories/
│   ├── exams.js            # exam data access
│   ├── questions.js        # question data access
│   ├── question-rules.js   # shared question validation rules
│   └── exam-json.js        # versioned JSON import/export
├── scripts/
│   └── db-migrate.js       # npm run db:migrate
├── docs/
│   └── exam-json-format.md # JSON interchange schema
├── uploads/                # question image files (git-ignored)
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server.js
├── package.json
├── README.md
└── .gitignore
```

## Storage & migration

SQLite (`data/exam-simulator.db`) is the authoritative runtime store. `data/exams.json` is
kept only as the one-time import source; it is never modified or deleted by the application.

On startup the application:

1. opens `data/exam-simulator.db`, enables WAL mode and foreign keys;
2. applies any pending, versioned schema migrations (safe to run repeatedly);
3. imports `data/exams.json` if it has not been imported yet;
4. moves any remaining inline Base64 image rows onto the filesystem.

### Question images

Image files live outside the database under `uploads/exams/<exam>/<question>/<image id>.<ext>`.
SQLite stores only metadata: the public image id, the relative path, MIME type, byte size,
checksum, original filename and display order.

- The editor sends images as data URLs; the server validates the declared type against the
  file's magic bytes, enforces an 8 MB per-image limit, and writes a file. Base64 never
  reaches the database.
- Images are served through `GET /api/images/<id>`. The id is an opaque UUID and the path is
  resolved from the database, so no client-supplied value ever reaches the filesystem.
- Removing an image in the editor deletes its file only when no other record references it,
  and soft-deleting an exam never removes files from disk.
- Databases created before this change are converted automatically on first start, after a
  snapshot of the database is written to `data/backups/`.

If images are stored elsewhere (for example a mounted volume), keep the `uploads/` directory
next to `data/` so backups capture both.

### JSON import and export

JSON remains the portable interchange format for backup, sharing and tooling while SQLite
stays authoritative.

- `GET /api/exams/:id/export` returns a versioned document (`schemaVersion: 1`) containing the
  exam, all questions, correct-answer definitions, drag/drop mappings, explanations and image
  references with metadata. It **never embeds Base64**; images are referenced by their path
  relative to `uploads/`.
- `POST /api/exams/import` accepts that document, a single legacy exam object, or an array of
  them. Everything is validated before anything is written and all writes happen in one
  transaction, so malformed input cannot leave partial records.
- Imported exams default to **private**; pass a top-level `"visibility": "public"` to override.
- A colliding exam id is replaced with a new one while question ids, drag item ids and target
  mappings are preserved.

The full schema is documented in [`docs/exam-json-format.md`](docs/exam-json-format.md).

## Authentication

Sign-in uses Google OpenID Connect, with a local account provisioned on first
login. Configure it with:

```bash
export GOOGLE_CLIENT_ID="…"
export GOOGLE_CLIENT_SECRET="…"
export INITIAL_ADMIN_EMAIL="you@example.com"   # optional bootstrap admin
export APP_BASE_URL="https://exams.example.com" # optional, used for the redirect
```

Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` the server runs with
authentication **disabled** and logs a warning, so local development keeps
working; with `NODE_ENV=production` it refuses to start instead. Once
configured, every `/api/*` route except `/api/me` requires a signed-in user.

See [`docs/auth.md`](docs/auth.md) for the full flow, session handling and
security notes.

The import is idempotent. It is keyed on a hash of the source file and only inserts exam ids
that do not already exist, so restarting never duplicates records and a newly copied
`exams.json` contributes only its new exams. A timestamped backup is written to
`data/backups/` before any import runs, and a failed import is rolled back with the JSON left
intact.

Run the migration explicitly with:

```bash
npm run db:migrate
```

To rebuild from the JSON source, stop the app, remove `data/exam-simulator.db*`, and start
again.

## License

This project is intended for personal, educational, and training use. Licensed under the MIT License, see the [LICENSE](LICENSE) file for details.
