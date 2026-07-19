# Fonos Audiobook Backend

Demo Node.js + Express backend for user-generated audiobooks in the Android emulator flow.

## What it does

- Verifies Firebase ID tokens from Android.
- Creates and updates trusted Firestore `books/{bookId}` and
  `books/{bookId}/chapters/{chapterId}` documents while deriving ownership
  from the verified token.
- Supports creator draft editing, follow-up chapter drafts, chapter deletion or
  cancellation, publication, and Public/Private visibility toggles.
- Queues one in-process AWS Polly generation job at a time.
- Starts Amazon Polly Long-form tasks that write one MP3 directly to S3, then
  polls task status and writes the returned `audioUrl` back to Firestore.
- Sends best-effort FCM data notifications when generation reaches
  `ready_for_review` or `failed`.
- Owns book-level review and saved-library mutations, maintaining
  `ratingSum`, `ratingAverage`, `ratingCount`, and `saveCount` transactionally.
- Lists comment-bearing reviews with cursor pagination while returning the
  caller's review separately so rating-only submissions remain editable.
- Indexes complete published chapter `sourceText` with Gemini embeddings and
  serves DeepSeek-generated grounded summaries and Q&amp;A with backend-owned citations.

Generated books remain `published=false` until the creator publishes
ready-for-review audio from Android My Uploads. Published user-generated books
can later be hidden with `hiddenByCreator=true` without deleting their My
Uploads record.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Fill `.env` with your Firebase project ID, Firebase Admin service-account path,
AWS profile, S3 bucket, backend-only `GEMINI_API_KEY` for embeddings, and
backend-only `DEEPSEEK_API_KEY` for answer generation. The defaults use
`deepseek-v4-flash` in non-thinking mode, `gemini-embedding-2`, and
768-dimensional embeddings. Do not commit `.env`, service account JSON files,
AI provider keys, or AWS keys.

The server listens on `0.0.0.0:8080` by default. Port `5555` is reserved by the
Android Emulator/ADB and can cause connections to close without an HTTP response.
Android Emulator should call:

```text
http://10.0.2.2:8080
```

## Required Firebase/AWS configuration

Firebase Admin uses Application Default Credentials from `GOOGLE_APPLICATION_CREDENTIALS` and derives `creatorUid` from the verified ID token. The backend ignores client-supplied identity fields.

Android stores FCM registration tokens under
`users/{uid}/notificationTokens/{sha256Token}`. Firestore rules must allow
authenticated users to write/delete only their own token documents. The backend
uses Firebase Admin Messaging to send data-only, high-priority generation
status messages and removes invalid or unregistered tokens.

AWS uses the normal SDK credential chain; for local demo use `AWS_PROFILE=default` or another local profile.

