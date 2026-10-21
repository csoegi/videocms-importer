import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const DOWNLOAD_BUTTON = 'a.dl-btn.d-flex';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function safeFilename(value, max = 100) {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, max);
  return cleaned || 'video';
}

function convertSrtToVtt(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const body = normalized
    .replace(/^\d+\s*\n(?=\d{2}:\d{2}:\d{2},\d{3}\s*-->)/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}\n`;
}

// StreamingPlay exposes both user-uploaded subtitles under /subtitle/ and
// storyboard thumbnail maps under /images/.../sprite.vtt. Only accept the
// canonical uploaded-subtitle route on a StreamingPlay host.
function isUserUploadedSubtitleUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (hostname !== 'streamingplay.biz' && !hostname.endsWith('.streamingplay.biz')) return false;

    const segments = decodeURIComponent(parsed.pathname).split('/').filter(Boolean);
    if (segments.some((segment) => segment.toLowerCase() === 'images')) return false;
    const subtitleIndex = segments.findIndex((segment) => segment.toLowerCase() === 'subtitle');
    const filename = segments.at(-1) || '';
    return subtitleIndex >= 0 && subtitleIndex < segments.length - 1 && /\.(?:vtt|srt)$/i.test(filename);
  } catch {
    return false;
  }
}

// Extra content-level defense: storyboard VTT cues contain thumbnail crop
// fragments (e.g. sprite.jpg#xywh=0,0,120,211), not subtitle text.
function isSpriteThumbnailVtt(text) {
  return /\.(?:jpe?g|png|webp)#xywh=\d+,\d+,\d+,\d+/i.test(text);
}

function waitForBrowserDownload(client, log, timeoutMs, shouldCancel) {
  let abortWait;
  const promise = new Promise((resolve, reject) => {
    let guid = null;
    let suggestedFilename = null;
    let finished = false;
    let lastProgressLogAt = 0;
    let lastProgressLoggedBytes = -1;
    const progressLogIntervalMs = Math.max(5000, Number(process.env.DOWNLOAD_PROGRESS_LOG_INTERVAL_MS || 30000));
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for browser download after ${Math.round(timeoutMs / 60000)} minutes`)), timeoutMs);
    const cancelPoll = setInterval(() => { if (shouldCancel?.()) finish(new Error('Batch cancellation requested')); }, 1000);
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      client.off('Browser.downloadWillBegin', onWillBegin);
      client.off('Browser.downloadProgress', onProgress);
      error ? reject(error) : resolve(value);
    };
    const onWillBegin = (event) => {
      guid = event.guid;
      suggestedFilename = event.suggestedFilename || 'download.mp4';
      log(`Browser download started: ${suggestedFilename}`);
    };
    const onProgress = (event) => {
      if (guid && event.guid !== guid) return;
      const received = Number(event.receivedBytes || 0);
      const total = Number(event.totalBytes || 0);
      const now = Date.now();
      const terminal = event.state !== 'inProgress';
      if (terminal || (received !== lastProgressLoggedBytes && now - lastProgressLogAt >= progressLogIntervalMs)) {
        const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
        log(terminal
          ? `Download ${event.state}: received ${mib(received)}${total > 0 ? ` of ${mib(total)}` : ''}`
          : `Download progress: received ${mib(received)}${total > 0 ? ` of ${mib(total)}` : ''}`);
        lastProgressLogAt = now;
        lastProgressLoggedBytes = received;
      }
      if (event.state === 'completed') finish(null, { guid: event.guid, suggestedFilename, receivedBytes: received, totalBytes: total });
      if (event.state === 'canceled') finish(new Error('Browser download was canceled'));
    };
    abortWait = () => finish(new Error('Download wait canceled'));
    client.on('Browser.downloadWillBegin', onWillBegin);
    client.on('Browser.downloadProgress', onProgress);
  });
  promise.cancel = () => abortWait?.();
  return promise;
}

async function waitForDownloadedFile(dir, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previousPath = null;
  let previousSize = -1;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.crdownload') || entry.name.endsWith('.tmp')) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.stat(fullPath);
      if (stat.size > 0 && stat.mtimeMs >= startedAt - 2000) candidates.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const current = candidates[0];
    if (current && current.fullPath === previousPath && current.size === previousSize) stableChecks++;
    else stableChecks = 0;
    if (current && stableChecks >= 3) return current.fullPath;
    previousPath = current?.fullPath || null;
    previousSize = current?.size ?? -1;
    await sleep(500);
  }
  throw new Error('The browser reported download completion, but no stable downloaded file was found');
}

