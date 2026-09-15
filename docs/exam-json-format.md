# Exam JSON interchange format

JSON is the portable interchange format for exams. SQLite remains the
authoritative runtime store; JSON is used for backup, sharing, migration and
tooling.

- **Export:** `GET /api/exams/:id/export` returns the document below (as a
  download).
- **Import:** `POST /api/exams/import` accepts this document, a single legacy
  exam object, or an array of legacy exam objects.

## Schema version 1

```json
{
  "schema": "exam-simulator/exam",
  "schemaVersion": 1,
  "exportedAt": "2026-09-15T18:00:00.000Z",
  "exam": {
    "id": "be92cde9-ce5d-4f19-b44e-36db972bcb58",
    "title": "Fortinet NSE4",
    "description": "",
    "visibility": "private",
    "questions": [
      {
        "id": "3453952e-bbb1-438d-85e3-c0648a102f77",
        "text": "Which protocol secures web traffic?",
        "type": "single",
        "explanation": "HTTPS uses TLS.",
        "images": [
          {
            "id": "1a970b77-3f30-47ee-b094-502fceef3dc0",
            "path": "exams/be92cde9-.../6381c133-.../1a970b77-....jpg",
            "mimeType": "image/jpeg",
            "byteSize": 74505,
            "sha256": "…",
            "originalFilename": "diagram.jpg",
            "position": 0
          }
        ],
        "options": ["HTTP", "HTTPS", "FTP"],
        "correct": [1]
      }
    ]
  }
}
```

### Question types

`single` and `multiple` use `options` (array of strings) and `correct` (array of
zero-based option indexes). `single` must have exactly one correct index.

`dragdrop` uses `dragItems` and `dropTargets` instead:

```json
{
  "type": "dragdrop",
  "dragItems": [{ "id": "item-a", "text": "Alpha" }],
  "dropTargets": [{ "id": "target-1", "label": "First", "correctItemId": "item-a" }]
}
```

### Images

Exports **never embed Base64**. Each image is either:

- `{ "path": … }` — a file stored under `uploads/`, referenced relative to that
  root. On import the file is copied into the new question's own directory, so
  the imported exam owns its images. If the file is missing, the image is
  skipped and reported in `warnings`.
- `{ "reference": … }` — an external reference (for example a remote URL or a
  bare filename) that is stored verbatim.
- `{ "omitted": "inline-base64" }` — an unconverted legacy payload that cannot be
  represented in JSON. This should not occur after the image migration.

### Import behaviour

- The whole import is validated before anything is written, and all writes run in
  a single transaction: malformed input never leaves partial records.
- Unsupported `schema` or `schemaVersion` values are rejected with a clear error.
- Imported exams are **private** by default. Pass a top-level `"visibility":
  "public"` to override. The `visibility` recorded inside the payload is
  informational only.
- If the exam `id` already exists, a new id is generated and reported via
  `renamedExam`; question ids, drag item ids and target mappings are preserved so
  internal relationships stay intact.
- Question ids that are missing or duplicated within the payload are replaced
  and reported in `warnings`.
- Legacy Base64 images (the pre-SQLite `exams.json` format) are accepted and
  written to the filesystem, never stored in SQLite.

### Import response

```json
{
  "exams": [
    {
      "id": "…",
      "title": "Fortinet NSE4",
      "questionCount": 91,
      "imagesImported": 64,
      "imagesSkipped": 0,
      "renamedExam": false,
      "exportedVisibility": "private"
    }
  ],
  "warnings": []
}
```

## Legacy compatibility

The pre-SQLite `exams.json` question structure is still accepted for import:

```json
{
  "id": "network-basics",
  "title": "Network Basics",
  "description": "…",
  "questions": [
    { "id": "q1", "text": "…", "type": "single", "options": ["a", "b"], "correct": [0], "image": "" }
  ]
}
```

A bare object imports one exam; an array imports each element. Both are wrapped
in a single transaction.