Required AWS actions for the backend identity:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "polly:StartSpeechSynthesisTask",
        "polly:GetSpeechSynthesisTask"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::BUCKET_NAME/audiobooks/*"
    }
  ]
}
```

For the demo bucket, make only `audiobooks/*` public-read with a bucket policy like:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGeneratedAudio",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::BUCKET_NAME/audiobooks/*"
    }
  ]
}
```

The S3 bucket must be in `us-east-1`. Polly writes directly under
`audiobooks/{creatorUid}/{bookId}/{chapterId}/`; the backend never downloads or
manually uploads an MP3. Public playback depends on the bucket policy above.

## API

All `/api/v1/*` endpoints require Firebase authentication:

```text
Authorization: Bearer <Firebase ID token>
```

Endpoints with JSON request bodies also require:

```text
Content-Type: application/json
```

### Community reviews and saved books

| Method | Endpoint | Behavior |
|---|---|---|
| `GET` | `/api/v1/audiobooks/{bookId}/reviews?limit=10&cursor=...` | Lists written reviews newest-first and returns `viewerReview`, `nextCursor`, and `hasMore`. |
| `PUT` | `/api/v1/audiobooks/{bookId}/reviews/me` | Creates or replaces the caller's review from `{ "rating": 1..5, "comment": string|null }`. |
| `DELETE` | `/api/v1/audiobooks/{bookId}/reviews/me` | Hard-deletes the caller's review idempotently. |
| `PUT` | `/api/v1/users/me/saved-books/{bookId}` | Adds saved membership idempotently and increments `saveCount` once. |
| `DELETE` | `/api/v1/users/me/saved-books/{bookId}` | Removes saved membership idempotently and decrements `saveCount` once. |

Only published, visible books accept community operations, and creators cannot
review their own uploads. Reviewer display names are read from `users/{uid}` by
the backend and stored as submission-time snapshots; client-supplied identity
or aggregate fields are ignored.

### AI summaries and book Q&amp;A

`POST /api/v1/audiobooks/{bookId}/ai/responses` accepts a summary or question:

```json
{
  "mode": "question",
  "scope": { "type": "chapter", "chapterId": "chapter_2" },
  "question": "Why did the character leave home?",
  "locale": "auto",
  "history": [
    { "role": "user", "text": "Who is the main character?" },
    { "role": "assistant", "text": "..." }
  ]
}
```

Use `{ "mode": "summary", "scope": { "type": "book" }, "locale": "en" }`
for a whole-book summary. Questions are limited to 1,000 characters and history
to 12 user/assistant messages. The backend retrieves eight chunks for Q&amp;A;
whole-book summaries instead summarize every published chapter and synthesize
those summaries in order. Responses include the active content version and
short excerpts copied from validated indexed chunks.

Only signed-in users may query published, visible, AI-ready books. Drafts,
creator previews, hidden books, and unknown chapters are rejected. Expected AI
errors are `409 ai_not_ready`, `429 ai_rate_limit_exceeded`, and
`503 ai_provider_unavailable`. Per-UID defaults are 10 requests per minute and
100 per day; configure them with `AI_RATE_LIMIT_PER_MINUTE` and
`AI_DAILY_LIMIT` for the demo.

Provider calls use one bounded retry, a 30-second end-to-end response deadline,
and separate in-process circuits for embeddings and answer generation. A 503
includes `Retry-After`; clients should preserve the pending question and wait
that many seconds before retrying.

Reviews are stored at `books/{bookId}/reviews/{uid}`. Star-only reviews affect
the rating aggregates but are excluded from the written-review feed. All
timestamps and aggregates are server controlled.

The written-review query needs the composite index declared in
`firestore.indexes.json`: collection `reviews`, collection scope,
`hasComment ASC`, `createdAt DESC`, and `__name__ DESC`. Review writes do not
use this index, so `PUT` can succeed while `GET` returns Firestore
`FAILED_PRECONDITION` if the index has not reached `READY`.

### Firestore cutover and backfill

`firestore.rules`, `firestore.indexes.json`, and `firebase.json` version the
community security boundary, review index, and AI vector indexes. Deploy them
during the Android cutover; Android is explicitly denied access to AI versions,
chunks, and summary caches.

For Firebase project `fonos-group13-44726`, the review index was deployed and
verified `READY` on 2026-07-11. Deploying only indexes does not update rules:

```powershell
npx firebase deploy --only firestore:indexes --project fonos-group13-44726
npx firebase deploy --only firestore:rules --project fonos-group13-44726
```

Wait until both 768-dimensional `aiChunks.embedding` vector indexes are ready:
one supports book-wide KNN queries and one adds the `chapterId` prefilter.

After direct writes are blocked, preview the exact saved-membership backfill:

```powershell
npm run migrate:community-metrics
```

Apply the plan only after reviewing the book and membership counts:

```powershell
npm run migrate:community-metrics -- --apply
```

The script initializes missing rating fields without discarding valid existing
aggregates and recomputes each book's current unique `saveCount`.

### AI indexing lifecycle and backfill

Published books expose `aiStatus` as `unavailable`, `indexing`, `ready`, or
`failed`, plus `aiStatusReason`, `aiActiveVersion`, and `aiIndexedAt`. Indexes
are immutable under
`books/{bookId}/aiIndexVersions/{contentHash}/aiChunks/{chunkId}`. A build is
activated in a transaction only when the published source still has the same
SHA-256 content hash. The previous version is retained for rollback; older
inactive versions are removed after activation.

Every published chapter must have non-blank, complete `sourceText`. After
backfilling it, run either:

```powershell
npm run ai:index -- --all
npm run ai:index -- --book-id=book-1
npm run ai:index -- --book-id=book-1 --force
```

Publication enqueues indexing asynchronously. Server startup also re-enqueues
books left in `indexing`. Unchanged ready books are skipped unless `--force` is
used, but still warm any missing English chapter and whole-book summaries.
Summary warm failures are retried on the next indexing/backfill run and do not
roll back an already active index. A book with missing source becomes
`unavailable/missing_source_text`; provider or activation failures become
`failed` with a sanitized reason.

If queries return `ai_not_ready`, inspect the book status and finish the
backfill/index command. If Firestore reports `FAILED_PRECONDITION`, deploy the
vector indexes and wait for them to reach `READY`. If the API returns
`ai_provider_unavailable`, verify `DEEPSEEK_API_KEY` for generation,
`GEMINI_API_KEY` for embeddings, model names, network access, quota, and
provider failure logs. `AI_PROVIDER_TIMEOUT_MS` limits each provider attempt
(12 seconds by default), while `AI_RESPONSE_DEADLINE_MS` limits an interactive
Ask AI request to 30 seconds.

### `GET /health`

```json
{ "data": { "status": "ok", "port": 8080 } }
```

### `POST /api/v1/audiobooks`

Creates a draft and `chapter_1`.

```json
{
  "title": "My Demo Audiobook",
  "author": "Student Name",
  "coverUrl": "https://example.com/cover.jpg",
  "chapterTitle": "Chapter 1",
  "chapterText": "Text to synthesize. Max 3500 words.",
  "languageCode": "en-US",
  "voiceId": "Patrick"
}
```

Returns `201 Created` with `Location: /api/v1/audiobooks/{bookId}`.

Response:

```json
{ "data": { "bookId": "book-1", "generationStatus": "draft" } }
```

### `GET /api/v1/audiobooks/{bookId}/draft`

Returns an owned audiobook draft for Android edit mode.

```json
{
  "data": {
    "bookId": "book-1",
    "title": "My Demo Audiobook",
    "author": "Student Name",
    "coverUrl": "https://example.com/cover.jpg",
    "chapterTitle": "Chapter 1",
    "chapterText": "Original source text.",
    "languageCode": "en-US",
    "voiceId": "Patrick",
    "generationStatus": "draft"
  }
}
```

### `PUT /api/v1/audiobooks/{bookId}/draft`

Updates the owned initial audiobook draft with the same body contract as
`POST /api/v1/audiobooks`.

```json
{ "data": { "bookId": "book-1", "generationStatus": "draft" } }
```

### `POST /api/v1/audiobooks/{bookId}/chapters`

Creates a follow-up chapter draft on an owned user-generated audiobook.

```json
{
  "chapterTitle": "Chapter 2",
  "chapterText": "Text to synthesize. Max 3500 words.",
  "languageCode": "en-US",
  "voiceId": "Ruth"
}
```

Returns `201 Created` with
`Location: /api/v1/audiobooks/{bookId}/chapters/{chapterId}`.

```json
{
  "data": {
    "bookId": "book-1",
    "chapterId": "chapter_2",
    "generationStatus": "draft"
  }
}
```

### `GET /api/v1/audiobooks/{bookId}/chapters/{chapterId}/draft`

Returns an owned chapter draft for Android edit mode.

```json
{
  "data": {
    "bookId": "book-1",
    "chapterId": "chapter_2",
    "bookTitle": "My Demo Audiobook",
    "chapterTitle": "Chapter 2",
    "chapterText": "Original chapter source text.",
    "languageCode": "en-US",
    "voiceId": "Ruth",
    "generationStatus": "draft"
  }
}
```

### `PUT /api/v1/audiobooks/{bookId}/chapters/{chapterId}/draft`

Updates an owned draft chapter with the same body contract as
`POST /api/v1/audiobooks/{bookId}/chapters`.

```json
{
  "data": {
    "bookId": "book-1",
    "chapterId": "chapter_2",
    "generationStatus": "draft"
  }
}
```

### `POST /api/v1/audiobooks/{bookId}/generation-jobs`

Transitions the active owned `draft` or `failed` audiobook chapter to
`pending_generation`, returns `202 Accepted`, then processes Polly/S3 work in
the background.

```json
{ "data": { "bookId": "book-1", "generationStatus": "pending_generation" } }
```

### `POST /api/v1/audiobooks/{bookId}/chapters/{chapterId}/generation-jobs`

Transitions an owned `draft` or `failed` chapter to `pending_generation`,
returns `202 Accepted`, then processes Polly/S3 work in the background.

```json
{
  "data": {
    "bookId": "book-1",
    "chapterId": "chapter_2",
    "generationStatus": "pending_generation"
  }
}
```

The worker uses fixed synthesis settings: `us-east-1`, Long-form, plain text,
MP3 at 24 kHz, with either `Ruth` (female) or `Patrick` (male). Android does not
send AWS, engine, output, markup, or S3 configuration.

On completion Polly may return an output such as:

```text
audioUrl: https://s3.us-east-1.amazonaws.com/demo-bucket/audiobooks/user-1/book-1/chapter_1/task-123.mp3
s3Key:    audiobooks/user-1/book-1/chapter_1/task-123.mp3
```

The filename is taken from Polly's actual `OutputUri`; it is never assumed by
the backend.

After `ready_for_review` or `failed` is persisted, the backend sends a
best-effort FCM payload:

```text
type: audiobook_generation_status
bookId: {bookId}
generationStatus: ready_for_review | failed
title: {book title}
clickTarget: my_uploads
```

The payload excludes source chapter text and `generationError`; notification
delivery failure is logged but does not fail the generation job.

### `POST /api/v1/audiobooks/{bookId}/publications`

Publishes all owned ready-for-review chapters with generated audio and marks the
book published. This is the backend path used by Android's Publish Audiobook
and Publish Update actions.

```json
{
  "data": {
    "bookId": "book-1",
    "generationStatus": "published",
    "published": true
  }
}
```

At least one chapter must be `ready_for_review` with an `audioUrl`. Published
chapters cannot be deleted in the current version.

### `PATCH /api/v1/audiobooks/{bookId}/visibility`

Toggles whether an owned user-generated audiobook is hidden from the public
catalog while staying visible to its creator in My Uploads.

```json
{ "hiddenByCreator": true }
```

```json
{ "data": { "bookId": "book-1", "hiddenByCreator": true } }
```

### `DELETE /api/v1/audiobooks/{bookId}/chapters/{chapterId}`

Soft-deletes an owned non-published chapter. Android labels this as Delete for
draft/failed/ready chapters and Cancel Chapter for pending chapters. Generation
may finish later, but the backend ignores terminal writes for deleted chapters.

```json
{
  "data": {
    "bookId": "book-1",
    "chapterId": "chapter_2",
    "deleted": true,
    "generationStatus": "deleted"
  }
}
```

## Status Model

The backend and Android client use these generation status values:

| Status | Meaning |
|---|---|
| `draft` | Creator-owned draft content can still be edited or queued. |
| `pending_generation` | Polly generation is queued, scheduled, or in progress. |
| `failed` | Generation failed with a bounded sanitized reason and can be retried. |
| `ready_for_review` | Audio generation succeeded and the creator can preview it. |
| `published` | Ready audio has been published to the public catalog unless hidden. |
| `rejected` | Reserved for a future moderation workflow. |
| `deleted` | Non-published chapter was soft-deleted or canceled by the creator. |

AI indexing has a separate lifecycle:

| AI status | Meaning |
|---|---|
| `unavailable` | Complete published `sourceText` is missing or has never been indexed. |
| `indexing` | An immutable content version is being built and validated. |
| `ready` | `aiActiveVersion` points to a complete atomically activated index. |
| `failed` | Indexing failed; inspect `aiStatusReason` and retry the backfill command. |

## Verification

```powershell
npm test
npm run test:rules
npm run test:coverage
npm audit --omit=dev
```

Manual smoke test after adding real credentials:

```powershell
curl http://localhost:8080/health
npm run ai:index -- --book-id=book-1
```

Then run the Android debug app with `BACKEND_BASE_URL=http://10.0.2.2:8080` in the Android project's `local.properties`.

The deployed review index was also verified with the production repository
query: `pride_prejudice` returned one written review with the expected public
review shape and no pagination cursor.
