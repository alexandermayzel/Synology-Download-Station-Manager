/**
 * Download Station — Popup Script
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

/** Localized string by key, with optional $1/$2 substitutions. */
const msg = (key, ...subs) => browser.i18n.getMessage(key, subs) || key;

/**
 * Fill every [data-i18n] element from _locales. Templates are localized too —
 * document.querySelectorAll does not descend into <template> content, so their
 * DocumentFragments are passed explicitly. Doing it once here means every card
 * cloned from a template later already carries the translated text.
 */
function localizeTree(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = msg(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = msg(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = msg(el.dataset.i18nTitle);
  }
}

function applyStaticLocalization() {
  localizeTree(document);
  for (const tpl of document.querySelectorAll('template')) {
    localizeTree(tpl.content);
  }
}

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const protocolEl   = $('protocol');
const hostEl       = $('host');
const portEl       = $('port');
const usernameEl   = $('username');
const passwordEl   = $('password');
const destEl       = $('defaultDestination');
const autoMagnetEl = $('autoCaptureMagnets');
const keepaliveEl  = $('keepaliveEnabled');
const extractEl    = $('extractArchives');
const unzipPassEl  = $('unzipPassword');
const archivePwField = $('archivePasswordField');
const btnSave        = $('btnSave');
const btnTest        = $('btnTest');
const btnClear       = $('btnClear');
const btnRefresh     = $('btnRefresh');
const bulkLinksEl    = $('bulkLinks');
const btnAddBulk     = $('btnAddBulk');
const btnClearList   = $('btnClearList');
const btnAddTorrent  = $('btnAddTorrent');
const torrentInput   = $('torrentInput');
const bulkStatusEl   = $('bulkStatus');
const btnPauseAll    = $('btnPauseAll');
const btnResumeAll   = $('btnResumeAll');
const btnDeleteAll   = $('btnDeleteAll');
const deleteAllBar   = $('deleteAllConfirm');
const btnDeleteYes   = $('btnDeleteAllYes');
const btnDeleteNo    = $('btnDeleteAllNo');
const totalSpeedEl   = $('totalSpeed');
const extractHintEl  = document.querySelector('[data-i18n="extractArchivesHint"]');
const statusDot      = $('statusDot');
const statusText     = $('statusText');
const taskListEl     = $('taskList');
const filtersEl      = $('filters');
const pagerEl        = $('pager');
const refreshIntEl   = $('refreshInterval');
const sortByEl       = $('sortBy');
const sortDirEl      = $('sortDir');
const statusOrderEl  = $('statusOrderField');
const orderListEl    = $('orderList');
const btnOrderReset  = $('btnOrderReset');
const perPageEl      = $('tasksPerPage');

// ---------------------------------------------------------------------------
// Task status buckets
// ---------------------------------------------------------------------------

/**
 * Download Station reports many status strings; group them into the four
 * buckets the filter row and the status sort work with.
 */
const STATUS_BUCKETS = {
  active:   ['downloading', 'extracting', 'finishing', 'hash_checking', 'seeding'],
  waiting:  ['waiting', 'filehosting_waiting'],
  failed:   ['error'],
  paused:   ['paused', 'stopped'],
  finished: ['finished'],
};

const BUCKET_OF = new Map();
for (const [bucket, statuses] of Object.entries(STATUS_BUCKETS)) {
  for (const s of statuses) BUCKET_OF.set(s, bucket);
}

/**
 * Statuses that mean the NAS is still working on something, so it is worth
 * asking again. Deliberately NOT the whole "active" bucket: seeding shows as
 * active but can go on forever, and polling it would never stop — the same
 * list the background poll alarm uses.
 */
const WORKING_STATUSES = new Set([
  'downloading', 'waiting', 'extracting', 'finishing', 'hash_checking', 'filehosting_waiting',
]);

const isWorking = (task) => WORKING_STATUSES.has(task.status?.toLowerCase());

/** Bucket for a task; anything unrecognised counts as waiting. */
const bucketOf = (task) => BUCKET_OF.get(task.status?.toLowerCase()) ?? 'waiting';

const DEFAULT_STATUS_ORDER = ['active', 'waiting', 'paused', 'failed', 'finished'];
const BUCKET_LABEL_KEY = {
  active:   'statusDownloading',
  waiting:  'statusWaiting',
  failed:   'statusFailed',
  paused:   'statusPaused',
  finished: 'statusFinished',
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULTS = {
  protocol: 'https',
  host: '',
  port: 5001,
  username: '',
  password: '',
  autoCaptureMagnets: false,
  defaultDestination: '',
  keepaliveEnabled: false,
  extractArchives: false,
  refreshInterval: 10,
  sortBy: 'status',
  sortDir: 'desc',
  statusOrder: DEFAULT_STATUS_ORDER,
  tasksPerPage: 50,
};

/** Live copy of the settings that affect rendering, so redraws stay cheap. */
let settings = { ...DEFAULTS };

async function loadSettings() {
  const s = await browser.storage.local.get(DEFAULTS);
  settings = { ...DEFAULTS, ...s };

  // A stored order from an older version may be missing buckets we since added.
  const order = Array.isArray(settings.statusOrder) ? settings.statusOrder : [];
  settings.statusOrder = [
    ...order.filter(b => DEFAULT_STATUS_ORDER.includes(b)),
    ...DEFAULT_STATUS_ORDER.filter(b => !order.includes(b)),
  ];

  protocolEl.value     = settings.protocol;
  hostEl.value         = settings.host;
  portEl.value         = settings.port;
  usernameEl.value     = settings.username;
  passwordEl.value     = settings.password;
  destEl.value         = settings.defaultDestination;
  autoMagnetEl.checked = settings.autoCaptureMagnets;
  keepaliveEl.checked  = settings.keepaliveEnabled;
  extractEl.checked    = settings.extractArchives;
  refreshIntEl.value   = String(settings.refreshInterval);
  sortByEl.value       = settings.sortBy;
  sortDirEl.value      = settings.sortDir;
  perPageEl.value      = String(settings.tasksPerPage);

  renderStatusOrder();
  syncSortControls();
  syncArchiveField();
}

/** The archive password only makes sense while auto-extract is switched on. */
function syncArchiveField() {
  archivePwField.hidden = !extractEl.checked;
  if (archivePwField.hidden) unzipPassEl.value = '';
}

/**
 * Only tell people an administrator is needed when this account actually
 * isn't one. is_manager comes from SYNO.DownloadStation.Info and, unlike the
 * auto-extract setting itself, needs no special privilege to read.
 */
async function syncExtractHint() {
  if (!extractHintEl) return;
  try {
    const r = await browser.runtime.sendMessage({ action: 'getDsInfo' });
    if (!r?.success) return; // can't tell — leave the neutral wording
    extractHintEl.textContent = r.data?.is_manager
      ? msg('extractArchivesHint')
      : msg('extractArchivesHintNoAdmin');
  } catch {
    // Offline or not set up yet; the neutral wording still applies.
  }
}

async function loadFilterState() {
  const s = await browser.storage.local.get({ activeFilter: 'all' });
  setActiveFilter(s.activeFilter, false);
}

function saveFilterState() {
  browser.storage.local.set({ activeFilter });
}

async function saveSettings() {
  settings = {
    ...settings,
    protocol:           protocolEl.value,
    host:               hostEl.value.trim(),
    port:               parseInt(portEl.value, 10) || 5001,
    username:           usernameEl.value.trim(),
    password:           passwordEl.value,
    autoCaptureMagnets: autoMagnetEl.checked,
    defaultDestination: destEl.value.trim(),
    keepaliveEnabled:   keepaliveEl.checked,
    extractArchives:    extractEl.checked,
    refreshInterval:    parseInt(refreshIntEl.value, 10),
    sortBy:             sortByEl.value,
    sortDir:            sortDirEl.value,
    statusOrder:        readStatusOrder(),
    tasksPerPage:       parseInt(perPageEl.value, 10) || 50,
  };
  await browser.storage.local.set(settings);
  await browser.runtime.sendMessage({ action: 'settingsUpdated' });
  currentPage = 1;
  syncArchiveField();
  renderTasks();
  restartAutoRefresh();
  showSavedFeedback();
}

function showSavedFeedback() {
  const orig = btnSave.textContent;
  btnSave.textContent = msg('saved');
  btnSave.disabled = true;
  setTimeout(() => {
    btnSave.textContent = orig;
    btnSave.disabled = false;
  }, 1500);
}

// ---------------------------------------------------------------------------
// Collapsible sections
// ---------------------------------------------------------------------------

/**
 * Every section starts open; only what the user actually folds away is
 * remembered, so a fresh install shows everything and a tidied-up layout
 * survives closing the popup.
 */
async function loadSectionStates() {
  const { sectionStates } = await browser.storage.local.get({ sectionStates: {} });
  for (const section of document.querySelectorAll('.section.collapsible')) {
    const stored = sectionStates[section.id];
    if (stored !== undefined) section.open = stored;
  }
}

function saveSectionStates() {
  const sectionStates = {};
  for (const section of document.querySelectorAll('.section.collapsible')) {
    sectionStates[section.id] = section.open;
  }
  browser.storage.local.set({ sectionStates });
}

for (const section of document.querySelectorAll('.section.collapsible')) {
  section.addEventListener('toggle', saveSectionStates);
}

// The Tasks header carries its own buttons; clicking those must not fold the
// panel, which is what a <summary> click would otherwise do.
for (const head of document.querySelectorAll('.section-head')) {
  head.addEventListener('click', (e) => {
    if (e.target.closest('.head-btn, .btn-sm')) e.preventDefault();
  });
}

// ---------------------------------------------------------------------------
// First-run setup guard
// ---------------------------------------------------------------------------

/** Connection fields that must be filled in before anything can be added. */
const REQUIRED_FIELDS = [hostEl, usernameEl, passwordEl];

function isConfigured() {
  return REQUIRED_FIELDS.every(el => el.value.trim() !== '');
}

/**
 * Send the user to the Settings tab with the empty required fields marked,
 * opening the Credentials section so the marked fields are actually visible.
 */
function promptForSetup() {
  activateTab('settings');
  document.querySelector('.credentials')?.setAttribute('open', '');

  let firstMissing = null;
  for (const el of REQUIRED_FIELDS) {
    const missing = el.value.trim() === '';
    el.classList.toggle('invalid', missing);
    if (missing && !firstMissing) firstMissing = el;
  }

  setStatus('error', msg('setupRequiredShort'));
  firstMissing?.focus();
}

// Clear a field's marking as soon as the user types something into it.
for (const el of REQUIRED_FIELDS) {
  el.addEventListener('input', () => {
    if (el.value.trim() !== '') el.classList.remove('invalid');
  });
}

// ---------------------------------------------------------------------------
// Status order — drag to reorder, arrows as the keyboard-reachable equivalent
// ---------------------------------------------------------------------------

/** "By status" needs the order list; every other sort needs a direction. */
function syncSortControls() {
  const byStatus = sortByEl.value === 'status';
  statusOrderEl.hidden = !byStatus;
  sortDirEl.hidden     = byStatus;
}

/** Current order as bucket names, top first. */
function readStatusOrder() {
  return [...orderListEl.querySelectorAll('.order-item')].map(el => el.dataset.bucket);
}

function renderStatusOrder() {
  const frag = document.createDocumentFragment();

  for (const bucket of settings.statusOrder) {
    const item = document.createElement('div');
    item.className = 'order-item';
    item.draggable = true;
    item.dataset.bucket = bucket;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';

    const ord = document.createElement('span');
    ord.className = 'ord';

    const name = document.createElement('span');
    name.className = 'onm';
    name.textContent = msg(BUCKET_LABEL_KEY[bucket]);

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'ord-btn';
    up.dataset.move = 'up';
    up.title = msg('moveUp');
    up.textContent = '↑';

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'ord-btn';
    down.dataset.move = 'down';
    down.title = msg('moveDown');
    down.textContent = '↓';

    item.append(grip, ord, name, up, down);
    frag.appendChild(item);
  }

  orderListEl.replaceChildren(frag);
  renumberStatusOrder();
}

/** Refresh the position numbers and disable the arrows at the ends. */
function renumberStatusOrder() {
  const items = [...orderListEl.querySelectorAll('.order-item')];
  items.forEach((item, i) => {
    item.querySelector('.ord').textContent = String(i + 1);
    item.querySelector('[data-move="up"]').disabled   = i === 0;
    item.querySelector('[data-move="down"]').disabled = i === items.length - 1;
  });
}

orderListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.ord-btn');
  if (!btn || btn.disabled) return;
  const item = btn.closest('.order-item');
  if (btn.dataset.move === 'up') item.previousElementSibling?.before(item);
  else                           item.nextElementSibling?.after(item);
  renumberStatusOrder();
});

