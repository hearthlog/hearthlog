# Web Archiver Backend Design

Status: **deleted 2026-10-06.** The Web Archive page was removed and the backend was never built. Kept for reference.

## Purpose

This document designs the backend service for the personal web archiver page. The frontend already models one immutable `webarchive` row per capture snapshot. The backend should stay deliberately dumb: accept a URL snapshot request, run Browsertrix asynchronously, create a WACZ, put it in R2, and expose enough status for the frontend to update its existing snapshot row.

The revised architecture keeps most infrastructure on Cloudflare:

- Cloudflare Worker: public archive API facade.
- Cloudflare R2: request files, WACZ artifacts, result manifests, and logs.
- Google Cloud Run Job: short-lived Browsertrix compute only.
- Hearthlog app: durable archive catalog and snapshot history.

There is no Firestore, no D1, and no Google Cloud Storage in the baseline plan.

## Decisions

| Decision | Choice |
| --- | --- |
| Public backend API | Cloudflare Worker |
| Durable artifact store | Cloudflare R2 |
| Backend database | None |
| Crawl compute | Google Cloud Run Job |
| API stack | TypeScript Worker with Hono |
| Runner stack | Small TypeScript or shell wrapper around Browsertrix |
| Frontend source of truth | Existing `webarchive` entity rows |

The reason for this split is practical: Cloudflare is cheaper and simpler for storage/API, while Cloud Run Jobs are still the better fit for running the heavy Browsertrix Chromium container.

## Goals

- Keep the browser-facing API on Cloudflare.
- Keep WACZ artifacts in R2.
- Avoid adding a database for job metadata.
- Run Browsertrix as an async Cloud Run Job.
- Keep Google credentials, R2 credentials, and backend auth transparent to the client.
- Preserve immutable frontend snapshots: every capture creates a new `webarchive` row and a new WACZ object.
- Support ReplayWeb.page through stable, Range-readable WACZ URLs.
- Keep failed snapshots auditable through result manifests and frontend rows.
- Keep cost concentrated in short-lived Cloud Run compute and low-cost R2 storage.

## Non-Goals

- Browsertrix Cloud.
- Docker-in-Docker.
- Firestore, D1, KV, Durable Objects, or another backend database in the first release.
- Backend archive catalog search. The Hearthlog app already has the archive history.
- Multi-user tenancy.
- Interactive authenticated browser profiles in the first release.
- Public archive sharing as a product feature.

## Source Basis

Current source assumptions checked on 2026-07-06:

- Cloud Run Jobs run containers that do work and exit, unlike Cloud Run services that listen for HTTP requests.
- Cloud Run Jobs can be executed with overrides for args, env vars, task count, and task timeout.
- R2 is accessible from Workers through an R2 binding.
- R2 `get` supports ranged reads through `R2GetOptions.range`.
- R2 supports bucket CORS configuration when direct browser access is needed.
- R2 Standard storage currently has a free tier and no egress charges for direct R2 egress.
- Worker secrets are the right place for sensitive values used by the Worker.
- Browsertrix Crawler can generate WACZ output with `--generateWACZ`.

Useful upstream references:

- Cloud Run jobs: <https://docs.cloud.google.com/run/docs/create-jobs>
- Cloud Run job execution and overrides: <https://docs.cloud.google.com/run/docs/execute/jobs>
- Cloudflare R2 Workers API: <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>
- Cloudflare R2 CORS: <https://developers.cloudflare.com/r2/buckets/cors/>
- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- Cloudflare Worker secrets: <https://developers.cloudflare.com/workers/configuration/secrets/>
- Browsertrix Crawler outputs: <https://crawler.docs.browsertrix.com/user-guide/outputs/>
- Browsertrix Crawler CLI options: <https://crawler.docs.browsertrix.com/user-guide/cli-options/>

## High-Level Architecture

