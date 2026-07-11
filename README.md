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

Fill `.env` with your Firebase project ID, Firebase Admin service-account path, AWS profile and S3 bucket. Do not commit `.env`, service account JSON files, or AWS keys.

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

Reviews are stored at `books/{bookId}/reviews/{uid}`. Star-only reviews affect
the rating aggregates but are excluded from the written-review feed. All
timestamps and aggregates are server controlled.

### Firestore cutover and backfill

`firestore.rules`, `firestore.indexes.json`, and `firebase.json` version the
community security boundary and review index. Deploy them during the Android
cutover; old Android builds can no longer write saved membership directly.

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
```

Then run the Android debug app with `BACKEND_BASE_URL=http://10.0.2.2:8080` in the Android project's `local.properties`.
