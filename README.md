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
login. Configuration lives in a `.env` file next to `package.json`:

```bash
cp .env.example .env    # then fill in your Google credentials
npm start
```

`.env` is git-ignored; only the empty `.env.example` template is committed.
Values already present in the real environment take precedence over the file.

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials (required to enable sign-in) |
| `INITIAL_ADMIN_EMAIL` | First account with this email becomes admin while no admin exists |
| `APP_BASE_URL` | Public base URL used for the OAuth redirect |
| `SESSION_TTL_DAYS` / `SESSION_COOKIE_NAME` | Session tuning (default 30 days / `exam_session`) |

In the Google Cloud console create an OAuth client of type **Web application**
and add the redirect URI `<APP_BASE_URL>/auth/google/callback`, for example
`http://localhost:3000/auth/google/callback`. It must match exactly. Google only
accepts plain HTTP for `localhost`/`127.0.0.1`; anything else needs HTTPS. No
"authorised JavaScript origin" is required — sign-in is a server-side redirect,
not a popup.

Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` the server runs with
authentication **disabled** and logs a warning, so local development keeps
working; with `NODE_ENV=production` it refuses to start instead. Once
configured, every `/api/*` route except `/api/me` requires a signed-in user.

See [`docs/auth.md`](docs/auth.md) for the full flow, session handling and
security notes.

## Authorization

Exams have an owner and a visibility (`private` by default). A signed-in user can
reach an exam when it is public, they own it, or it has been assigned to them;
only the owner or an admin can edit it or change its visibility. Admins can
manage every exam.

Authorization is centralised in `auth/authorization.js` and enforced server-side
on every exam, question, image and export route — hidden UI controls are never
the protection. Requests for an exam the caller may not view return **404** so
private ids are not confirmed, while an exam they may view but not modify returns
**403**.

See [`docs/authorization.md`](docs/authorization.md) for the rule table, the
route matrix and the pre-authentication exam handling.

Exams can also be **shared** with specific people: an owner (or an admin) grants
another active user view/take access to a private exam without making it public
or transferring ownership. Recipients can take the exam but never edit it,
change its visibility, or re-share it. Shares are revoked, not deleted, and
re-sharing the same person restores their access.

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
