const $ = (selector) => document.querySelector(selector);
let selectedBatchId = null;
let eventSource = null;
let lastLogId = 0;
let currentBatch = null;

const escapeText = (value) => String(value ?? '');
const statusLabel = (value) => String(value || 'unknown').replaceAll('_', ' ');
const formatDate = (value) => { try { return new Date(value).toLocaleString(); } catch { return value || ''; } };

function showError(message) {
  const el = $('#form-error');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}
function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.originalText ||= button.textContent;
  button.textContent = busy ? 'Starting…' : button.dataset.originalText;
}
function logLine(message) {
  const output = $('#log-output');
  if (output.textContent === 'Logs will appear here when a batch starts.') output.textContent = '';
  output.append(document.createTextNode(`${message}\n`));
  output.scrollTop = output.scrollHeight;
}
function renderBatchList(batches) {
  const root = $('#batch-list');
  root.replaceChildren();
  if (!batches.length) { root.innerHTML = '<div class="empty">No batches yet.</div>'; return; }
  for (const batch of batches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `batch-row${batch.id === selectedBatchId ? ' selected' : ''}`;
    const top = document.createElement('div'); top.className = 'batch-row-top';
    const name = document.createElement('span'); name.className = 'batch-name'; name.textContent = `Batch ${batch.id.slice(0, 8)}`;
    const status = document.createElement('span'); status.className = `status ${batch.status}`; status.textContent = statusLabel(batch.status);
    top.append(name, status);
    const date = document.createElement('div'); date.className = 'batch-date'; date.textContent = formatDate(batch.created_at);
    const stats = document.createElement('div'); stats.className = 'batch-stats';
    stats.textContent = `${batch.completed || 0} completed · ${batch.failed || 0} failed · ${batch.total} total`;
    button.append(top, date, stats);
    button.addEventListener('click', () => selectBatch(batch.id));
    root.append(button);
  }
}
async function refreshBatches() {
  const response = await fetch('/api/batches');
  if (!response.ok) return;
  const data = await response.json();
  renderBatchList(data.batches || []);
}
function renderDetails(batch) {
  if (!batch) return;
  currentBatch = batch;
  $('#detail-title').textContent = `Batch ${batch.id.slice(0, 8)}`;
  $('#detail-subtitle').textContent = `${formatDate(batch.created_at)} · ${batch.total} videos`;
  const done = Number(batch.completed || 0);
  const failed = Number(batch.failed || 0);
  const pct = batch.total ? Math.round(((done + failed) / batch.total) * 100) : 0;
  $('#progress-label').textContent = statusLabel(batch.status);
  $('#progress-count').textContent = `${done + failed} / ${batch.total}`;
  $('#progress-bar').style.width = `${pct}%`;
  $('#retry-batch').classList.toggle('hidden', (failed === 0 && batch.status !== 'cancelled') || ['running','queued'].includes(batch.status));
  $('#retry-batch').textContent = batch.status === 'cancelled' ? 'Resume batch' : 'Retry failed';
  $('#cancel-batch').classList.toggle('hidden', !['running','queued'].includes(batch.status));
  const items = $('#item-list'); items.replaceChildren();
  for (const item of (batch.items || [])) {
    const row = document.createElement('div'); row.className = 'item-row';
    const number = document.createElement('span'); number.className = 'item-number'; number.textContent = `Video #${item.ordinal}`;
    const title = document.createElement('span'); title.className = 'item-title'; title.textContent = item.name || item.source_url;
    title.title = item.source_url;
    const status = document.createElement('span'); status.className = `status ${item.status}`; status.textContent = statusLabel(item.status);
    row.append(number, title, status);
    if (item.error) { const error = document.createElement('span'); error.className = 'item-error'; error.textContent = item.error; error.title = item.error; row.append(error); }
    items.append(row);
  }
}
function connectEvents(batchId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/batches/${encodeURIComponent(batchId)}/events`);
  eventSource.addEventListener('log', (event) => {
    const log = JSON.parse(event.data);
    if (log.id <= lastLogId) return;
    lastLogId = log.id;
    logLine(`[${formatDate(log.created_at)}] ${log.message}`);
  });
  eventSource.addEventListener('batch', (event) => {
    const batch = JSON.parse(event.data);
    if (!batch) return;
    renderDetails(batch);
    if (['completed','completed_with_errors','failed','cancelled'].includes(batch.status)) {
      refreshBatches().catch(() => {});
      eventSource?.close();
    }
  });
  eventSource.onerror = () => { /* EventSource reconnects automatically. */ };
}
async function selectBatch(id) {
  selectedBatchId = id;
  lastLogId = 0;
  $('#log-output').textContent = '';
  const response = await fetch(`/api/batches/${encodeURIComponent(id)}`);
  if (!response.ok) return;
  const { batch } = await response.json();
  renderDetails(batch);
  renderBatchList((await (await fetch('/api/batches')).json()).batches || []);
  const logsResponse = await fetch(`/api/batches/${encodeURIComponent(id)}/logs`);
  const logsData = await logsResponse.json();
  for (const log of logsData.logs || []) {
    lastLogId = Math.max(lastLogId, log.id);
    logLine(`[${formatDate(log.created_at)}] ${log.message}`);
  }
  connectEvents(id);
}
async function submitJsonForm(form, button) {
  showError(''); setBusy(button, true);
  try {
    const response = await fetch('/api/batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: $('#urls').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create batch');
    $('#urls').value = '';
    await refreshBatches();
    await selectBatch(data.batch.id);
  } catch (error) { showError(error.message); }
  finally { setBusy(button, false); }
}
$('#paste-form').addEventListener('submit', (event) => { event.preventDefault(); submitJsonForm(event.currentTarget, $('#start-paste')); });
$('#csv-form').addEventListener('submit', async (event) => {
  event.preventDefault(); showError(''); const button = $('#start-csv'); setBusy(button, true);
  try {
    const form = new FormData(); const file = $('#csv').files[0];
    if (!file) throw new Error('Choose a CSV file first');
    form.append('csv', file);
    const response = await fetch('/api/batches/csv', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create batch');
    $('#csv').value = '';
    await refreshBatches(); await selectBatch(data.batch.id);
  } catch (error) { showError(error.message); }
  finally { setBusy(button, false); }
});
$('#urls').addEventListener('input', () => {
  const count = $('#urls').value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).length;
  $('#url-count').textContent = `${count} URL${count === 1 ? '' : 's'}`;
});
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => {
  for (const item of document.querySelectorAll('.tab')) item.classList.toggle('active', item === tab);
  $('#paste-form').classList.toggle('hidden', tab.dataset.mode !== 'paste');
  $('#csv-form').classList.toggle('hidden', tab.dataset.mode !== 'csv');
  showError('');
});
$('#refresh-batches').addEventListener('click', () => refreshBatches().catch(() => {}));
$('#clear-view').addEventListener('click', () => { $('#log-output').textContent = ''; });
$('#retry-batch').addEventListener('click', async () => {
  if (!selectedBatchId) return;
  const response = await fetch(`/api/batches/${encodeURIComponent(selectedBatchId)}/retry`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) { showError(data.error || 'Retry failed'); return; }
  await selectBatch(selectedBatchId);
});
$('#cancel-batch').addEventListener('click', async () => {
  if (!selectedBatchId || !confirm('Cancel this batch? The active download may need to be stopped by closing its browser process.')) return;
  await fetch(`/api/batches/${encodeURIComponent(selectedBatchId)}/cancel`, { method: 'POST' });
  await selectBatch(selectedBatchId);
});
refreshBatches().catch(() => {});