```text
Hearthlog frontend
  |
  | VITE_WEB_ARCHIVER_URL=/archive-api
  v
Cloudflare Worker: web-archive-api
  - validates URL-only capture requests
  - writes request and initial status JSON to R2
  - starts a Cloud Run Job execution
  - reads status/result JSON from R2
  - optionally asks Cloud Run about execution state
  - serves WACZ objects from R2 with Range support
  |
  | Cloud Run Admin API jobs.run
  v
Google Cloud Run Job: web-archive-crawl
  - one execution per snapshot
  - runs Browsertrix Crawler
  - uploads archive.wacz to R2 using S3-compatible API
  - uploads result.json and logs to R2
  - exits

Cloudflare R2
  requests/<snapshotId>.json
  snapshots/<snapshotId>/status.json
  snapshots/<snapshotId>/archive.wacz
  snapshots/<snapshotId>/result.json
  snapshots/<snapshotId>/log.txt

Hearthlog app database
  webarchive rows with status, timestamps, job id, WACZ URL, and metadata
```

The key point: the backend does not have a durable catalog. The Hearthlog app already owns the catalog. R2 only stores per-snapshot files.

## Durable State Ownership

| Data | Owner |
| --- | --- |
| User-facing snapshot history | Hearthlog `webarchive` entity |
| Tags, notes, labels, edited title | Hearthlog `webarchive` entity |
| Job id and current frontend status | Hearthlog `webarchive` entity |
| Original backend request | R2 `requests/<snapshotId>.json` |
| Current backend status fallback | R2 `snapshots/<snapshotId>/status.json` |
| Final result metadata | R2 `snapshots/<snapshotId>/result.json` |
| WACZ artifact | R2 `snapshots/<snapshotId>/archive.wacz` |
| Cloud Run execution state | Google Cloud Run, temporary operational state |

No database is needed because the backend never needs to list all archives. It only answers questions about one known `snapshotId`, which the frontend already has.

## R2 Layout

```text
requests/
  <snapshotId>.json

snapshots/
  <snapshotId>/
    status.json
    archive.wacz
    result.json
    log.txt
    pages.jsonl
```

`status.json` is a small mutable file:

```json
{
  "snapshotId": "webarchive-row-id",
  "jobId": "cloud-run-execution-or-local-id",
  "status": "submitted",
  "submittedAt": "2026-07-06T10:00:00.000Z",
  "startedAt": "",
  "completedAt": "",
  "errorMessage": ""
}
```

`result.json` is written once when the runner exits:

```json
{
  "snapshotId": "webarchive-row-id",
  "jobId": "cloud-run-execution-or-local-id",
  "status": "complete",
  "url": "https://example.com/",
  "normalizedUrl": "https://example.com/",
  "title": "Example Domain",
  "pageCount": 1,
  "sizeBytes": 1048576,
  "waczKey": "snapshots/webarchive-row-id/archive.wacz",
  "startedAt": "2026-07-06T10:00:12.000Z",
  "completedAt": "2026-07-06T10:01:20.000Z",
  "errorMessage": ""
}
```

Rules:

- `archive.wacz` is immutable after successful upload.
- Retry creates a new frontend snapshot id and therefore a new R2 prefix.
- `status.json` can be overwritten during the job.
- `result.json` is the terminal manifest.
- `log.txt` is best-effort operator debugging, not user-facing state.

## API Contract

### Start Job

`POST /archives`

Request:

```json
{
  "snapshotId": "webarchive-row-id",
  "requestId": "uuid",
  "url": "https://example.com/",
  "normalizedUrl": "https://example.com/",
  "options": {
    "scope": "page",
    "depth": 1
  }
}
```

Response:

```json
{
  "jobId": "cloud-run-execution-name",
  "status": "submitted",
  "statusUrl": "https://app.example.com/archive-api/archives/webarchive-row-id"
}
```

Worker behavior:

1. Validate `snapshotId`, `requestId`, and URL.
2. Accept only `http` and `https`.
3. Reject localhost, private networks, link-local addresses, and cloud metadata IP ranges by default.
4. Write `requests/<snapshotId>.json` to R2 with the normalized request.
5. Write `snapshots/<snapshotId>/status.json` with `submitted`.
6. Execute the Cloud Run Job with per-execution overrides.
7. Update `status.json` with the returned execution/job id.
8. Return `202`.

If job execution fails before Cloud Run accepts it, update `status.json` to `failed` and return an error. The frontend can keep the failed snapshot row and offer retry.

### Poll Job

`GET /archives/{snapshotId}`

Worker behavior:

