import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { addLog, db, getBatch, getItem, refreshBatch, updateBatch, updateItem, wasCancelRequested } from './store.js';
import { downloadStreamingPlay, normalizeDownloadedVideo, safeFilename } from './provider.js';
import { fitVideoCMSName } from './name-utils.js';

export const events = new EventEmitter();
events.setMaxListeners(0);
const activeBatches = new Set();
const activeItems = new Set();
const configuredParallel = Number(process.env.MAX_PARALLEL_JOBS || 8);
const maxParallel = Number.isFinite(configuredParallel) ? Math.max(1, Math.floor(configuredParallel)) : 8;
const mediaRoot = path.resolve(process.env.MEDIA_ROOT || '/data/media/videos');
const stagingRoot = path.resolve(process.env.STAGING_ROOT || path.join(path.dirname(mediaRoot), '.videocms-importer-staging'));
const logDir = path.resolve(process.env.LOG_DIR || './logs');
await fs.mkdir(logDir, { recursive: true });
await fs.mkdir(stagingRoot, { recursive: true });

function cleanError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL omitted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1000);
}

export async function logMessage(batchId, itemId, message) {
  const record = addLog(batchId, itemId, message);
  const line = `[${record.created_at}] ${message}\n`;
  await fs.appendFile(path.join(logDir, `${batchId}.log`), line, 'utf8').catch(() => {});
  // Progress/log messages travel as lightweight log events. Batch snapshots are
  // emitted at meaningful state transitions, not for every download progress tick.
  events.emit(`batch:${batchId}`, { type: 'log', log: record });
}

function summarizeBatch(batch) {
  if (!batch) return null;
  return {
    id: batch.id, created_at: batch.created_at, updated_at: batch.updated_at,
    status: batch.status, total: batch.total, completed: batch.completed || 0,
    failed: batch.failed || 0, cancel_requested: Boolean(batch.cancel_requested),
    items: (batch.items || []).map((item) => ({ id: item.id, ordinal: item.ordinal, source_url: item.source_url, status: item.status, name: item.name, video_bytes: item.video_bytes, link_uuid: item.link_uuid, file_uuid: item.file_uuid, error: item.error }))
  };
}

function apiConfig() {
  const base = String(process.env.VIDEO_CMS_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.VIDEO_CMS_API_KEY || '').trim();
  if (!base || !key) throw new Error('Set VIDEO_CMS_API_BASE_URL and VIDEO_CMS_API_KEY in .env');
  return { base, key };
}

