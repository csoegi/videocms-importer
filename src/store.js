import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const dbPath = path.resolve(process.env.DB_PATH || './data/importer.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  embed_url TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  name TEXT,
  stage_dir TEXT,
  staged_video TEXT,
  staged_thumbnail TEXT,
  staged_subtitle TEXT,
  video_bytes INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  api_response_json TEXT,
  link_uuid TEXT,
  file_uuid TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, ordinal)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  item_id TEXT,
  created_at TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_batch_status ON items(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_logs_batch_id ON logs(batch_id, id);
`);

const now = () => new Date().toISOString();

export function createBatch(urls) {
  const batchId = randomUUID();
  const timestamp = now();
  const createBatchStmt = db.prepare('INSERT INTO batches (id, created_at, updated_at, status, total) VALUES (?, ?, ?, ?, ?)');
  const createItemStmt = db.prepare(`INSERT INTO items (id, batch_id, ordinal, source_url, embed_url, request_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`);
  const tx = db.transaction(() => {
    createBatchStmt.run(batchId, timestamp, timestamp, 'queued', urls.length);
    urls.forEach((entry, index) => createItemStmt.run(randomUUID(), batchId, index + 1, entry.downloadUrl, entry.embedUrl, randomUUID(), timestamp, timestamp));
  });
  tx();
  return getBatch(batchId);
}

export function getBatch(id) {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  if (!batch) return null;
  batch.items = db.prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY ordinal').all(id);
  return batch;
}

export function listBatches(limit = 30) {
  return db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM items i WHERE i.batch_id=b.id AND i.status='completed') AS completed,
    (SELECT COUNT(*) FROM items i WHERE i.batch_id=b.id AND i.status='failed') AS failed
    FROM batches b ORDER BY b.created_at DESC LIMIT ?`).all(limit);
}

export function getItem(id) { return db.prepare('SELECT * FROM items WHERE id = ?').get(id); }

export function updateItem(id, fields) {
  const allowed = new Set(['status','name','stage_dir','staged_video','staged_thumbnail','staged_subtitle','video_bytes','metadata_json','api_response_json','link_uuid','file_uuid','error']);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const sql = `UPDATE items SET ${entries.map(([key]) => `${key} = @${key}`).join(', ')}, updated_at = @updated_at WHERE id = @id`;
  db.prepare(sql).run({ ...Object.fromEntries(entries), updated_at: now(), id });
  refreshBatch(getItem(id).batch_id);
}

export function updateBatch(id, fields) {
  const allowed = new Set(['status','cancel_requested']);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  db.prepare(`UPDATE batches SET ${entries.map(([key]) => `${key} = @${key}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...Object.fromEntries(entries), updated_at: now(), id });
}

export function refreshBatch(batchId) {
  const counts = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
    SUM(CASE WHEN status IN ('downloading','registering','placing','completing') THEN 1 ELSE 0 END) active,
    SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued
    FROM items WHERE batch_id = ?`).get(batchId);
  let status = 'queued';
  if (counts.active > 0) status = 'running';
  else if (counts.queued > 0) status = counts.completed + counts.failed > 0 ? 'running' : 'queued';
  else if (counts.failed > 0 && counts.completed > 0) status = 'completed_with_errors';
  else if (counts.failed > 0) status = 'failed';
  else status = 'completed';
  db.prepare('UPDATE batches SET status = ?, completed = ?, failed = ?, updated_at = ? WHERE id = ?')
    .run(status, counts.completed || 0, counts.failed || 0, now(), batchId);
}

export function retryFailedItems(batchId) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE items SET status='queued', error=NULL, updated_at=? WHERE batch_id=? AND status='failed'`).run(now(), batchId);
    db.prepare(`UPDATE batches SET status='queued', cancel_requested=0, updated_at=? WHERE id=?`).run(now(), batchId);
  });
  tx();
  return getBatch(batchId);
}

export function addLog(batchId, itemId, message) {
  const timestamp = now();
  db.prepare('INSERT INTO logs (batch_id, item_id, created_at, message) VALUES (?, ?, ?, ?)').run(batchId, itemId || null, timestamp, message);
  return { id: Number(db.prepare('SELECT last_insert_rowid() AS id').get().id), created_at: timestamp, batch_id: batchId, item_id: itemId || null, message };
}

export function getLogs(batchId, afterId = 0, limit = 1000) {
  return db.prepare('SELECT * FROM logs WHERE batch_id = ? AND id > ? ORDER BY id LIMIT ?').all(batchId, afterId, limit);
}

export function wasCancelRequested(batchId) {
  return Boolean(db.prepare('SELECT cancel_requested FROM batches WHERE id=?').get(batchId)?.cancel_requested);
}

// Recover jobs interrupted by a process restart. The worker resumes from persisted stage files/API response.
db.prepare(`UPDATE items SET status='queued', updated_at=? WHERE status IN ('downloading','registering','placing','completing')`).run(now());
db.prepare(`UPDATE batches SET status='queued', cancel_requested=0, updated_at=? WHERE status='running'`).run(now());
