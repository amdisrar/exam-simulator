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
│   └── bootstrap.js        # storage initialization
├── repositories/
│   ├── exams.js            # exam data access
│   └── questions.js        # question data access
├── scripts/
│   └── db-migrate.js       # npm run db:migrate
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
3. imports `data/exams.json` if it has not been imported yet.

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
