# VideoCMS Importer

A small browser-based Node.js service for bulk importing original StreamingPlay MP4 files into VideoCMS without re-encoding. It is designed to run on the storage server or in a container that can write to the same shared media storage used by VideoCMS.

## Interface

Open the service in a browser. You can:

- paste one `https://streamingplay.biz/download/VIDEO_ID` URL per line;
- upload a CSV containing a URL column;
- watch live progress logs;
- review recent batches after a restart;
- retry failed items or cancel a batch.

Each batch has a persistent SQLite record and a text log at `LOG_DIR/<batch-uuid>.log`.

## Import sequence

1. Convert each `/download/<id>` URL to `/embed/<id>`.
2. Open the embed page with Puppeteer and attempt to capture the thumbnail and a VTT/SRT subtitle if available.
3. Open the download page and read the title from `.head__title span`.
4. Use the provider's visible download button and Chrome DevTools Protocol download events to download the original MP4.
5. Run `ffprobe` to read file size, duration, dimensions, and frame rate. This is metadata inspection only; the video is not encoded or transcoded.
6. Call the authenticated VideoCMS `POST /api/importer/imports` endpoint using a stable `request_id`. The original `embed_url` is sent as well so the Go backend can persist it for the WordPress iframe migration lookup.
7. Move the downloaded MP4 and optional assets into the destination paths returned by VideoCMS.
8. Call `POST /api/importer/imports/:key/complete`; VideoCMS checks the files before marking the MP4 quality and subtitles ready.

**Storage note:** the API validates the files using VideoCMS's configured `PublishedQualitysRoot()`. Configure `MEDIA_ROOT` to point to the same physical storage root in the importer container/host. The same underlying volume must be visible and writable by both services. Do not point the importer at a local VPS1 staging disk if the intent is to keep the original media on VPS3.

The current Go endpoint requires `size` and `duration` when creating an import, so the importer downloads into a staging directory on the configured media filesystem first, probes the downloaded media, normalizes non-MP4 containers to MP4 with FFmpeg stream copy (`-c copy`, no re-encoding), probes the result again, then creates the VideoCMS records and moves the validated file to the returned final path. The `.mp4` filename from StreamingPlay is not trusted as proof of its container. A remux failure leaves the source in staging and fails that item rather than publishing an invalid file. It does not use the existing VideoCMS upload or encoding pipeline.

**Production placement recommendation:** run the importer/remux step on VPS3, where its staging directory and final media storage are local. The supplied Dockerfile already installs FFmpeg (and therefore FFprobe). Keep `STAGING_ROOT` on the VPS3 media filesystem; only after remux validation does the importer place the file in `/data/media/videos`, which VideoCMS on VPS1 sees through the NFS mount. This avoids performing the remux through the VPS1 NFS mount.

## Requirements

- Node.js 20.11 or later (Node 22 recommended)
- FFprobe (`ffprobe` from FFmpeg) available on `PATH`, or set `FFPROBE_PATH`
- Chromium dependencies (included in the supplied Dockerfile)
- network access from the importer to StreamingPlay and the VideoCMS API
- a VideoCMS API key with permission to use the protected importer endpoints
- shared writable storage used by VideoCMS

## Local setup

```bash
cp .env.example .env
# Edit .env: set WEB_PASSWORD, VIDEO_CMS_API_BASE_URL, VIDEO_CMS_API_KEY,
# MEDIA_ROOT, STAGING_ROOT, and any desired PARENT_FOLDER_ID.
npm install
npm start
```

Open `http://127.0.0.1:3085`. The service refuses to start unless `WEB_PASSWORD` is set to a non-placeholder value. Keep `HOST=127.0.0.1` for local use, or put it behind a trusted reverse proxy/VPN before exposing it remotely.

For the first live test, keep `MAX_PARALLEL_JOBS=1` and import one video. Increase concurrency only after confirming storage throughput and provider behavior.