1. If `snapshots/<snapshotId>/result.json` exists, return terminal status from it.
2. Else read `snapshots/<snapshotId>/status.json`.
3. If status is non-terminal and includes a Cloud Run execution id, optionally query Cloud Run execution state.
4. If Cloud Run says the execution failed or timed out, write `result.json` with `failed` and return it.
5. Otherwise return the current `submitted` or `running` status.

Response:

```json
{
  "jobId": "cloud-run-execution-name",
  "status": "complete",
  "waczUrl": "https://app.example.com/archive-api/artifacts/webarchive-row-id/archive.wacz",
  "replayUrl": "https://app.example.com/web-archives/webarchive-row-id",
  "browsertrixItemId": "cloud-run-execution-name",
  "pageCount": 1,
  "sizeBytes": 1048576,
  "title": "Example Domain",
  "submittedAt": "2026-07-06T10:00:00.000Z",
  "startedAt": "2026-07-06T10:00:12.000Z",
  "completedAt": "2026-07-06T10:01:20.000Z",
  "lastCheckedAt": "2026-07-06T10:01:30.000Z",
  "errorMessage": ""
}
```

Status values remain:

- `queued`
- `submitted`
- `running`
- `complete`
- `failed`
- `cancelled`

### Artifact

`GET /artifacts/{snapshotId}/archive.wacz`

`HEAD /artifacts/{snapshotId}/archive.wacz`

Recommended first release: serve through the Worker from an R2 binding.

Reasons:

- Keeps R2 bucket private.
- Gives the frontend one stable same-origin URL.
- Lets the Worker implement CORS and Range behavior explicitly.
- Avoids R2 public bucket policy and direct URL concerns.

Worker response requirements:

```text
Accept-Ranges: bytes
Content-Type: application/wacz
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag
```

For `Range: bytes=start-end`, call R2 `get` with `range: { offset, length }` and return `206 Partial Content`. For suffix ranges, use `range: { suffix }`.

Direct R2 URLs are a later optimization only if Worker proxying becomes a real bottleneck.

## Cloud Run Job Execution

The Worker executes an existing Cloud Run Job:

```http
POST https://run.googleapis.com/v2/projects/PROJECT_ID/locations/REGION/jobs/web-archive-crawl:run
Authorization: Bearer <worker-generated-google-access-token>
Content-Type: application/json
```

Payload:

```json
{
  "overrides": {
    "containerOverrides": [
      {
        "env": [
          {
            "name": "ARCHIVE_REQUEST_KEY",
            "value": "requests/webarchive-row-id.json"
          },
          {
            "name": "ARCHIVE_OUTPUT_PREFIX",
            "value": "snapshots/webarchive-row-id"
          },
          {
            "name": "R2_BUCKET",
            "value": "st-web-archives"
          }
        ]
      }
    ],
    "taskCount": 1,
    "timeout": "900s"
  }
}
```

The Worker needs a narrowly scoped Google service account credential stored as a Cloudflare secret. That credential should only be able to execute this one Cloud Run Job and inspect/cancel executions if those actions are implemented.

Alternative if you do not want a Google private key in Cloudflare: add a tiny Google-hosted starter service that uses Cloud Run IAM internally. That is cleaner from an IAM perspective but adds another service, so it is not the default.

## Runner Design

The Cloud Run Job image is Browsertrix plus a small wrapper.

Runner responsibilities:

1. Read `ARCHIVE_REQUEST_KEY` and `ARCHIVE_OUTPUT_PREFIX`.
2. Download `requests/<snapshotId>.json` from R2 using the S3-compatible API.
3. Upload `status.json` with `running`.
4. Run Browsertrix.
5. Locate the generated WACZ.
6. Extract title, page count, size, and useful logs.
7. Upload `archive.wacz` to R2.
8. Upload `result.json` with `complete`.
9. On failure, upload `result.json` with `failed`.

Default Browsertrix invocation:

```text
crawl
  --url <url>
  --generateWACZ
  --text to-pages
  --collection <snapshotId>
  --scopeType page
  --depth 1
  --pageLimit 1
  --timeLimit <max seconds>
  --overwrite
```

R2 upload should use the S3-compatible API with credentials stored as Cloud Run secrets. Use multipart upload for large WACZ files.