btnOrderReset.addEventListener('click', () => {
  settings.statusOrder = [...DEFAULT_STATUS_ORDER];
  renderStatusOrder();
});

// ---- Drag and drop ----
let draggedItem = null;

function clearDropMarks() {
  orderListEl.querySelectorAll('.drop-before,.drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

orderListEl.addEventListener('dragstart', (e) => {
  draggedItem = e.target.closest('.order-item');
  if (!draggedItem) return;
  draggedItem.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Firefox only starts a drag once some data is set.
  e.dataTransfer.setData('text/plain', draggedItem.dataset.bucket);
});

orderListEl.addEventListener('dragover', (e) => {
  if (!draggedItem) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const over = e.target.closest('.order-item');
  clearDropMarks();
  if (!over || over === draggedItem) return;

  // Drop above or below, depending on which half of the row we're over.
  const box = over.getBoundingClientRect();
  over.classList.add(e.clientY > box.top + box.height / 2 ? 'drop-after' : 'drop-before');
});

orderListEl.addEventListener('drop', (e) => {
  if (!draggedItem) return;
  e.preventDefault();
  const over = e.target.closest('.order-item');
  clearDropMarks();
  if (over && over !== draggedItem) {
    const box = over.getBoundingClientRect();
    if (e.clientY > box.top + box.height / 2) over.after(draggedItem);
    else                                      over.before(draggedItem);
    renumberStatusOrder();
  }
});

orderListEl.addEventListener('dragend', () => {
  draggedItem?.classList.remove('dragging');
  clearDropMarks();
  draggedItem = null;
});

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

const DOT_STATE = {
  connected: 'dot-connected',
  error:     'dot-error',
  checking:  'dot-checking',
};

function setStatus(state, message) {
  statusDot.className = `dot ${DOT_STATE[state] ?? 'dot-idle'}`;
  statusText.textContent = message;
}

/**
 * Pull readable text out of an error response. The background reports errors
 * either as a plain string or as an object with .message / .code, depending
 * on whether the API answered or the call threw.
 */
function errText(error, fallbackKey) {
  if (typeof error === 'string' && error) return error;
  if (error?.message) return error.message;
  if (error?.code !== undefined) return `${msg('errorPrefix')} ${error.code}`;
  return msg(fallbackKey);
}

async function testConnection() {
  setStatus('checking', msg('connecting'));
  btnTest.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ action: 'testConnection' });
    if (result.success) {
      const v = result.info?.authVersion ?? '?';
      setStatus('connected', msg('connectedWithVersion', String(v)));
      startAutoRefresh();
    } else {
      setStatus('error', errText(result.error, 'connectionFailed'));
      stopAutoRefresh();
    }
  } catch (err) {
    setStatus('error', err.message || msg('extensionError'));
    stopAutoRefresh();
  } finally {
    btnTest.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Task list
// ---------------------------------------------------------------------------

/**
 * Human-readable badge text. The API reports raw values like "error"; show
 * the localized wording for the ones we have, and fall back to the raw status
 * for the rarer ones (seeding, extracting, …) rather than flattening them.
 */
const STATUS_LABEL_KEY = {
  downloading: 'statusDownloading',
  waiting:     'statusWaiting',
  error:       'statusFailed',
  paused:      'statusPaused',
  stopped:     'statusPaused',
  finished:    'statusFinished',
  extracting:  'statusExtracting',
};

/**
 * Readable reason for a failed task. The API reports it as a snake_case token
 * in status_extra (Appendix B of the Web API guide); each one has its own
 * detail_* message. Unknown tokens fall through to the raw value rather than
 * being swallowed.
 */
function failureReason(task) {
  const detail = task.status_extra?.error_detail || task.status_extra?.err_detail;
  if (!detail) return null;
  return browser.i18n.getMessage(`detail_${detail}`) || detail;
}

function badgeLabel(status) {
  const key = STATUS_LABEL_KEY[status?.toLowerCase()];
  return key ? msg(key) : (status ?? '—');
}

function badgeClass(status) {
  const map = {
    downloading: 'badge-downloading',
    seeding:     'badge-finished',
    finished:    'badge-finished',
    paused:      'badge-paused',
    stopped:     'badge-paused',
    error:       'badge-error',
    waiting:     'badge-waiting',
  };
  return map[status?.toLowerCase()] ?? 'badge-waiting';
}

function formatSpeed(bps) {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bps >= 1024)        return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps > 0)            return `${bps} B/s`;
  return null;
}

