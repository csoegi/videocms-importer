import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

const mediaRoot = path.resolve(process.env.MEDIA_ROOT || '/data/media/videos');
const stagingRoot = path.resolve(process.env.STAGING_ROOT || path.join(path.dirname(mediaRoot), '.videocms-importer-staging'));
const dbPath = path.resolve(process.env.DB_PATH || './data/importer.sqlite');
const deleteMode = process.argv.includes('--delete');
const daysArgIndex = process.argv.indexOf('--older-than-days');
const configuredDays = Number(process.env.STAGING_CLEANUP_RETENTION_DAYS || 30);
const days = daysArgIndex >= 0 ? Number(process.argv[daysArgIndex + 1]) : configuredDays;

if (!Number.isFinite(days) || days < 1) {
  console.error('Invalid retention period. --older-than-days must be a number >= 1.');
  process.exit(2);
}

function withinStagingRoot(candidatePath, minimumDepth = 2) {
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(stagingRoot, resolved);
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.length >= minimumDepth && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directorySizeBytes(targetPath) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(targetPath, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    let stat;
    try { stat = await fs.lstat(childPath); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isDirectory() && !stat.isSymbolicLink()) total += await directorySizeBytes(childPath);
    else total += stat.size;
  }
  return total;
}

function humanBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let bytes = value;
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

async function main() {
  let db;
  try {
    await fs.access(dbPath);
    await fs.access(stagingRoot);
  } catch (error) {
    console.error(`Cannot access DB_PATH or STAGING_ROOT: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const failedItems = db.prepare(`
      SELECT id, batch_id, ordinal, status, updated_at, stage_dir
      FROM items
      WHERE status = 'failed'
      ORDER BY updated_at ASC
    `).all();
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const candidates = [];
    let skippedRecent = 0;
    let skippedUnsafe = 0;

    for (const item of failedItems) {
      const updatedAtMs = Date.parse(item.updated_at || '');
      if (!Number.isFinite(updatedAtMs) || updatedAtMs > cutoffMs) { skippedRecent++; continue; }
      const candidate = path.resolve(item.stage_dir || path.join(stagingRoot, item.batch_id, String(item.ordinal).padStart(5, '0')));
      if (!withinStagingRoot(candidate)) { skippedUnsafe++; console.warn(`SKIP (outside staging root): item=${item.id}, path=${candidate}`); continue; }
      let stat;
      try { stat = await fs.lstat(candidate); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        console.warn(`SKIP (not a regular directory): ${candidate}`);
        continue;
      }
      const bytes = await directorySizeBytes(candidate);
      candidates.push({ ...item, candidate, bytes });
    }

    console.log(`Staging root: ${stagingRoot}`);
    console.log(`Database: ${dbPath}`);
    console.log(`Policy: failed jobs older than ${days} day(s); mode: ${deleteMode ? 'DELETE' : 'DRY RUN'}`);
    console.log(`Failed jobs scanned: ${failedItems.length}; recent/undated skipped: ${skippedRecent}; unsafe paths skipped: ${skippedUnsafe}`);

    let totalBytes = 0;
    for (const item of candidates) {
      totalBytes += item.bytes;
      const age = Math.max(0, Math.floor((Date.now() - Date.parse(item.updated_at)) / (24 * 60 * 60 * 1000)));
      if (deleteMode) {
        await fs.rm(item.candidate, { recursive: true, force: true });
        const parent = path.dirname(item.candidate);
        if (withinStagingRoot(parent, 1)) {
          await fs.rmdir(parent).catch((error) => {
            if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
          });
        }
        console.log(`DELETED ${humanBytes(item.bytes)} | failed ${age} day(s) | batch=${item.batch_id} item #${item.ordinal} | ${item.candidate}`);
      } else {
        console.log(`WOULD DELETE ${humanBytes(item.bytes)} | failed ${age} day(s) | batch=${item.batch_id} item #${item.ordinal} | ${item.candidate}`);
      }
    }
    console.log(`${deleteMode ? 'Deleted' : 'Eligible'} directories: ${candidates.length}; total size: ${humanBytes(totalBytes)}`);
    if (!deleteMode) console.log('No files were changed. Add --delete only after reviewing this list.');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`Staging cleanup failed: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