## Environment variables

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | Listen address and port; default `127.0.0.1:3085` |
| `WEB_USERNAME`, `WEB_PASSWORD` | HTTP Basic authentication for the UI and API |
| `VIDEO_CMS_API_BASE_URL` | VideoCMS API base including `/api`, e.g. `http://videocms:3000/api` |
| `VIDEO_CMS_API_KEY` | VideoCMS API key; sent as `Authorization: Bearer ...` |
| `PARENT_FOLDER_ID` | Optional existing VideoCMS folder ID; `0` uses the root folder |
| `MEDIA_ROOT` | Final VideoCMS media root visible to this service |
| `STAGING_ROOT` | Temporary download location; preferably on the same filesystem as `MEDIA_ROOT` |
| `MAX_PARALLEL_JOBS` | Concurrent video downloads; default `2`, maximum `8` |
| `MAX_BATCH_SIZE` | Maximum URLs accepted in a batch; default `500` |
| `DOWNLOAD_TIMEOUT_MS` | Browser download timeout; default one hour |
| `PROVIDER_CAPTURE_WINDOW_MS` | Time to inspect embed page for assets; default 12 seconds |
| `FFPROBE_PATH` | FFprobe executable path; default `ffprobe` |
| `FFMPEG_PATH` | FFmpeg executable path; default `ffmpeg` |
| `REMUX_TIMEOUT_MS` | MP4 container-remux timeout in milliseconds; default 1800000 |
| `DB_PATH` | Persistent SQLite database path |
| `LOG_DIR` | Directory for per-batch text logs |
| `BROWSER_HEADLESS` | `true` by default; set `false` only for diagnostics with a display available |
| `BROWSER_NO_SANDBOX` | Set `true` only inside a properly isolated container if Chromium sandboxing is unavailable |
| `BROWSER_EXECUTABLE_PATH` | Optional path to a system Chromium executable |
| `TRUST_PROXY` | Set `true` only when correctly deployed behind a trusted single reverse proxy |

## CSV format

Minimal one-column CSV:

```csv
download_url
https://streamingplay.biz/download/VIDEO_ID_1
https://streamingplay.biz/download/VIDEO_ID_2
```

Rows with duplicate download URLs in the same batch are deduplicated. Only `streamingplay.biz` and `www.streamingplay.biz` download URLs are accepted.

## Storage and recovery

- SQLite stores batches, per-video job state, request IDs, API responses, and log references.
- Log messages are appended to a plain-text file per batch.
- The `request_id` is generated and persisted before the first VideoCMS API call. If a request succeeds but its response is lost, a retry uses the same ID so the Go API can return the existing import.
- The importer does not log signed media URLs or cookies.
- Failed items can be retried from the UI. The original staging assets are reused when available.
- A completed import is not marked ready until the Go completion endpoint validates the final video and optional assets.

## Go backend compatibility

The importer expects the authenticated endpoints from the VideoCMS importer backend changes:

- `POST /api/importer/imports`
- `POST /api/importer/imports/:key/complete`

It sends `embed_url` as a canonical `https://streamingplay.biz/embed/<id>` URL. Make sure the Go build deployed in the target environment includes the additive `VideoImports.SourceEmbedURL` / `SourceEmbedKey` fields and the public `/api/importer/iframe?embedUrl=...` lookup handler if you intend to use the WordPress iframe migration. Existing `Files` and `Links` tables do not need new columns.

## Limitations for the first version

- Thumbnail and subtitle extraction are best-effort because StreamingPlay can change its page markup or asset delivery behavior.
- A direct VTT/SRT response or a `<track src>` is supported; subtitle tracks embedded only inside an HLS playlist may need a follow-up enhancement.
- The download-button CSS selector is based on the supplied POC and may need updating if the provider changes its page.
- Test with one video before importing a large batch. Do not raise concurrency until a test confirms stable downloads and storage performance.