## Authentication Boundary

The browser must not see backend credentials.

Secrets:

| Secret | Location | Used by |
| --- | --- | --- |
| Google service account private key or equivalent signer | Cloudflare Worker secret | Start Cloud Run Job |
| R2 access key id | Cloud Run secret/env | Runner uploads artifacts |
| R2 secret access key | Cloud Run secret/env | Runner uploads artifacts |
| Optional Worker callback token | Cloudflare Worker and Cloud Run secret | Future callback endpoint |

The frontend only calls `/archive-api`. It never stores Basic auth, Google credentials, R2 keys, service account keys, signed upload credentials, or Cloud Run tokens.

## Tech Stack

Use TypeScript end to end unless the runner wrapper becomes easier as shell.

Cloudflare Worker:

- TypeScript
- Hono
- Zod
- R2 binding
- Web Crypto for Google JWT signing
- direct REST call to Cloud Run Admin API

Cloud Run runner:

- Browsertrix Crawler pinned image
- TypeScript Node script or shell wrapper
- S3-compatible upload to R2
- minimal JSON manifest writing

Why not Rust here:

- The API is mostly Cloudflare Worker glue and Google REST calls.
- The runtime is already JavaScript-native.
- The service should stay small and disposable.

## Cost Model

R2 is the durable cost center. Cloud Run is burst compute only.

Use R2 Standard storage first:

- Free tier currently includes 10 GB-month, 1 million Class A operations, 10 million Class B operations, and free egress.
- Standard storage has no minimum storage duration.
- Infrequent Access is not the first-release default because reads have data retrieval fees and a minimum storage duration.

Cloud Run cost controls:

- One task per snapshot.
- `--pageLimit 1` by default.
- `--scopeType page` by default.
- 900 second timeout.
- max retries `0` or `1`.
- low CPU/memory to start, increase only after Browsertrix proves it needs it.
- budget alert in Google Cloud because a billing account is still required.

## Configuration

Worker variables:

| Variable | Meaning |
| --- | --- |
| `PUBLIC_BASE_URL` | App/API base URL |
| `APP_ORIGIN` | Allowed frontend origin |
| `GCP_PROJECT_ID` | Google Cloud project id |
| `GCP_REGION` | Cloud Run region |
| `GCP_CRAWL_JOB_NAME` | Cloud Run Job name |
| `MAX_CRAWL_SECONDS` | Job timeout override |
| `MAX_PAGE_LIMIT` | Browsertrix limit |
| `ALLOW_PRIVATE_TARGETS` | Defaults to `false` |

Worker bindings/secrets:

| Name | Type |
| --- | --- |
| `ARCHIVE_BUCKET` | R2 bucket binding |
| `GCP_SERVICE_ACCOUNT_EMAIL` | variable |
| `GCP_SERVICE_ACCOUNT_PRIVATE_KEY` | secret |

Cloud Run runner variables/secrets:

| Name | Type |
| --- | --- |
| `ARCHIVE_REQUEST_KEY` | per-execution env override |
| `ARCHIVE_OUTPUT_PREFIX` | per-execution env override |
| `R2_ACCOUNT_ID` | secret/env |
| `R2_BUCKET` | env |
| `R2_ACCESS_KEY_ID` | secret |
| `R2_SECRET_ACCESS_KEY` | secret |
| `DEFAULT_SCOPE_TYPE` | env |
| `DEFAULT_PAGE_LIMIT` | env |
| `DEFAULT_TIME_LIMIT_SECONDS` | env |

## Deployment Sketch

Create R2 bucket:

```bash
npx wrangler r2 bucket create st-web-archives
```

Configure Worker binding:

```json
{
  "r2_buckets": [
    {
      "binding": "ARCHIVE_BUCKET",
      "bucket_name": "st-web-archives"
    }
  ],
  "secrets": {
    "required": ["GCP_SERVICE_ACCOUNT_PRIVATE_KEY"]
  }
}
```

Deploy Cloud Run Job:

```bash
gcloud run jobs deploy web-archive-crawl \
  --image=REGION-docker.pkg.dev/PROJECT/st/web-archive-crawler:VERSION \
  --region=REGION \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=900s \
  --cpu=1 \
  --memory=2Gi
```

