import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import rateLimit from 'express-rate-limit';
import { createBatch, getBatch, listBatches, retryFailedItems } from './store.js';
import { cancelBatch, events, getBatchLogs, getPublicBatch, resumeQueuedBatches, scheduleBatch } from './worker.js';

const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3085);
const username = process.env.WEB_USERNAME || 'admin';
const password = process.env.WEB_PASSWORD || '';
const maxBatchSize = Math.max(1, Number(process.env.MAX_BATCH_SIZE || 500));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

if (!password || password === 'change-me' || password === 'replace-with-a-long-random-password') {
  console.error('Refusing to start: set a strong WEB_PASSWORD in .env before running the importer UI.');
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (match) {
    let decoded = '';
    try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { /* invalid auth */ }
    const split = decoded.indexOf(':');
    const suppliedUser = split >= 0 ? decoded.slice(0, split) : '';
    const suppliedPass = split >= 0 ? decoded.slice(split + 1) : '';
    if (safeEqual(suppliedUser, username) && safeEqual(suppliedPass, password)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="VideoCMS Importer", charset="UTF-8"');
  return res.status(401).send('Authentication required');
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.static(path.resolve('public'), { index: false, dotfiles: 'deny' }));

function normalizeDownloadUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw new Error(`Invalid URL: ${String(value).slice(0, 120)}`); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only HTTP/HTTPS StreamingPlay URLs are accepted');
  if (parsed.username || parsed.password || parsed.port) throw new Error('Credentials and custom ports are not allowed in StreamingPlay URLs');
  const hostname = parsed.hostname.toLowerCase();
  if (!['streamingplay.biz', 'www.streamingplay.biz'].includes(hostname)) throw new Error('Only streamingplay.biz URLs are accepted');
  const match = /^\/download\/([A-Za-z0-9_-]+)\/?$/.exec(parsed.pathname);
  if (!match) throw new Error('Expected a URL in the form https://streamingplay.biz/download/VIDEO_ID');
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = `/download/${match[1]}`;
  const downloadUrl = `https://streamingplay.biz${parsed.pathname}`;
  const embedUrl = `https://streamingplay.biz/embed/${match[1]}`;
  return { downloadUrl, embedUrl };
}

function parseTextUrls(text) {
  const raw = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  return raw.map((line) => {
    // Permit a single-column CSV pasted into the textarea, but not arbitrary comma-separated metadata.
    const candidate = line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1).replaceAll('""', '"') : line;
    return normalizeDownloadUrl(candidate);
  });
}

function parseCsvUrls(buffer) {
  const rows = parseCsv(buffer.toString('utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  const values = [];
  for (const row of rows) {
    if (!row.length) continue;
    const first = String(row[0] || '').trim();
    if (/^(url|download_url|download url|streamingplay_url)$/i.test(first)) continue;
    const candidate = row.map((cell) => String(cell || '').trim()).find((cell) => /https?:\/\//i.test(cell));
    if (candidate) values.push(candidate);
  }
  return values.map(normalizeDownloadUrl);
}

function validateAndDedupe(entries) {
  if (!entries.length) throw new Error('Enter at least one download URL or upload a CSV');
  if (entries.length > maxBatchSize) throw new Error(`Batch contains ${entries.length} URLs; maximum is ${maxBatchSize}`);
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    if (seen.has(entry.downloadUrl)) continue;
    seen.add(entry.downloadUrl);
    unique.push(entry);
  }
  return unique;
}

const createBatchLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
app.get('/', (_req, res) => res.sendFile(path.resolve('public/index.html')));
app.get('/api/batches', (_req, res) => res.json({ batches: listBatches(50) }));

app.post('/api/batches', createBatchLimiter, (req, res) => {
  try {
    const entries = validateAndDedupe(parseTextUrls(req.body.urls));
    const batch = createBatch(entries);
    scheduleBatch(batch.id);
    return res.status(202).json({ batch: getPublicBatch(batch.id), deduplicated: entries.length });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.post('/api/batches/csv', createBatchLimiter, upload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV file first' });
    const entries = validateAndDedupe(parseCsvUrls(req.file.buffer));
    const batch = createBatch(entries);
    scheduleBatch(batch.id);
    return res.status(202).json({ batch: getPublicBatch(batch.id), deduplicated: entries.length });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.get('/api/batches/:id', (req, res) => {
  const batch = getPublicBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  return res.json({ batch });
});

app.get('/api/batches/:id/logs', (req, res) => {
  if (!getBatch(req.params.id)) return res.status(404).json({ error: 'Batch not found' });
  const after = Math.max(0, Number(req.query.after || 0));
  return res.json({ logs: getBatchLogs(req.params.id, after) });
});

app.get('/api/batches/:id/events', (req, res) => {
  if (!getBatch(req.params.id)) return res.status(404).end();
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let lastLogId = 0;
  let replaying = true;
  const pending = [];
  const eventName = `batch:${req.params.id}`;
  const sendPayload = (payload) => {
    if (payload.type === 'log') {
      if (payload.log.id <= lastLogId) return;
      lastLogId = payload.log.id;
      res.write(`event: log\ndata: ${JSON.stringify(payload.log)}\n\n`);
    } else if (payload.type === 'batch') res.write(`event: batch\ndata: ${JSON.stringify(payload.batch)}\n\n`);
  };
  const listener = (payload) => {
    if (replaying) pending.push(payload);
    else sendPayload(payload);
  };
  events.on(eventName, listener);
  const initialLogs = getBatchLogs(req.params.id, 0);
  for (const log of initialLogs) sendPayload({ type: 'log', log });
  sendPayload({ type: 'batch', batch: getPublicBatch(req.params.id) });
  replaying = false;
  pending.sort((a, b) => (a.type === 'log' ? a.log.id : Number.MAX_SAFE_INTEGER) - (b.type === 'log' ? b.log.id : Number.MAX_SAFE_INTEGER));
  for (const payload of pending) sendPayload(payload);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); events.off(eventName, listener); });
});

app.post('/api/batches/:id/retry', (req, res) => {
  const existing = getBatch(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Batch not found' });
  const retried = retryFailedItems(req.params.id);
  if (!retried.items.some((item) => item.status === 'queued')) return res.status(400).json({ error: 'No failed items to retry' });
  scheduleBatch(req.params.id);
  return res.status(202).json({ batch: getPublicBatch(req.params.id) });
});

app.post('/api/batches/:id/cancel', (req, res) => {
  if (!getBatch(req.params.id)) return res.status(404).json({ error: 'Batch not found' });
  cancelBatch(req.params.id);
  return res.status(202).json({ batch: getPublicBatch(req.params.id) });
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.use((error, _req, res, _next) => {
  const message = error?.code === 'LIMIT_FILE_SIZE' ? 'CSV file exceeds the 5 MB limit' : String(error?.message || 'Unexpected error');
  res.status(400).json({ error: message.slice(0, 500) });
});

const server = app.listen(port, host, async () => {
  console.log(`VideoCMS Importer listening on http://${host}:${port}`);
  console.log(`Media root: ${path.resolve(process.env.MEDIA_ROOT || '/data/media/videos')}`);
  await resumeQueuedBatches();
});

async function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