async function probeVideo(filePath) {
  const executable = process.env.FFPROBE_PATH || 'ffprobe';
  const args = ['-v', 'error', '-show_entries', 'format=format_name,duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate', '-of', 'json', filePath];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`Unable to run ffprobe (${executable}): ${error.message}. Install FFprobe or set FFPROBE_PATH.`)));
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`ffprobe failed with exit code ${code}: ${stderr.trim().slice(0, 500)}`)));
  });
  const parsed = JSON.parse(output);
  const streams = parsed.streams || [];
  const video = streams.find((stream) => stream.codec_type === 'video') || {};
  const audio = streams.find((stream) => stream.codec_type === 'audio') || {};
  const duration = Number(parsed.format?.duration || 0);
  const size = Number(parsed.format?.size || (await fs.stat(filePath)).size);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine video duration for ${path.basename(filePath)}`);
  if (!video.codec_name) throw new Error(`No video stream found in ${path.basename(filePath)}`);
  const fps = String(video.avg_frame_rate || '0/1').split('/').map(Number);
  const avgFrameRate = fps[1] ? fps[0] / fps[1] : 0;
  const height = Number(video.height || 0);
  const width = Number(video.width || 0);
  return {
    duration, size, height, width, formatName: String(parsed.format?.format_name || ''),
    videoCodec: String(video.codec_name || ''), audioCodec: String(audio.codec_name || ''),
    avgFrameRate: Number.isFinite(avgFrameRate) ? avgFrameRate : 0,
    qualityName: `${height >= 100 ? height : 720}p`
  };
}

function isMP4Container(formatName) {
  // FFprobe reports ISO-BMFF files with names such as
  // "mov,mp4,m4a,3gp,3g2,mj2". A .mp4 filename alone is not sufficient.
  return String(formatName || '').split(',').some((name) => ['mp4', 'mov', 'm4a', '3gp', '3g2', 'mj2'].includes(name.trim().toLowerCase()));
}

async function runRemux(sourcePath, temporaryPath, log, shouldCancel) {
  const executable = process.env.FFMPEG_PATH || 'ffmpeg';
  const timeoutMs = Math.max(60_000, Number(process.env.REMUX_TIMEOUT_MS || 30 * 60 * 1000));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a?',
    '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', temporaryPath
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let finished = false;
    let killTimer = null;
    const stopChild = () => {
      if (finished) return;
      try { child.kill('SIGTERM'); } catch { /* process may already have exited */ }
      if (!killTimer) killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000);
    };
    const timer = setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);
    const cancelTimer = setInterval(() => {
      if (shouldCancel?.()) { cancelled = true; stopChild(); }
    }, 500);

    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(cancelTimer); if (killTimer) clearTimeout(killTimer);
      reject(new Error(`Unable to run FFmpeg (${executable}): ${error.message}. Install FFmpeg or set FFMPEG_PATH.`));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(cancelTimer); if (killTimer) clearTimeout(killTimer);
      if (cancelled) return reject(new Error('Batch cancellation requested during MP4 remux'));
      if (timedOut) return reject(new Error(`FFmpeg remux timed out after ${Math.round(timeoutMs / 60000)} minutes`));
      if (code !== 0) return reject(new Error(`FFmpeg remux failed (exit ${code ?? signal}): ${stderr.trim().slice(-1200) || 'no FFmpeg diagnostic available'}`));
      resolve();
    });
  });
}

async function remuxToMP4(filePath, log, shouldCancel) {
  const sourceMetadata = await probeVideo(filePath);
  if (isMP4Container(sourceMetadata.formatName)) {
    log(`Downloaded file is already MP4-compatible (${sourceMetadata.formatName}; ${sourceMetadata.videoCodec}${sourceMetadata.audioCodec ? `/${sourceMetadata.audioCodec}` : ''}); remux not needed`);
    return sourceMetadata;
  }

  if (shouldCancel?.()) throw new Error('Batch cancellation requested before MP4 remux');
  const temporaryPath = path.join(path.dirname(filePath), 'video.remuxing.mp4');
  const backupPath = path.join(path.dirname(filePath), 'video.source-original');
  await fs.rm(temporaryPath, { force: true });
  log(`Downloaded container is '${sourceMetadata.formatName || 'unknown'}' rather than MP4; remuxing to MP4 without re-encoding`);
  try {
    await runRemux(filePath, temporaryPath, log, shouldCancel);
    const remuxedMetadata = await probeVideo(temporaryPath);
    if (!isMP4Container(remuxedMetadata.formatName)) {
      throw new Error(`FFmpeg output is not an MP4 container (detected '${remuxedMetadata.formatName || 'unknown'}')`);
    }
    const durationDifference = Math.abs(remuxedMetadata.duration - sourceMetadata.duration);
    if (durationDifference > Math.max(3, sourceMetadata.duration * 0.001)) {
      throw new Error(`Remux validation failed: duration changed from ${sourceMetadata.duration.toFixed(2)}s to ${remuxedMetadata.duration.toFixed(2)}s`);
    }
    if (!remuxedMetadata.videoCodec) throw new Error('Remux validation failed: output contains no video stream');

    // Validate the new file before replacing the staged source. If replacement fails,
    // restore the source so a retry does not lose the successfully downloaded payload.
    await fs.rm(backupPath, { force: true });
    await fs.rename(filePath, backupPath);
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.rename(backupPath, filePath).catch(() => {});
      throw error;
    }
    await fs.rm(backupPath, { force: true });
    const finalStat = await fs.stat(filePath);
    remuxedMetadata.size = finalStat.size;
    log(`✅ MP4 remux complete (stream copy, no re-encoding): ${sourceMetadata.size} -> ${finalStat.size} bytes; ${remuxedMetadata.formatName}`);
    return remuxedMetadata;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function normalizeDownloadedVideo(filePath, log = () => {}, shouldCancel = () => false) {
  return remuxToMP4(filePath, log, shouldCancel);
}

async function fetchAsset(url, { referer, cookies, userAgent, timeoutMs = 30000 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const cookieHeader = (cookies || []).filter((cookie) => {
    try { return new URL(url).hostname === cookie.domain.replace(/^\./, '') || new URL(url).hostname.endsWith(`.${cookie.domain.replace(/^\./, '')}`); }
    catch { return false; }
  }).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'user-agent': userAgent || 'Mozilla/5.0', ...(referer ? { referer } : {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) }, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) return null;
    const extension = contentType.includes('webp') ? '.webp' : contentType.includes('png') ? '.png' : contentType.includes('gif') ? '.gif' : contentType.includes('avif') ? '.avif' : '.jpg';
    return { bytes, extension };
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}

export async function downloadStreamingPlay({ downloadUrl, embedUrl, stageDir, log, shouldCancel }) {
  await fs.mkdir(stageDir, { recursive: true });
  const videoPath = path.join(stageDir, 'video.mp4');
  const thumbPath = path.join(stageDir, 'thumbnail.asset');
  const subtitlePath = path.join(stageDir, 'subtitle.vtt');
  const browserOptions = { headless: String(process.env.BROWSER_HEADLESS || 'true').toLowerCase() !== 'false' };
  if (String(process.env.BROWSER_NO_SANDBOX || 'false').toLowerCase() === 'true') browserOptions.args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (process.env.BROWSER_EXECUTABLE_PATH) browserOptions.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(browserOptions);
  let stagedThumbnail = null;
  let stagedSubtitle = null;
  let downloadedVideo = false;
  let metadata = null;
  let name = '';
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const subtitlePromises = [];
    const imageResponses = [];
    let subtitleSaved = false;
    page.on('response', (response) => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      if (response.ok() && contentType.toLowerCase().startsWith('image/') && /(?:deliver\.streamingplay\.biz\/images\/|thumbnail)/i.test(responseUrl)) {
        imageResponses.push({ response, url: responseUrl, contentType });
      }
      if (subtitleSaved || !response.ok()) return;
      // Ignore /images/.../sprite.vtt even if served as text/vtt; it is a
      // thumbnail storyboard, not a user-uploaded subtitle.
      if (!isUserUploadedSubtitleUrl(responseUrl)) return;
      const promise = (async () => {
        try {
          const bytes = await response.buffer();
          if (!bytes.length || bytes.length > 20 * 1024 * 1024 || subtitleSaved) return;
          let text = bytes.toString('utf8');
          if (/\.srt(?:$|[?#])/i.test(responseUrl) || !/^WEBVTT(?:\s|$)/m.test(text)) text = convertSrtToVtt(text);
          if (!/^WEBVTT(?:\s|$)/m.test(text) || isSpriteThumbnailVtt(text)) return;
          await fs.writeFile(subtitlePath, text, 'utf8');
          subtitleSaved = true;
          stagedSubtitle = subtitlePath;
          log('User-uploaded subtitle captured');
        } catch { /* A failed optional subtitle response must not fail the video import. */ }
      })();
      subtitlePromises.push(promise);
    });

    log(`Opening embed page: ${embedUrl}`);
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(Number(process.env.PROVIDER_CAPTURE_WINDOW_MS || 12000));
    if (shouldCancel()) throw new Error('Batch cancellation requested');

    const pageAssets = await page.evaluate(() => {
      const meta = (selector) => document.querySelector(selector)?.content || '';
      const video = document.querySelector('video');
      const tracks = [...document.querySelectorAll('video track[src], track[src]')].map((track) => ({
        src: track.src || track.getAttribute('src') || '',
        lang: track.srclang || '',
        label: track.label || ''
      }));
      const imageCandidates = [...document.images].map((img) => ({
        url: img.currentSrc || img.src || img.dataset.src || img.dataset.original || img.dataset.lazySrc || '',
        area: (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0)
      })).filter((img) => /^https?:\/\//i.test(img.url));
      const image = imageCandidates.sort((a, b) => {
        const aThumb = /thumbnail/i.test(a.url) ? 1 : 0;
        const bThumb = /thumbnail/i.test(b.url) ? 1 : 0;
        return bThumb - aThumb || b.area - a.area;
      })[0];
      const backgroundImage = [...document.querySelectorAll('[style*="background-image"]')]
        .map((el) => el.style.backgroundImage.match(/url\([\"']?(.*?)[\"']?\)/i)?.[1] || '')
        .find((url) => /^https?:\/\//i.test(url)) || '';
      return {
        thumbnailUrl: meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]') || video?.poster || image?.url || backgroundImage || '',
        tracks
      };
    });
    const uploadedSubtitleTrack = (pageAssets.tracks || []).find((track) => isUserUploadedSubtitleUrl(track.src));
    pageAssets.subtitleUrl = uploadedSubtitleTrack?.src || '';
    if ((pageAssets.tracks || []).length > 0 && !pageAssets.subtitleUrl) {
      log('Ignoring non-uploaded subtitle track(s), including sprite thumbnail tracks');
    }
    const cookies = await page.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent);

    // Prefer the provider's explicit thumbnail URL, then fall back to image requests observed
    // while the embed page loaded. StreamingPlay can render the thumbnail without exposing it
    // in og:image, video.poster, or a normal img[src] attribute.
    const observedThumbnail = [...imageResponses].sort((a, b) => {
      const aPreferred = /thumbnail\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(a.url) ? 1 : 0;
      const bPreferred = /thumbnail\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(b.url) ? 1 : 0;
      return bPreferred - aPreferred;
    })[0];
    const thumbnailUrl = pageAssets.thumbnailUrl || observedThumbnail?.url || '';
    if (thumbnailUrl) {
      log('Start downloading thumbnail');
      let asset = await fetchAsset(thumbnailUrl, { referer: embedUrl, cookies, userAgent });
      if (!asset) {
        const observed = imageResponses.find((entry) => entry.url === thumbnailUrl) || observedThumbnail;
        if (observed) {
          try {
            const bytes = await observed.response.buffer();
            const contentType = observed.contentType.toLowerCase();
            const extension = contentType.includes('webp') ? '.webp' : contentType.includes('png') ? '.png' : contentType.includes('gif') ? '.gif' : contentType.includes('avif') ? '.avif' : '.jpg';
            if (bytes.length > 0 && bytes.length <= 15 * 1024 * 1024) asset = { bytes, extension };
          } catch { /* The response body may no longer be available; keep this optional. */ }
        }
      }
      if (asset) {
        const extPath = path.join(stageDir, `thumbnail${asset.extension}`);
        await fs.writeFile(extPath, asset.bytes);
        stagedThumbnail = extPath;
        log(`Thumbnail downloaded (${asset.bytes.length} bytes)`);
      } else log('Thumbnail URL was found but could not be downloaded; continuing without one');
    } else log('No thumbnail URL found in page metadata or image requests; continuing without one');

    if (pageAssets.subtitleUrl && isUserUploadedSubtitleUrl(pageAssets.subtitleUrl) && !subtitleSaved) {
      log('Start downloading user-uploaded subtitle');
      try {
        const subtitleHost = new URL(pageAssets.subtitleUrl).hostname;
        const subtitleCookie = cookies.filter((cookie) => subtitleHost === cookie.domain.replace(/^\./, '') || subtitleHost.endsWith(`.${cookie.domain.replace(/^\./, '')}`)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
        const subtitleResponse = await fetch(pageAssets.subtitleUrl, { headers: { referer: embedUrl, 'user-agent': userAgent, ...(subtitleCookie ? { cookie: subtitleCookie } : {}) }, signal: AbortSignal.timeout(30000) });
        if (subtitleResponse.ok) {
          let text = await subtitleResponse.text();
          if (/\.srt(?:$|[?#])/i.test(pageAssets.subtitleUrl) || !/^WEBVTT(?:\s|$)/m.test(text)) text = convertSrtToVtt(text);
          if (/^WEBVTT(?:\s|$)/m.test(text) && !isSpriteThumbnailVtt(text)) {
            await fs.writeFile(subtitlePath, text, 'utf8');
            stagedSubtitle = subtitlePath;
            subtitleSaved = true;
            log('User-uploaded subtitle downloaded');
          }
        }
      } catch { /* optional subtitle */ }
    }
    await Promise.allSettled(subtitlePromises);
    if (!stagedSubtitle) log('No downloadable subtitle found; continuing without one');

    log('Opening download page to read video name');
    await page.goto(downloadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    name = await page.$eval('.head__title span', (element) => element.textContent.trim()).catch(() => '');
    if (!name) throw new Error('Could not read video name from .head__title span on the download page');
    name = name.trim();
    log(`Video name: ${name}`);

    // The subtitle's physical staging filename should match the name registered with VideoCMS.
    if (stagedSubtitle) {
      const namedSubtitlePath = path.join(stageDir, `${safeFilename(name, 90)}.vtt`);
      if (path.resolve(stagedSubtitle) !== path.resolve(namedSubtitlePath)) {
        await fs.rename(stagedSubtitle, namedSubtitlePath);
        stagedSubtitle = namedSubtitlePath;
      }
    }

    if (shouldCancel()) throw new Error('Batch cancellation requested');
    const client = await page.createCDPSession();
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stageDir, eventsEnabled: true });

    // StreamingPlay initially renders a placeholder anchor with href=about:blank.
    // The real MP4 anchor is added/updated asynchronously and has the d-flex class,
    // a real HTTP(S) URL, and a populated quality label. Wait for that state before
    // clicking so we never trigger the dummy button.
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('a.dl-btn.d-flex')].some((element) => {
        const href = element.href || '';
        const label = element.querySelector('.text-lg')?.textContent?.trim() || '';
        try {
          const url = new URL(href, window.location.href);
          return /^https?:$/.test(url.protocol) && url.href !== 'about:blank' &&
            /\/download\//i.test(url.pathname) && Boolean(label);
        } catch {
          return false;
        }
      });
    }, { timeout: 30000 });
    await page.waitForSelector(DOWNLOAD_BUTTON, { visible: true, timeout: 30000 });

    const startedAt = Date.now();
    log('Start downloading video');
    const downloadDone = waitForBrowserDownload(client, log, Number(process.env.DOWNLOAD_TIMEOUT_MS || 3600000), shouldCancel);
    downloadDone.catch(() => {});
    try {
      // Click the generated real button, not the initial about:blank placeholder.
      await page.click(DOWNLOAD_BUTTON);
      await downloadDone;
    } catch (error) {
      downloadDone.cancel?.();
      await downloadDone.catch(() => {});
      throw error;
    }
    const rawPath = await waitForDownloadedFile(stageDir, startedAt, Number(process.env.DOWNLOAD_TIMEOUT_MS || 3600000));
    if (path.resolve(rawPath) !== path.resolve(videoPath)) {
      await fs.rename(rawPath, videoPath);
    }
    downloadedVideo = true;
    const stat = await fs.stat(videoPath);
    log(`Video downloaded - Received: ${stat.size} Total: ${stat.size}`);
    metadata = await remuxToMP4(videoPath, log, shouldCancel);
    const finalStat = await fs.stat(videoPath);
    metadata.size = finalStat.size;
    metadata.qualityName = `${metadata.height >= 100 ? metadata.height : 720}p`;
    log(`Validated MP4 metadata: ${metadata.width}x${metadata.height}, ${metadata.duration.toFixed(2)}s, ${finalStat.size} bytes (${metadata.formatName}; ${metadata.videoCodec}${metadata.audioCodec ? `/${metadata.audioCodec}` : ''})`);
    return { name: name.trim(), videoPath, thumbnailPath: stagedThumbnail, subtitlePath: stagedSubtitle, metadata };
  } catch (error) {
    if (downloadedVideo) log('Video file retained in staging for retry');
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}