Deploy Worker:

```bash
npx wrangler secret put GCP_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler deploy
```

Frontend config:

```bash
VITE_WEB_ARCHIVER_URL=/archive-api
```

## Security Controls

- Accept only `http` and `https`.
- Resolve DNS and reject private, loopback, link-local, multicast, Docker bridge, and metadata IP ranges.
- Re-check DNS close to crawl execution to reduce DNS rebinding risk.
- Clamp page limit, crawl depth, workers, timeout, output size, and Browsertrix scope.
- Default to single-page captures.
- Keep R2 bucket private.
- Serve WACZ through the Worker with checked object keys.
- Use per-service credentials with the narrowest available scope.
- Do not expose Google Cloud Run Admin API directly to the browser.
- Do not expose R2 write credentials to the browser.
- Log enough for debugging failed jobs, but keep user-facing history in Hearthlog.

## Failure Handling

| Failure | Handling |
| --- | --- |
| Invalid URL | Worker returns `400`; frontend can mark snapshot failed |
| Private target | Worker returns `400` unless explicitly allowed |
| R2 request write fails | Worker returns `503`; no Cloud Run job starts |
| Cloud Run start fails | Worker writes `failed` status to R2 and returns error |
| Runner cannot read request | Runner writes failed result if possible and exits non-zero |
| Browsertrix exits non-zero | Runner uploads failed `result.json` and logs |
| Runner times out | Worker detects Cloud Run terminal failure during polling and writes failed `result.json` |
| WACZ missing | Runner marks failed |
| Result exists but WACZ missing | Worker returns `failed` because replay is impossible |

## Frontend Integration

The existing frontend flow remains:

1. Create a new `webarchive` row with `archive_status="queued"`.
2. Call `POST /archives`.
3. Store returned `backend_job_id`.
4. Poll `GET /archives/{snapshotId}`.
5. Update the same snapshot row with status, timestamps, title, page count, size, `wacz_url`, and error text.
6. Replay successful snapshots through `/web-archives/[id]`.

Metadata stays simple:

- URL is required at capture time.
- Title can come from Browsertrix result or be edited later.
- Notes, tags, and labels are edited later in the app.
- Retry always creates a new snapshot row and a new R2 prefix.

History mode stays read-only and never starts backend jobs.

## Local Development

Local development can run in two layers:

1. Worker-only dev with `wrangler dev`, fake Cloud Run start, and R2 preview/local binding.
2. End-to-end dev where the runner is invoked locally with Docker and uploads to a dev R2 bucket.

No local database is required.

Suggested package shape:

```text
services/web-archiver/
  worker/
    wrangler.jsonc
    src/
      index.ts
      routes.ts
      r2.ts
      cloud-run.ts
      google-auth.ts
      range.ts
      security.ts
      schemas.ts
  runner/
    Dockerfile
    src/
      main.ts
      browsertrix.ts
      r2-upload.ts
      metadata.ts
  tests/
    worker-routes.test.ts
    range.test.ts
    google-auth.test.ts
    security.test.ts
    runner-command.test.ts
```

## Milestones

### Milestone 1: No-DB MVP

- Add Worker project.
- Add R2 bucket binding.
- Implement URL validation and request writing.
- Implement Cloud Run Job start.
- Implement Browsertrix runner upload to R2.
- Implement status polling from R2 manifests.
- Implement Worker WACZ proxy with `Range`.
- Verify ReplayWeb.page can load a real R2-backed WACZ.

### Milestone 2: Hardening

- Add private-network URL protection.
- Add exact timeout/page/size clamps.
- Add terminal failure reconciliation from Cloud Run execution state.
- Add tests for Range parsing and status mapping.
- Add budget alerts and deployment docs.

### Milestone 3: Optional Operations

- Add cancellation.
- Add log download.
- Add backend-only crawl profiles.
- Add direct R2 URL mode only if Worker proxying becomes a bottleneck.

## Open Decisions

- Whether Cloudflare Worker may hold the Google service account signing key, or whether to add a tiny Google starter service to avoid that.
- Whether runner wrapper should be TypeScript or shell.
- Exact Cloud Run region.
- Whether the first release should reject new captures while one job is already running.
