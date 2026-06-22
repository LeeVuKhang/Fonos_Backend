# Fonos Audiobook Backend

Demo Node.js + Express backend for user-generated audiobooks in the Android emulator flow.

## What it does

- Verifies Firebase ID tokens from Android.
- Creates trusted Firestore `books/{bookId}` and `chapters/chapter_1` documents.
- Queues one in-process AWS Polly generation job at a time.
- Uploads generated MP3 audio to S3 and writes a stable public `audioUrl` back to Firestore.

Generated books remain `published=false` and move to `ready_for_review` for creator preview only.

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

AWS uses the normal SDK credential chain; for local demo use `AWS_PROFILE=default` or another local profile.

Required AWS actions for the backend identity:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*" },
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

The upload code does not set an object ACL. Public playback depends on the bucket policy above.

## API

All `/api/v1/*` endpoints require:

```text
Authorization: Bearer <Firebase ID token>
Content-Type: application/json
```

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
  "voiceId": "Matthew"
}
```

Returns `201 Created` with `Location: /api/v1/audiobooks/{bookId}`.

### `POST /api/v1/audiobooks/{bookId}/generation-jobs`

Transitions an owned `draft` or `failed` audiobook to `pending_generation`, returns `202 Accepted`, then processes Polly/S3 work in the background.

## Verification

```powershell
npm test
npm run test:coverage
npm audit --omit=dev
```

Manual smoke test after adding real credentials:

```powershell
curl http://localhost:8080/health
```

Then run the Android debug app with `BACKEND_BASE_URL=http://10.0.2.2:8080` in the Android project's `local.properties`.