function calcProgress(task) {
  const s = task.status?.toLowerCase();
  // Finished/seeding tasks are always 100 %
  if (s === 'finished' || s === 'seeding') return 100;

  // While extracting, the download is done and the archive is being unpacked,
  // so show that progress instead of a bar that is already full.
  if (s === 'extracting') {
    const unzip = task.status_extra?.unzip_progress;
    if (typeof unzip === 'number') return Math.min(100, Math.max(0, unzip));
  }

  const total      = task.size ?? 0;
  const downloaded = task.additional?.transfer?.size_downloaded ?? 0;
  if (total === 0) return 0;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

let cachedTasks     = [];
let refreshInterval = null;

const taskCardTpl = document.getElementById('taskCardTpl');

/** Replace taskList contents with a single text message. */
function showMessage(text, isError = false) {
  const p = document.createElement('p');
  p.className = `hint center ${isError ? 'error' : ''}`.trim();
  p.textContent = text;
  taskListEl.replaceChildren(p);
}

function startAutoRefresh() {
  stopAutoRefresh();
  // 0 means "Manual only" — the user refreshes with the button instead.
  if (settings.refreshInterval > 0) {
    refreshInterval = setInterval(refreshTasks, settings.refreshInterval * 1000);
  }
}

function stopAutoRefresh() {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

/** Re-arm the timer after the interval setting changed, if it was running. */
function restartAutoRefresh() {
  if (refreshInterval !== null) startAutoRefresh();
}

window.addEventListener('unload', stopAutoRefresh);

// ---------------------------------------------------------------------------
// Filter / sort / paginate
// ---------------------------------------------------------------------------

let activeFilter = 'all';
let currentPage  = 1;

function setActiveFilter(filter, persist = true) {
  activeFilter = filter;
  for (const btn of filtersEl.querySelectorAll('.fbtn')) {
    btn.classList.toggle('on', btn.dataset.filter === filter);
  }
  currentPage = 1;
  if (persist) saveFilterState();
}

function updateFilterCounts(tasks) {
  const counts = { all: tasks.length, active: 0, waiting: 0, failed: 0, paused: 0, finished: 0 };
  for (const task of tasks) counts[bucketOf(task)]++;
  for (const [bucket, n] of Object.entries(counts)) {
    const el = filtersEl.querySelector(`[data-count="${bucket}"]`);
    if (el) el.textContent = String(n);
  }
}

function sortTasks(tasks) {
  const dir = settings.sortDir === 'asc' ? 1 : -1;

  if (settings.sortBy === 'status') {
    // Rank by the user's status order; ties keep the NAS's own ordering.
    const rank = new Map(settings.statusOrder.map((b, i) => [b, i]));
    return [...tasks].sort(
      (a, b) => (rank.get(bucketOf(a)) ?? 99) - (rank.get(bucketOf(b)) ?? 99)
    );
  }

  const keyOf = {
    added:    t => t.additional?.detail?.create_time ?? 0,
    name:     t => (t.title ?? '').toLowerCase(),
    progress: t => calcProgress(t),
    size:     t => t.size ?? 0,
  }[settings.sortBy];

  if (!keyOf) return tasks;

  return [...tasks].sort((a, b) => {
    const ka = keyOf(a), kb = keyOf(b);
    if (typeof ka === 'string') return ka.localeCompare(kb) * dir;
    return (ka - kb) * dir;
  });
}

/** Draw the page buttons, collapsing long runs of pages with an ellipsis. */
function renderPager(totalPages, total, from, to) {
  if (totalPages <= 1) {
    pagerEl.hidden = true;
    pagerEl.replaceChildren();
    return;
  }
  pagerEl.hidden = false;

  const frag = document.createDocumentFragment();

  const arrow = (label, title, page, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pbtn';
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    if (!disabled) b.dataset.page = String(page);
    return b;
  };

  frag.appendChild(arrow('‹', msg('prevPage'), currentPage - 1, currentPage === 1));

  // First page, last page, and a window around the current one.
  const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  const shown = [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let previous = 0;
  for (const p of shown) {
    if (p - previous > 1) {
      const gap = document.createElement('span');
      gap.className = 'pager-gap';
      gap.textContent = '…';
      frag.appendChild(gap);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pbtn${p === currentPage ? ' on' : ''}`;
    b.textContent = String(p);
    b.dataset.page = String(p);
    frag.appendChild(b);
    previous = p;
  }

  frag.appendChild(arrow('›', msg('nextPage'), currentPage + 1, currentPage === totalPages));

  const info = document.createElement('span');
  info.className = 'pager-info';
  info.textContent = msg('pagerInfo', String(from), String(to), String(total));
  frag.appendChild(info);

  pagerEl.replaceChildren(frag);
}

pagerEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.pbtn');
  if (!btn || btn.disabled || !btn.dataset.page) return;
  currentPage = parseInt(btn.dataset.page, 10);
  renderTasks();
  taskListEl.scrollTop = 0;
});

filtersEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.fbtn');
  if (!btn) return;
  setActiveFilter(btn.dataset.filter);
  renderTasks();
  taskListEl.scrollTop = 0;
});

function renderTasks(tasks) {
  if (tasks) cachedTasks = tasks;

  updateFilterCounts(cachedTasks);

  const filtered = activeFilter === 'all'
    ? cachedTasks
    : cachedTasks.filter(t => bucketOf(t) === activeFilter);

  if (filtered.length === 0) {
    showMessage(msg('noTasks'));
    renderPager(0, 0, 0, 0);
    return;
  }

  const sorted     = sortTasks(filtered);
  const perPage    = settings.tasksPerPage;
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  // A filter change or finished downloads can shrink the list under our feet.
  currentPage = Math.min(currentPage, totalPages);

  const start   = (currentPage - 1) * perPage;
  const visible = sorted.slice(start, start + perPage);

  renderPager(totalPages, sorted.length, start + 1, start + visible.length);

  const fragment = document.createDocumentFragment();

  for (const task of visible) {
    const card = taskCardTpl.content.firstElementChild.cloneNode(true);

    const name = task.title || task.id || '—';
    const nameEl = card.querySelector('[data-field="name"]');
    nameEl.textContent = name;
    // Failed tasks put the reason in the tooltip, where there is room for it.
    const reason = failureReason(task);
    nameEl.title = reason ? `${name}\n${reason}` : name;

    const badge = badgeClass(task.status);
    const badgeEl = card.querySelector('[data-field="badge"]');
    badgeEl.className = `badge ${badge}`;
    badgeEl.textContent = badgeLabel(task.status);

    const pct    = calcProgress(task);
    const isDone = badge === 'badge-finished';
    const barEl  = card.querySelector('[data-field="bar"]');
    barEl.className = isDone ? 'bar-fill done' : 'bar-fill';
    barEl.style.width = `${pct}%`;

    card.querySelector('[data-field="pct"]').textContent = `${pct}%`;

    const s = task.status?.toLowerCase();
    const bucket    = bucketOf(task);
    const canPause  = s === 'downloading' || s === 'waiting';
    const canResume = s === 'paused'      || s === 'stopped';

    if (canPause) {
      const btn = card.querySelector('[data-field="pauseBtn"]');
      btn.hidden = false;
      btn.dataset.taskId = task.id;
    }
    if (canResume) {
      const btn = card.querySelector('[data-field="resumeBtn"]');
      btn.hidden = false;
      btn.dataset.taskId = task.id;
    }
    if (bucket === 'failed') {
      // Retrying re-queues the original URI, so it has to travel with the button.
      const uri = task.additional?.detail?.uri;
      if (uri) {
        const btn = card.querySelector('[data-field="retryBtn"]');
        btn.hidden = false;
        btn.dataset.taskId = task.id;
        btn.dataset.uri = uri;
      }
    }
    // "Clear" only sweeps up genuinely finished tasks, so anything it leaves
    // behind — failures and seeding torrents — needs its own way out.
    if (bucket === 'failed' || s === 'seeding') {
      const removeBtn = card.querySelector('[data-field="removeBtn"]');
      removeBtn.hidden = false;
      removeBtn.dataset.taskId = task.id;
    }

    const speedEl = card.querySelector('[data-field="speed"]');
    if (reason) {
      // A failed task has no speed to show, so the row carries the reason.
      speedEl.hidden = false;
      speedEl.classList.add('failure');
      const span = document.createElement('span');
      span.textContent = reason;
      speedEl.appendChild(span);
    } else {
      const dl = formatSpeed(task.additional?.transfer?.speed_download ?? 0);
      const ul = formatSpeed(task.additional?.transfer?.speed_upload   ?? 0);
      if (dl || ul) {
        speedEl.hidden = false;
        if (dl) {
          const span = document.createElement('span');
          span.textContent = `↓ ${dl}`;
          speedEl.appendChild(span);
        }
        if (ul) {
          const span = document.createElement('span');
          span.textContent = `↑ ${ul}`;
          speedEl.appendChild(span);
        }
      }
    }

    fragment.appendChild(card);
  }

  taskListEl.replaceChildren(fragment);
}

async function refreshTasks() {
  btnRefresh.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ action: 'listTasks' });
    if (result.success) {
      const tasks = result.data?.tasks ?? [];
      renderTasks(tasks);
      refreshStatistics();

      // Nothing is moving any more, so stop polling the NAS. The Refresh
      // button and adding a new link both bring the timer back.
      if (!tasks.some(isWorking)) stopAutoRefresh();
    } else {
      showMessage(errText(result.error, 'connectionFailed'), true);
    }
  } catch {
    showMessage(msg('backgroundUnreachable'), true);
  } finally {
    btnRefresh.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Bulk add
// ---------------------------------------------------------------------------

// The popup is torn down every time it closes, so the pending list is kept in
// storage. That way links can be collected across several visits and only get
// cleared once they've actually been sent — or when the user empties the list.
let draftSaveTimer = null;

function saveDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    browser.storage.local.set({ bulkDraft: bulkLinksEl.value });
  }, 250);
}

async function loadDraft() {
  const { bulkDraft } = await browser.storage.local.get({ bulkDraft: '' });
  bulkLinksEl.value = bulkDraft;
}

function clearDraft() {
  clearTimeout(draftSaveTimer);
  bulkLinksEl.value = '';
  browser.storage.local.remove('bulkDraft');
}

bulkLinksEl.addEventListener('input', saveDraft);

btnClearList.addEventListener('click', () => {
  clearDraft();
  bulkStatusEl.textContent = '';
  bulkLinksEl.focus();
});

async function addBulkLinks() {
  // Nothing can be added before the NAS is configured — send the user there
  // instead of firing off a request that is bound to fail.
  if (!isConfigured()) {
    bulkStatusEl.textContent = msg('setupRequired');
    promptForSetup();
    return;
  }

  const urls = bulkLinksEl.value
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (urls.length === 0) {
    bulkStatusEl.textContent = msg('noLinksEntered');
    return;
  }

  btnAddBulk.disabled = true;
  bulkStatusEl.textContent = msg('addingLinks', String(urls.length));
  try {
    const result = await browser.runtime.sendMessage({
      action: 'addTasksBulk',
      urls,
      unzipPassword: extractEl.checked ? unzipPassEl.value : '',
    });
    if (result.setupRequired) {
      bulkStatusEl.textContent = msg('setupRequired');
      promptForSetup();
      return;
    }
    if (result.success) {
      bulkStatusEl.textContent = msg('linksAdded', String(result.added));
      clearDraft(); // only once the NAS has actually accepted them
    } else if (result.errorMessage || result.failed !== undefined) {
      const reason = result.errorMessage ? ` — ${result.errorMessage}` : '';
      bulkStatusEl.textContent =
        msg('linksPartial', String(result.added ?? 0), String(result.failed ?? 0)) + reason;
    } else {
      bulkStatusEl.textContent = errText(result.error, 'addLinksFailed');
    }
    await refreshTasks();
    startAutoRefresh(); // new tasks to follow — re-arm if refreshTasks stopped it
  } catch (err) {
    bulkStatusEl.textContent = err.message || msg('addLinksFailed');
  } finally {
    btnAddBulk.disabled = false;
  }
}

btnAddBulk.addEventListener('click', addBulkLinks);

// ---------------------------------------------------------------------------
// Torrent / NZB file upload
// ---------------------------------------------------------------------------

btnAddTorrent.addEventListener('click', () => torrentInput.click());

torrentInput.addEventListener('change', async () => {
  const chosen = [...torrentInput.files];
  torrentInput.value = ''; // so picking the same file twice fires again
  if (chosen.length === 0) return;

  if (!isConfigured()) {
    bulkStatusEl.textContent = msg('setupRequired');
    promptForSetup();
    return;
  }

  btnAddTorrent.disabled = true;
  bulkStatusEl.textContent = msg('addingFiles', String(chosen.length));
  try {
    // File objects don't survive runtime messaging, so send the bytes.
    const files = await Promise.all(chosen.map(async (f) => ({
      name: f.name,
      buffer: await f.arrayBuffer(),
    })));

    const result = await browser.runtime.sendMessage({
      action: 'addTaskFiles',
      files,
      unzipPassword: extractEl.checked ? unzipPassEl.value : '',
    });

    if (result.setupRequired) {
      bulkStatusEl.textContent = msg('setupRequired');
      promptForSetup();
      return;
    }
    if (result.success) {
      bulkStatusEl.textContent = msg('filesAdded', String(result.added));
    } else {
      const reason = result.errorMessage ? ` — ${result.errorMessage}` : '';
      bulkStatusEl.textContent =
        msg('linksPartial', String(result.added ?? 0), String(result.failed ?? 0)) + reason;
    }
    await refreshTasks();
    startAutoRefresh();
  } catch (err) {
    bulkStatusEl.textContent = err.message || msg('addLinksFailed');
  } finally {
    btnAddTorrent.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Bulk task actions
// ---------------------------------------------------------------------------

async function runBulkAction(action, button) {
  button.disabled = true;
  try {
    await browser.runtime.sendMessage({ action });
    await refreshTasks();
    if (action === 'resumeAll') startAutoRefresh();
  } finally {
    button.disabled = false;
  }
}

btnPauseAll.addEventListener('click', () => runBulkAction('pauseAll', btnPauseAll));
btnResumeAll.addEventListener('click', () => runBulkAction('resumeAll', btnResumeAll));

// Deleting everything is irreversible, so it takes a second, deliberate click.
btnDeleteAll.addEventListener('click', () => {
  deleteAllBar.hidden = false;
  btnDeleteNo.focus();
});
btnDeleteNo.addEventListener('click', () => { deleteAllBar.hidden = true; });
btnDeleteYes.addEventListener('click', async () => {
  deleteAllBar.hidden = true;
  await runBulkAction('deleteAll', btnDeleteYes);
});

// ---------------------------------------------------------------------------
// Transfer statistics
// ---------------------------------------------------------------------------

async function refreshStatistics() {
  try {
    const r = await browser.runtime.sendMessage({ action: 'getStatistics' });
    if (!r?.success) { totalSpeedEl.hidden = true; return; }

    const down = formatSpeed(r.data?.speed_download ?? 0);
    const up   = formatSpeed(r.data?.speed_upload   ?? 0);
    if (!down && !up) { totalSpeedEl.hidden = true; return; }

    totalSpeedEl.hidden = false;
    totalSpeedEl.textContent = msg('totalSpeed', down ?? '0', up ?? '0');
  } catch {
    totalSpeedEl.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Task action delegation (pause / resume)
// ---------------------------------------------------------------------------

taskListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, taskId, uri } = btn.dataset;
  btn.disabled = true;
  try {
    await browser.runtime.sendMessage({
      action, id: taskId, uri,
      // A retried archive needs the same password the original add used.
      unzipPassword: extractEl.checked ? unzipPassEl.value : '',
    });
    await refreshTasks();
    // Resuming or retrying makes a task active again — re-arm the timer.
    if (action === 'resumeTask' || action === 'retryTask') startAutoRefresh();
  } finally {
    // btn may already be replaced by refreshTasks re-render; safe to ignore
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

btnSave.addEventListener('click', saveSettings);
btnTest.addEventListener('click', testConnection);
// A manual refresh also re-arms the timer that refreshTasks stops once
// everything has finished.
btnRefresh.addEventListener('click', async () => {
  await refreshTasks();
  startAutoRefresh();
});
btnClear.addEventListener('click', async () => {
  btnClear.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ action: 'clearCompleted' });
    if (result.success) await refreshTasks();
  } finally {
    btnClear.disabled = false;
  }
});
autoMagnetEl.addEventListener('change', saveSettings);
keepaliveEl.addEventListener('change', saveSettings);
extractEl.addEventListener('change', saveSettings);
// Swap the direction dropdown for the order list as soon as the sort changes,
// so the control matches the selection before anything is saved.
sortByEl.addEventListener('change', syncSortControls);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function activateTab(name) {
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.dataset.panel === name);
  }
}

document.querySelectorAll('.tab').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => activateTab(tabBtn.dataset.tab));
});

// ---------------------------------------------------------------------------
// Init — auto-connect and refresh when popup opens
// ---------------------------------------------------------------------------

/**
 * Send a message to the background script, retrying a few times to handle
 * the MV3 event-page wakeup delay. Without retries, the very first click
 * after the background is suspended throws immediately and the popup shows
 * an error, forcing a second click.
 */
async function sendWithRetry(action, retries = 3, delayMs = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      return await browser.runtime.sendMessage({ action });
    } catch {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(msg('backgroundUnavailable'));
}

// Lets the background know a popup is open, so it doesn't hand the session
// back while we're still refreshing. The port drops itself when we close.
browser.runtime.connect({ name: 'popup' });

(async function init() {
  const overlay = document.getElementById('loadingOverlay');
  try {
    applyStaticLocalization();

    // Load all persisted state before touching the UI
    await Promise.all([loadSettings(), loadFilterState(), loadDraft(), loadSectionStates()]);

    // A download attempted before setup flags the popup to land on Settings.
    let cameFromFailedDownload = false;
    try {
      const flag = await sendWithRetry('consumeSetupFlag');
      cameFromFailedDownload = !!flag?.setupRequired;
    } catch {
      // Background not ready — the isConfigured() check below still covers us.
    }

    // Nothing works without host + credentials, so ask for them up front.
    if (!isConfigured()) {
      promptForSetup();
      showMessage(msg('noTasks'));
      return;
    }
    if (cameFromFailedDownload) {
      // Configured but the attempt still failed setup — show Settings anyway.
      activateTab('settings');
    }

    // Ask background if it already has a live session (instant memory check).
    // Uses retry so a suspended event page has time to wake up.
    try {
      const status = await sendWithRetry('getStatus');
      if (status.connected) {
        setStatus('connected', msg('connected'));
        refreshTasks();
        syncExtractHint();
        startAutoRefresh();
        return;
      }
    } catch {
      // Background not ready after retries — fall through to full login
    }

    setStatus('checking', msg('connecting'));
    try {
      const result = await sendWithRetry('testConnection');
      if (result.success) {
        const v = result.info?.authVersion ?? '?';
        setStatus('connected', msg('connectedWithVersion', String(v)));
        refreshTasks();
        syncExtractHint();
        startAutoRefresh();
      } else {
        setStatus('error', errText(result.error, 'notConnected'));
        showMessage(msg('noTasks'));
      }
    } catch {
      setStatus('error', msg('backgroundUnavailable'));
      showMessage(msg('noTasks'));
    }
  } finally {
    overlay.style.display = 'none';
  }
})();
