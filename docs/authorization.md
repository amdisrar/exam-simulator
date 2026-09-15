# Authorization

Issues #10 and #11 are implemented as one model: **who may reach an exam** and
**how an exam's ownership and visibility are recorded** are two halves of the
same rule, so they share a single implementation in `auth/authorization.js`.

## The rules

```
canView(exam, user) = user is admin
                   OR exam.ownerUserId == user.id
                   OR exam.ownerUserId is NULL          (pre-authentication exam)
                   OR exam.visibility == 'public'
                   OR an active assignment exists for (exam, user)

canEdit(exam, user)  = user is admin OR exam.ownerUserId == user.id
canAssign(exam, user)= canEdit(exam, user)                  (used by #12)
```

| Relationship | Can view | Can edit | Can change visibility | Can assign |
|---|---|---|---|---|
| Admin | any exam | any exam | any exam | any exam |
| Owner | own exam | own exam | own exam | own exam |
| Assigned recipient | that exam | ✗ | ✗ | ✗ |
| Unrelated user | public exams only | ✗ | ✗ | ✗ |

Assignment grants **view/take only**. `exam_assignments.permission` exists but is
always written as `view`; edit is deliberately not grantable.

## Status codes

- **401** — no authenticated session (enforced by `requireAuth`).
- **404** — the caller may not *view* the exam, or it does not exist. These are
  deliberately indistinguishable so private exam ids cannot be confirmed.
- **403** — the caller may view the exam but may not modify it.

## Where it is enforced

`requireExamAccess(db, authConfig, level, paramName)` resolves
`req.params[paramName]`, applies the rule, and attaches `req.exam`,
`req.examAccess` and `req.canEdit`. It guards:

| Route | Level |
|---|---|
| `GET /api/exams` | filtered in SQL (`examAccessFilter`), never post-filtered |
| `GET /api/exams/:id` | view |
| `GET /api/exams/:id/export` | **edit** — a full dump including every correct answer, so it stays a management operation rather than part of "view and take" |
| `PATCH /api/exams/:id` (visibility) | edit |
| `POST /api/exams/:id/questions` | edit |
| `PUT/DELETE /api/exams/:examId/questions/:questionId` | edit |
| `GET /api/images/:uid` | view, resolved through the image's owning exam |

Exam list and detail responses carry additive `visibility`, `access`
(`owner`/`assigned`/`public`/`admin`) and `canEdit` fields so the client can
show badges and hide controls. Hidden controls are a convenience only — the
server is the enforcement point.

## Ownership and visibility behaviour

- New exams default to **private** and their owner is the authenticated creator.
  A client-supplied `ownerUserId` is ignored, and ownership can never be changed
  through the API.
- The owner (or an admin) may switch visibility. Any other field is rejected.
- `GET /api/exams` for a normal user returns public, owned and assigned exams
  only. Admins see everything.
- "Public" means visible to any **authenticated, active** user; there is still no
  anonymous access.

### Pre-authentication exams

Exams created before authentication have no owner. `claimLegacyExams()` hands
them to the first admin exactly once, recorded under the `legacy_exam_claim` key
in `app_meta`, so a later admin never re-claims exams someone has since taken
responsibility for. Until then they are readable by everyone.

## Development without authentication

When `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are not configured, all
authorization checks pass so the application stays usable locally. This cannot
reach a real deployment: with `NODE_ENV=production` the server refuses to start
without credentials.

## Reuse

The predicates (`examAccess`, `canViewExam`, `canEditExam`, `canAssignExam`) and
the SQL helper (`examAccessFilter`) are pure functions with no HTTP coupling, so
the planned REST API (#16) and MCP server (#17) can call the same rules rather
than reimplementing them.

## Sharing an exam (#12)

An owner (or an admin) can grant another active user access to a private exam
without transferring ownership or making it public.

| Endpoint | Who | Behaviour |
|---|---|---|
| `GET /api/exams/:id/assignments` | owner / admin | Active shares with the recipient's display details |
| `POST /api/exams/:id/assignments` | owner / admin | Body `{ userId }` or `{ email }` |
| `DELETE /api/exams/:id/assignments/:assignmentId` | owner / admin | Revokes the share |
| `GET /api/assignable-users?search=` | any signed-in user | Share candidates |

Rules enforced server-side:

- Sharing requires **owner or admin** — the same `requireExamAccess(..., "edit")`
  guard as editing, so a recipient cannot re-share and an unrelated user gets
  **404**.
- A share grants **view/take only**. `permission` is always stored as `view`, and
  recipients get **403** on question writes, visibility changes and every
  assignment endpoint.
- **Disabled, deleted and unknown accounts** are refused with the same `404`, so
  the endpoint cannot be used to probe account status. Only active accounts are
  offerable.
- **Self-assignment** is rejected (`400`); duplicates return `409` rather than
  creating a second row — `(exam_id, assignee_user_id)` is unique in the schema.
- **Revoking is a soft revoke** (`revoked_at`), preserving the record of who
  shared what, and re-sharing revives that row instead of duplicating it. Access
  ends on the very next request unless the exam is public, owned, or the caller
  is an admin.
- Because the recipient's access flows through the central `examAccess`
  predicate, removing the assignment removes it from their list, detail,
  questions, images and export at once.

### Directory lookup is deliberately minimised

`GET /api/assignable-users` exists because an owner has to find a colleague to
share with, but it is intentionally narrow:

- a search term of at least **2 characters** is required, so the directory cannot
  be paged through or dumped;
- the caller, disabled accounts and deleted accounts are excluded;
- results are capped and contain **only** `id`, `name`, `email` and `pictureUrl`
  — never roles, status or timestamps.

Sharing is also possible by exact email address, for deployments that would
rather not expose a search endpoint at all.

## Deliberately out of scope

Exam soft-delete and restore endpoints live in #13 (the schema fields already
exist). Ownership transfer is a future feature. The assignment model carries
`expires_at` for time-limited shares, but nothing sets it yet.