async function apiRequest(url, key, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.VIDEO_CMS_API_TIMEOUT_MS || 60000));
  try {
    const response = await fetch(url, {
      ...options,
      headers: { authorization: `Bearer ${key}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
      signal: controller.signal
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(`VideoCMS API returned HTTP ${response.status}: ${body.error || body.message || 'request failed'}`);
    return body;
  } finally { clearTimeout(timer); }
}

function resolveMediaPath(relativePath) {
  const full = path.resolve(mediaRoot, relativePath);
  if (full !== mediaRoot && !full.startsWith(`${mediaRoot}${path.sep}`)) throw new Error('VideoCMS returned an unsafe destination path');
  return full;
}

async function moveFile(source, destination) {
  if (!source) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    const stat = await fs.stat(destination);
    if (stat.isFile() && stat.size > 0) return true;
  } catch { /* destination does not exist */ }
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(source, destination);
    await fs.unlink(source);
  }
  const stat = await fs.stat(destination);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Destination file is missing or empty: ${destination}`);
  return true;
}

async function fileExistsWithBytes(filePath) {
  if (!filePath) return false;
  try { const stat = await fs.stat(filePath); return stat.isFile() && stat.size > 0; } catch { return false; }
}

function isInsideStagingRoot(candidatePath, minimumDepth = 2) {
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(stagingRoot, candidate);
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.length >= minimumDepth && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function cleanupCompletedStageDirectory(stageDir) {
  if (!stageDir) return false;
  const resolved = path.resolve(stageDir);
  if (!isInsideStagingRoot(resolved)) {
    throw new Error(`Refusing to clean a staging path outside STAGING_ROOT: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
  // Remove the containing batch directory only if it is empty; never recurse into it.
  const batchDirectory = path.dirname(resolved);
  if (isInsideStagingRoot(batchDirectory, 1)) {
    await fs.rmdir(batchDirectory).catch((error) => {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
    });
  }
  return true;
}

async function getOrDownload(item) {
  const stageDir = item.stage_dir || path.join(stagingRoot, item.batch_id, String(item.ordinal).padStart(5, '0'));
  await fs.mkdir(stageDir, { recursive: true });
  let stagedVideo = item.staged_video || path.join(stageDir, 'video.mp4');
  let stagedThumbnail = item.staged_thumbnail || null;
  let stagedSubtitle = item.staged_subtitle || null;
  let metadata = item.metadata_json ? JSON.parse(item.metadata_json) : null;
  let name = item.name || null;

  if (await fileExistsWithBytes(stagedVideo)) {
    if (metadata && name) {
      // Revalidate persisted staged files rather than trusting metadata written by an older version.
      metadata = await normalizeDownloadedVideo(
        stagedVideo,
        (message) => logMessage(item.batch_id, item.id, `[video #${item.ordinal}] ${message}`),
        () => wasCancelRequested(item.batch_id)
      );
      updateItem(item.id, { stage_dir: stageDir, staged_video: stagedVideo, video_bytes: metadata.size, metadata_json: JSON.stringify(metadata), error: null });
      await logMessage(item.batch_id, item.id, `[video #${item.ordinal}] Reusing validated video from staging`);
      return { stageDir, stagedVideo, stagedThumbnail, stagedSubtitle, metadata, name };
    }

    if (name) {
      // A previous remux may have failed before metadata was persisted. Keep the existing
      // large source and retry the remux directly, without another provider download.
      updateItem(item.id, { status: 'downloading', stage_dir: stageDir, staged_video: stagedVideo, error: null });
      await logMessage(item.batch_id, item.id, `[video #${item.ordinal}] Found an existing staged video; retrying validation/remux without downloading it again`);
      metadata = await normalizeDownloadedVideo(
        stagedVideo,
        (message) => logMessage(item.batch_id, item.id, `[video #${item.ordinal}] ${message}`),
        () => wasCancelRequested(item.batch_id)
      );
      updateItem(item.id, { staged_video: stagedVideo, video_bytes: metadata.size, metadata_json: JSON.stringify(metadata), error: null });
      await logMessage(item.batch_id, item.id, `[video #${item.ordinal}] Existing staged video validated successfully`);
      return { stageDir, stagedVideo, stagedThumbnail, stagedSubtitle, metadata, name };
    }

    // Legacy versions did not persist name/staged_video until remux succeeded. Recover the
    // title/assets from the provider page but explicitly skip the browser download for this file.
    updateItem(item.id, { status: 'downloading', stage_dir: stageDir, staged_video: stagedVideo, error: null });
    await logMessage(item.batch_id, item.id, `[video #${item.ordinal}] Found a staged source without saved metadata; recovering its title and remuxing it without downloading again`);
    const recovered = await downloadStreamingPlay({
      downloadUrl: item.source_url,
      embedUrl: item.embed_url,
      stageDir,
      existingVideoPath: stagedVideo,
      log: (message) => logMessage(item.batch_id, item.id, `[video #${item.ordinal}] ${message}`),
      shouldCancel: () => wasCancelRequested(item.batch_id),
      onDownloaded: async ({ videoPath, thumbnailPath, subtitlePath, name: discoveredName }) => {
        updateItem(item.id, {
          stage_dir: stageDir, staged_video: videoPath, staged_thumbnail: thumbnailPath,
          staged_subtitle: subtitlePath, ...(discoveredName ? { name: discoveredName } : {}), error: null
        });
        await logMessage(item.batch_id, item.id, `[video #${item.ordinal}] Saved staged source state before remux so retries can reuse it`);
      }
    });
    stagedVideo = recovered.videoPath;
    stagedThumbnail = recovered.thumbnailPath;
    stagedSubtitle = recovered.subtitlePath;
    metadata = recovered.metadata;
    name = recovered.name;
    updateItem(item.id, {
      status: 'registering', name, stage_dir: stageDir, staged_video: stagedVideo,
      staged_thumbnail: stagedThumbnail, staged_subtitle: stagedSubtitle,
      video_bytes: metadata.size, metadata_json: JSON.stringify(metadata), error: null
    });
    return { stageDir, stagedVideo, stagedThumbnail, stagedSubtitle, metadata, name };
  }

  updateItem(item.id, { status: 'downloading', stage_dir: stageDir, error: null });
  await logMessage(item.batch_id, item.id, `➡️ Start Downloading video #${item.ordinal}: ${item.source_url}`);
  const result = await downloadStreamingPlay({
    downloadUrl: item.source_url,
    embedUrl: item.embed_url,
    stageDir,
    log: (message) => logMessage(item.batch_id, item.id, `[video #${item.ordinal}] ${message}`),
    shouldCancel: () => wasCancelRequested(item.batch_id),
    onDownloaded: async ({ videoPath, thumbnailPath, subtitlePath, name: discoveredName }) => {
      updateItem(item.id, {
        stage_dir: stageDir, staged_video: videoPath, staged_thumbnail: thumbnailPath,
        staged_subtitle: subtitlePath, ...(discoveredName ? { name: discoveredName } : {}), error: null
      });
      await logMessage(item.batch_id, item.id, `[video #${item.ordinal}] Saved staged source state before remux so retries can reuse it`);
    }
  });
  stagedVideo = result.videoPath;
  stagedThumbnail = result.thumbnailPath;
  stagedSubtitle = result.subtitlePath;
  metadata = result.metadata;
  name = result.name;
  updateItem(item.id, {
    status: 'registering', name, stage_dir: stageDir, staged_video: stagedVideo,
    staged_thumbnail: stagedThumbnail, staged_subtitle: stagedSubtitle,
    video_bytes: metadata.size, metadata_json: JSON.stringify(metadata), error: null
  });
  return { stageDir, stagedVideo, stagedThumbnail, stagedSubtitle, metadata, name };
}

async function processItem(itemId) {
  const initial = getItem(itemId);
  if (!initial || activeItems.has(itemId)) return;
  activeItems.add(itemId);
  const batchId = initial.batch_id;
  try {
    let item = getItem(itemId);
    if (wasCancelRequested(batchId)) {
      updateItem(itemId, { status: 'queued' });
      return;
    }
    let apiResponse = item.api_response_json ? JSON.parse(item.api_response_json) : null;
    let name = item.name;
    let stagedVideo = item.staged_video;
    let stagedThumbnail = item.staged_thumbnail;
    let stagedSubtitle = item.staged_subtitle;
    let metadata = item.metadata_json ? JSON.parse(item.metadata_json) : null;
    let stageDir = item.stage_dir;

    // If a prior run already created the API record, check whether assets are already in final storage.
    if (!apiResponse) {
      const downloaded = await getOrDownload(item);
      ({ name, stagedVideo, stagedThumbnail, stagedSubtitle, metadata, stageDir } = downloaded);
      item = getItem(itemId);
      updateItem(itemId, { status: 'registering' });
      await logMessage(batchId, itemId, `[video #${item.ordinal}] Creating VideoCMS import record`);
      const { base, key } = apiConfig();
      const apiName = fitVideoCMSName(name, 128);
      if (apiName !== String(name ?? '').trim()) {
        await logMessage(batchId, itemId, `[video #${item.ordinal}] Video name exceeds VideoCMS's 128-character limit; using a trimmed name for registration. The downloaded media is being reused.`);
      }
      const thumbnailName = stagedThumbnail ? `thumbnail${path.extname(stagedThumbnail).toLowerCase() || '.jpg'}` : '';
      const subtitleName = stagedSubtitle ? `${safeFilename(apiName, 90)}.vtt` : '';
      const payload = {
        request_id: item.request_id,
        embed_url: item.embed_url,
        name: apiName,
        parent_folder_id: Number(process.env.PARENT_FOLDER_ID || 0),
        size: Number(metadata.size), duration: Number(metadata.duration),
        width: Number(metadata.width || 0), height: Number(metadata.height || 0),
        avg_frame_rate: Number(metadata.avgFrameRate || 0),
        quality_name: metadata.qualityName || '720p',
        ...(thumbnailName ? { thumbnail: thumbnailName } : {}),
        ...(subtitleName ? { subtitles: [{ name: apiName, lang: 'und', filename: subtitleName, type: 'vtt' }] } : {})
      };
      apiResponse = await apiRequest(`${base}/importer/imports`, key, { method: 'POST', body: JSON.stringify(payload) });
      updateItem(itemId, { api_response_json: JSON.stringify(apiResponse), link_uuid: apiResponse.link_uuid, file_uuid: apiResponse.file_uuid, status: 'placing' });
      await logMessage(batchId, itemId, `[video #${item.ordinal}] VideoCMS records created: LinkUUID ${apiResponse.link_uuid}`);
    }

    // Re-read persisted response after the create request; it is the retry-safe canonical destination.
    item = getItem(itemId);
    apiResponse = item.api_response_json ? JSON.parse(item.api_response_json) : apiResponse;
    stagedVideo = item.staged_video || stagedVideo;
    stagedThumbnail = item.staged_thumbnail || stagedThumbnail;
    stagedSubtitle = item.staged_subtitle || stagedSubtitle;
    name = item.name || name;
    updateItem(itemId, { status: 'placing' });

    const videoDestination = resolveMediaPath(apiResponse.video.relative_path);
    // Normalize either the already-placed destination or staged file before publishing it.
    // This also repairs retryable imports that were downloaded by a pre-remux importer version.
    const normalizeTarget = await fileExistsWithBytes(videoDestination) ? videoDestination : stagedVideo;
    if (!(await fileExistsWithBytes(normalizeTarget))) throw new Error('Downloaded video is missing from both staging and final storage; retry the download');
    await logMessage(batchId, itemId, `[video #${item.ordinal}] Validating/remuxing media before publishing`);
    metadata = await normalizeDownloadedVideo(
      normalizeTarget,
      (message) => logMessage(batchId, itemId, `[video #${item.ordinal}] ${message}`),
      () => wasCancelRequested(batchId)
    );
    updateItem(itemId, { video_bytes: metadata.size, metadata_json: JSON.stringify(metadata) });

    if (!(await fileExistsWithBytes(videoDestination))) {
      await logMessage(batchId, itemId, `[video #${item.ordinal}] Placing validated MP4 in VideoCMS storage`);
      await moveFile(stagedVideo, videoDestination);
    }

    if (apiResponse.thumbnail?.relative_path && stagedThumbnail) {
      await moveFile(stagedThumbnail, resolveMediaPath(apiResponse.thumbnail.relative_path));
      await logMessage(batchId, itemId, `[video #${item.ordinal}] ✅ Thumbnail downloaded and placed`);
    }
    const subtitleDestination = apiResponse.subtitles?.[0]?.relative_path;
    if (subtitleDestination && stagedSubtitle) {
      await moveFile(stagedSubtitle, resolveMediaPath(subtitleDestination));
      await logMessage(batchId, itemId, `[video #${item.ordinal}] ✅ Subtitle downloaded and placed`);
    }

    if (wasCancelRequested(batchId)) {
      updateItem(itemId, { status: 'queued' });
      return;
    }
    updateItem(itemId, { status: 'completing' });
    await logMessage(batchId, itemId, `[video #${item.ordinal}] Marking import ready in VideoCMS`);
    const { base, key } = apiConfig();
    const completed = await apiRequest(`${base}/importer/imports/${encodeURIComponent(apiResponse.import_key)}/complete`, key, {
      method: 'POST', body: JSON.stringify({ import_key: apiResponse.import_key })
    });
    updateItem(itemId, { status: 'completed', error: null, link_uuid: completed.link_uuid || apiResponse.link_uuid, file_uuid: completed.file_uuid || apiResponse.file_uuid });
    await logMessage(batchId, itemId, `[video #${item.ordinal}] ✅ All downloads completed - path: ${path.join(mediaRoot, apiResponse.file_uuid)}`);

    // Staged assets are no longer needed once VideoCMS has confirmed completion.
    // Cleanup is deliberately best-effort: a cleanup failure must not turn a successful import into a failed job.
    const completedStageDir = stageDir || item.stage_dir || path.join(stagingRoot, item.batch_id, String(item.ordinal).padStart(5, '0'));
    try {
      const cleaned = await cleanupCompletedStageDirectory(completedStageDir);
      if (cleaned) {
        updateItem(itemId, { stage_dir: null, staged_video: null, staged_thumbnail: null, staged_subtitle: null });
        await logMessage(batchId, itemId, `[video #${item.ordinal}] Cleaned staging files after successful import`);
      }
    } catch (cleanupError) {
      await logMessage(batchId, itemId, `[video #${item.ordinal}] ⚠️ Import succeeded, but staging cleanup failed: ${cleanError(cleanupError)}`);
    }
  } catch (error) {
    const message = cleanError(error);
    updateItem(itemId, { status: wasCancelRequested(batchId) ? 'queued' : 'failed', error: wasCancelRequested(batchId) ? null : message });
    if (!wasCancelRequested(batchId)) await logMessage(batchId, itemId, `[video #${initial.ordinal}] ❌ Failed: ${message}`);
  } finally {
    activeItems.delete(itemId);
    refreshBatch(batchId);
    events.emit(`batch:${batchId}`, { type: 'batch', batch: summarizeBatch(getBatch(batchId)) });
  }
}

export async function startBatch(batchId) {
  if (activeBatches.has(batchId)) return;
  const batch = getBatch(batchId);
  if (!batch) return;
  activeBatches.add(batchId);
  updateBatch(batchId, { status: 'running', cancel_requested: 0 });
  await logMessage(batchId, null, `Total videos in this batch: ${batch.total}`);
  try {
    while (!wasCancelRequested(batchId)) {
      const current = getBatch(batchId);
      const queued = (current?.items || []).filter((item) => item.status === 'queued');
      if (!queued.length) break;
      const slots = maxParallel - activeItems.size;
      if (slots <= 0) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
      const candidates = queued.slice(0, slots);
      await Promise.all(candidates.map((item) => processItem(item.id)));
    }
  } finally {
    activeBatches.delete(batchId);
    refreshBatch(batchId);
    if (wasCancelRequested(batchId)) {
      updateBatch(batchId, { status: 'cancelled' });
      await logMessage(batchId, null, 'Batch cancellation requested; unfinished items remain queued for resume.');
    }
    events.emit(`batch:${batchId}`, { type: 'batch', batch: summarizeBatch(getBatch(batchId)) });
  }
}

export function scheduleBatch(batchId) {
  setImmediate(() => startBatch(batchId).catch(async (error) => {
    await logMessage(batchId, null, `Batch worker error: ${cleanError(error)}`);
    refreshBatch(batchId);
  }));
}

export function cancelBatch(batchId) {
  updateBatch(batchId, { cancel_requested: 1 });
  events.emit(`batch:${batchId}`, { type: 'batch', batch: summarizeBatch(getBatch(batchId)) });
}

export function getPublicBatch(batchId) {
  return summarizeBatch(getBatch(batchId));
}

export function getBatchLogs(batchId, afterId = 0) {
  return db.prepare('SELECT * FROM logs WHERE batch_id = ? AND id > ? ORDER BY id LIMIT 2000').all(batchId, afterId);
}

export async function resumeQueuedBatches() {
  const rows = db.prepare(`SELECT DISTINCT b.id FROM batches b JOIN items i ON i.batch_id=b.id WHERE i.status='queued' AND b.cancel_requested=0`).all();
  for (const row of rows) scheduleBatch(row.id);
}
