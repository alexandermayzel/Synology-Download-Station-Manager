/**
 * Download Station — Background Script
 *
 * Handles context menus, session management (Synology-compatible API),
 * and task creation. Acts as the single point of communication with
 * the configured Synology Download Station API.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// ---------------------------------------------------------------------------
// State — kept in memory AND mirrored to storage.session so it survives
// a background script restart (e.g. extension reload during development).
// storage.session is cleared automatically when the browser closes.
// ---------------------------------------------------------------------------
let cachedSid      = null;
let cachedApiPaths = null;

// Restore persisted state on startup.
// Stored as a Promise so every entry point (alarms, messages, context menus)
// can await it before touching cachedSid / cachedApiPaths, preventing a race
// between the async read and the first incoming event that wakes the script.
const stateReady = browser.storage.session
  .get({ sid: null, apiPaths: null })
  .then(({ sid, apiPaths }) => {
    if (sid)      cachedSid      = sid;
    if (apiPaths) cachedApiPaths = apiPaths;
  });

// ---------------------------------------------------------------------------
// Default settings
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
};

/** The three fields without which no API call can succeed. */
function isConfigured(settings) {
  return !!(settings.host && settings.username && settings.password);
}

// ---------------------------------------------------------------------------
// i18n + error code translation
// ---------------------------------------------------------------------------

/** Localized string by key, with optional $1/$2 substitutions. */
const msg = (key, ...subs) => browser.i18n.getMessage(key, subs) || key;

// Codes 100–107 are shared by every SYNO.* WebAPI endpoint; 400+ are specific
// to the endpoint, so each family gets its own locale key prefix.
const COMMON_CODES = new Set([100, 101, 102, 103, 104, 105, 106, 107]);
const AUTH_CODES = new Set([400, 401, 402, 403, 404]);
const TASK_CODES = new Set([400, 401, 402, 403, 404, 405, 406, 407, 408]);

const AUTH_ERRORS = { prefix: 'errAuth', codes: AUTH_CODES };
const TASK_ERRORS = { prefix: 'errTask', codes: TASK_CODES };

/**
 * Turn a Synology API error code into a sentence the user can act on.
 * `family` says which endpoint answered — the same number means different
 * things per endpoint, while 100–107 are shared by all of them.
 */
function describeError(family, code) {
  if (typeof code !== 'number') return `${msg('errorPrefix')} ${code}`;

  let key = null;
  if (COMMON_CODES.has(code)) key = `err${code}`;
  else if (family.codes.has(code)) key = `${family.prefix}${code}`;

  if (!key) return msg('errUnknownCode', String(code));

  const text = browser.i18n.getMessage(key);
  return text ? msg('errWithCode', text, String(code)) : msg('errUnknownCode', String(code));
}

/**
 * Task error 403 ("Destination does not exist") has two very different causes.
 * With no destination of our own we never sent one, so the broken path is the
 * NAS's own default — saying "check the folder name you entered" would send
 * the user looking at an empty field.
 */
async function describeTaskError(code) {
  if (code === 403) {
    const { defaultDestination } = await getSettings();
    if (!defaultDestination) {
      return msg('errWithCode', msg('errTask403NoDest'), '403');
    }
  }
  return describeError(TASK_ERRORS, code);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function buildBaseUrl(protocol, host, port) {
  return `${protocol}://${host}:${port}/webapi`;
}

// ---------------------------------------------------------------------------
// API discovery (SYNO.API.Info)
// ---------------------------------------------------------------------------

/**
 * Highest version of each API this extension actually knows how to talk to,
 * taken from the Web API guide. A NAS may advertise a newer one whose
 * parameters differ, so the reported maxVersion is capped rather than trusted.
 */
const VERSION_CEILING = {
  auth:      7,  // DSM 7 tops out at 7; format=sid unchanged since 2
  task:      3,  // guide documents Task up to 3 (uri param needs 3+)
  info:      1,
  statistic: 1,
};

/** Pick the newest version both sides support, within what we understand. */
function pickVersion(apiInfo, ceiling, fallback) {
  const max = apiInfo?.maxVersion;
  const min = apiInfo?.minVersion ?? 1;
  if (typeof max !== 'number') return fallback;
  // Never drop below what the NAS still accepts, never exceed what we know.
  return Math.max(min, Math.min(max, ceiling));
}

/**
 * Query the NAS's own API info endpoint to discover the correct path and
 * version for the APIs we use.
 *
 * This is the officially documented first step in Synology API usage and
 * handles differences between DSM 6, DSM 7, and future firmware versions.
 * Falls back to well-known defaults if discovery fails.
 */
async function discoverApiPaths(protocol, host, port) {
  if (cachedApiPaths) return cachedApiPaths;

  const fallback = {
    authPath:       'auth.cgi',
    authVersion:    3,
    taskPath:       'DownloadStation/task.cgi',
    taskVersion:    3,
    infoPath:       'DownloadStation/info.cgi',
    infoVersion:    1,
    statPath:       'DownloadStation/statistic.cgi',
    statVersion:    1,
  };

  try {
    const query = encodeURIComponent(
      'SYNO.API.Auth,SYNO.DownloadStation.Task,' +
      'SYNO.DownloadStation.Info,SYNO.DownloadStation.Statistic'
    );
    const url = `${protocol}://${host}:${port}/webapi/query.cgi` +
      `?api=SYNO.API.Info&version=1&method=query&query=${query}`;

    const resp = await fetch(url);
    if (!resp.ok) return fallback;
    const json = await resp.json();
    if (!json.success) return fallback;

    const authInfo = json.data['SYNO.API.Auth'];
    const taskInfo = json.data['SYNO.DownloadStation.Task'];
    const dsInfo   = json.data['SYNO.DownloadStation.Info'];
    const statInfo = json.data['SYNO.DownloadStation.Statistic'];

    cachedApiPaths = {
      authPath:    authInfo?.path ?? fallback.authPath,
      authVersion: pickVersion(authInfo, VERSION_CEILING.auth, fallback.authVersion),
      taskPath:    taskInfo?.path ?? fallback.taskPath,
      taskVersion: pickVersion(taskInfo, VERSION_CEILING.task, fallback.taskVersion),
      infoPath:    dsInfo?.path   ?? fallback.infoPath,
      infoVersion: pickVersion(dsInfo, VERSION_CEILING.info, fallback.infoVersion),
      statPath:    statInfo?.path ?? fallback.statPath,
      statVersion: pickVersion(statInfo, VERSION_CEILING.statistic, fallback.statVersion),
    };
    browser.storage.session.set({ apiPaths: cachedApiPaths });
    return cachedApiPaths;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Session / Auth
// ---------------------------------------------------------------------------

/**
 * Log in and return the session ID.
 * Throws on failure with a message that includes the API error code.
 */
async function login(settings) {
  const { protocol, host, port, username, password } = settings;
  if (!isConfigured(settings)) {
    throw new Error(msg('setupRequired'));
  }
  const apis = await discoverApiPaths(protocol, host, port);
  const base = buildBaseUrl(protocol, host, port);

  const url = `${base}/${apis.authPath}` +
    `?api=SYNO.API.Auth&version=${apis.authVersion}&method=login` +
    `&account=${encodeURIComponent(username)}` +
    `&passwd=${encodeURIComponent(password)}` +
    `&session=DownloadStation&format=sid`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.success) {
    throw new Error(msg('errLoginFailed', describeError(AUTH_ERRORS, json.error?.code ?? 'unknown')));
  }
  return json.data.sid;
}

/**
 * A login already on its way. Opening the popup fires several calls at once
 * (status, task list, the poll alarm's first tick); without this they would
 * each see an empty cache and open their own session on the NAS.
 */
let loginInFlight = null;

/**
 * Get a valid session ID, logging in if necessary.
 */
function getSession(settings) {
  if (cachedSid) return Promise.resolve(cachedSid);
  if (!loginInFlight) {
    loginInFlight = login(settings)
      .then((sid) => {
        cachedSid = sid;
        browser.storage.session.set({ sid });
        return sid;
      })
      .finally(() => { loginInFlight = null; });
  }
  return loginInFlight;
}

/** Clear cached session ID (keeps API path cache — same NAS). */
function clearSession() {
  cachedSid = null;
  browser.storage.session.remove('sid');
}

/**
 * Hand the session back to the NAS instead of leaving it to time out.
 * Best effort: if it fails the session is lost to us either way, and there
 * is nothing the user could do about it.
 */
async function apiLogout() {
  await stateReady;
  if (!cachedSid) return;

  const settings = await getSettings();
  try {
    const apis = await discoverApiPaths(settings.protocol, settings.host, settings.port);
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    await fetch(
      `${base}/${apis.authPath}` +
      `?api=SYNO.API.Auth&version=${apis.authVersion}&method=logout` +
      `&session=DownloadStation&_sid=${encodeURIComponent(cachedSid)}`
    );
  } catch {
    // Network gone, NAS asleep — nothing useful to report.
  }
  clearSession();
}

/** Clear everything (call when host/port/protocol changes). */
function clearAll() {
  cachedSid      = null;
  cachedApiPaths = null;
  browser.storage.session.remove(['sid', 'apiPaths']);
  // Badge is intentionally NOT cleared here — active downloads may still be
  // running on the NAS. Only updateBadge() clears it when count reaches 0.
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function updateBadge(tasks) {
  const count = tasks.filter(
    t => t.status?.toLowerCase() === 'downloading'
  ).length;

  browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  if (count > 0) {
    // Matches the popup's accent (see --accent in popup.css).
    browser.action.setBadgeBackgroundColor({ color: '#00ddff' });
    browser.action.setBadgeTextColor?.({ color: '#0b1f24' });
  }
}

/** Session-expired error codes (Synology convention). */
const SESSION_ERROR_CODES = new Set([105, 106, 107]);

/**
 * Execute an API call, re-authenticating once if the session has expired.
 * `apiFn` receives `(settings, sid, apis)` and must return the parsed JSON body.
 */
async function withSession(apiFn) {
  await stateReady;
  const settings = await getSettings();
  const apis = await discoverApiPaths(settings.protocol, settings.host, settings.port);
  let sid = await getSession(settings);
  let result = await apiFn(settings, sid, apis);

  if (!result.success && SESSION_ERROR_CODES.has(result.error?.code)) {
    clearSession();
    sid = await getSession(settings);
    result = await apiFn(settings, sid, apis);
  }

  return result;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function apiAddTask(url, unzipPassword) {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const endpoint = `${base}/${apis.taskPath}`;

    const body = new URLSearchParams({
      api:     'SYNO.DownloadStation.Task',
      version: String(apis.taskVersion),
      method:  'create',
      uri:     url,
      _sid:    sid,
    });
    if (settings.defaultDestination) {
      body.set('destination', settings.defaultDestination);
    }
    if (unzipPassword) {
      body.set('unzip_password', unzipPassword);
    }

    const resp = await fetch(endpoint, { method: 'POST', body });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

async function apiDeleteTasks(ids) {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const endpoint = `${base}/${apis.taskPath}`;

    const body = new URLSearchParams({
      api:            'SYNO.DownloadStation.Task',
      version:        String(apis.taskVersion),
      method:         'delete',
      id:             ids.join(','),
      force_complete: 'false',
      _sid:           sid,
    });
    const resp = await fetch(endpoint, { method: 'POST', body });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

async function apiPauseTask(id) {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const body = new URLSearchParams({
      api:     'SYNO.DownloadStation.Task',
      version: String(apis.taskVersion),
      method:  'pause',
      id,
      _sid:    sid,
    });
    const resp = await fetch(`${base}/${apis.taskPath}`, { method: 'POST', body });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

async function apiResumeTask(id) {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const body = new URLSearchParams({
      api:     'SYNO.DownloadStation.Task',
      version: String(apis.taskVersion),
      method:  'resume',
      id,
      _sid:    sid,
    });
    const resp = await fetch(`${base}/${apis.taskPath}`, { method: 'POST', body });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

/**
 * Pause or resume several tasks in one call — both methods take a
 * comma-separated id list, same as delete.
 */
async function apiBulkTaskAction(method, ids) {
  if (ids.length === 0) return { success: true, affected: 0 };
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const body = new URLSearchParams({
      api:     'SYNO.DownloadStation.Task',
      version: String(apis.taskVersion),
      method,
      id:      ids.join(','),
      _sid:    sid,
    });
    const resp = await fetch(`${base}/${apis.taskPath}`, { method: 'POST', body });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

/**
 * Apply a bulk action to whichever tasks currently match `pick`.
 * The id list has to be fetched first — the API has no "all" shorthand.
 */
async function bulkOverTasks(method, pick) {
  const listed = await apiListTasks();
  if (!listed.success) return { success: false, error: listed.error };

  const ids = (listed.data?.tasks ?? []).filter(pick).map(t => t.id);
  if (ids.length === 0) return { success: true, affected: 0 };

  const result = await apiBulkTaskAction(method, ids);
  return { ...result, affected: ids.length };
}

const PAUSABLE  = new Set(['downloading', 'waiting', 'filehosting_waiting']);
const RESUMABLE = new Set(['paused', 'stopped']);

/**
 * Download Station has no "retry" method — an errored task can only be
 * removed and queued again from its original URI, which the list call
 * returns under additional.detail.uri.
 */
async function apiRetryTask(id, uri, unzipPassword) {
  if (!uri) throw new Error(msg('errTask408'));
  const removed = await apiDeleteTasks([id]);
  if (!removed.success) return removed;
  return apiAddTask(uri, unzipPassword);
}

/**
 * Upload a .torrent / .nzb file as a new task. The file travels from the popup
 * as a plain ArrayBuffer — File objects do not survive runtime messaging
 * reliably — and is rebuilt into a multipart body here.
 */
async function apiAddTaskFile(name, buffer, unzipPassword) {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);

    const form = new FormData();
    form.append('api', 'SYNO.DownloadStation.Task');
    form.append('version', String(apis.taskVersion));
    form.append('method', 'create');
    form.append('_sid', sid);
    if (settings.defaultDestination) form.append('destination', settings.defaultDestination);
    if (unzipPassword) form.append('unzip_password', unzipPassword);
    // Field name must be "file"; the filename is what Download Station shows.
    form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), name);

    const resp = await fetch(`${base}/${apis.taskPath}`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

async function addTaskFiles(files, unzipPassword) {
  if (!await requireSetup()) {
    return { success: false, setupRequired: true, error: { message: msg('setupRequired') } };
  }

  let added = 0;
  let failed = 0;
  const errors = [];

  for (const { name, buffer } of files) {
    try {
      const result = await apiAddTaskFile(name, buffer, unzipPassword);
      if (result.success) added++;
      else { failed++; errors.push(result.error?.code ?? 'unknown'); }
    } catch (err) {
      failed++;
      errors.push(err.message);
    }
  }

  if (added > 0) startDownloadPolling();

  const reason = failed === 0 ? null : await describeTaskError(errors[0]);
  browser.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon-48.png',
    title:   failed === 0 ? msg('extensionName') : msg('notifyPartial'),
    message: failed === 0
      ? msg('notifyBulkAdded', String(added))
      : msg('notifyBulkPartial', String(added), String(failed), reason),
  });

  return { success: failed === 0, added, failed, errors, errorMessage: reason };
}

// Download Station rejects task creation with more than 50 URIs per call,
// so bulk adds are split into batches of this size.
const MAX_URIS_PER_TASK_CALL = 50;

async function apiAddTaskBatch(urls, unzipPassword) {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const endpoint = `${base}/${apis.taskPath}`;

    const body = new URLSearchParams({
      api:     'SYNO.DownloadStation.Task',
      version: String(apis.taskVersion),
      method:  'create',
      uri:     urls.join(','),
      _sid:    sid,
    });
    if (settings.defaultDestination) {
      body.set('destination', settings.defaultDestination);
    }
    if (unzipPassword) {
      body.set('unzip_password', unzipPassword);
    }

    const resp = await fetch(endpoint, { method: 'POST', body });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function addDownloadTasksBulk(urls, unzipPassword) {
  if (!await requireSetup()) {
    return { success: false, setupRequired: true, error: { message: msg('setupRequired') } };
  }

  const batches = chunk(urls, MAX_URIS_PER_TASK_CALL);
  let added = 0;
  let failed = 0;
  const errors = [];

  for (const batch of batches) {
    try {
      const result = await apiAddTaskBatch(batch, unzipPassword);
      if (result.success) {
        added += batch.length;
      } else {
        failed += batch.length;
        errors.push(result.error?.code ?? 'unknown');
      }
    } catch (err) {
      failed += batch.length;
      errors.push(err.message);
    }
  }

  // Also refreshes the badge right away via its immediate first tick.
  if (added > 0) startDownloadPolling();

  const reason = failed === 0 ? null : await describeTaskError(errors[0]);

  browser.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon-48.png',
    title:   failed === 0 ? msg('extensionName') : msg('notifyPartial'),
    message: failed === 0
      ? msg('notifyBulkAdded', String(added))
      : msg('notifyBulkPartial', String(added), String(failed), reason),
  });

  return { success: failed === 0, added, failed, errors, errorMessage: reason };
}

/**
 * Download Station's own info: build version and, more usefully here,
 * is_manager — whether this account may change server-wide settings such as
 * auto-extract. Unlike getconfig this needs no admin privilege.
 */
async function apiGetInfo() {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const url = `${base}/${apis.infoPath}` +
      `?api=SYNO.DownloadStation.Info&version=${apis.infoVersion}&method=getinfo` +
      `&_sid=${encodeURIComponent(sid)}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

/** Total transfer rates across all tasks, in bytes/s. */
async function apiStatistics() {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const url = `${base}/${apis.statPath}` +
      `?api=SYNO.DownloadStation.Statistic&version=${apis.statVersion}&method=getinfo` +
      `&_sid=${encodeURIComponent(sid)}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

async function apiListTasks() {
  return withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const url = `${base}/${apis.taskPath}` +
      `?api=SYNO.DownloadStation.Task&version=${apis.taskVersion}&method=list` +
      `&additional=detail,transfer&_sid=${encodeURIComponent(sid)}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  });
}

async function apiTestConnection() {
  await stateReady;
  const settings = await getSettings();
  clearAll(); // force fresh discovery + login
  try {
    const apis = await discoverApiPaths(settings.protocol, settings.host, settings.port);
    await getSession(settings);
    return {
      success: true,
      info: {
        authVersion: apis.authVersion,
        taskVersion: apis.taskVersion,
        authPath:    apis.authPath,
      },
    };
  } catch (err) {
    return { success: false, error: { message: err.message } };
  }
}

// ---------------------------------------------------------------------------
// Download task helper
// ---------------------------------------------------------------------------

/**
 * Bail out before touching the API when the connection was never set up.
 * Flags the popup so it opens on the Settings tab with the missing fields
 * marked, and opens it for the user when the browser allows it (a download
 * started from a context menu has no popup open yet).
 */
async function requireSetup() {
  await stateReady;
  const settings = await getSettings();
  if (isConfigured(settings)) return true;

  await browser.storage.session.set({ setupRequired: true });
  browser.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon-48.png',
    title:   msg('setupRequiredShort'),
    message: msg('setupRequired'),
  });
  // Only allowed in response to a user gesture; ignore when it isn't.
  try { await browser.action.openPopup(); } catch {}
  return false;
}

async function addDownloadTask(url) {
  if (!await requireSetup()) {
    return { success: false, setupRequired: true, error: { message: msg('setupRequired') } };
  }
  try {
    const result = await apiAddTask(url);
    if (result.success) {
      browser.notifications.create({
        type:    'basic',
        iconUrl: 'icons/icon-48.png',
        title:   msg('extensionName'),
        message: msg('notifyAdded'),
      });
      // Also refreshes the badge right away via its immediate first tick.
      startDownloadPolling();
    } else {
      const code = result.error?.code ?? 'unknown';
      browser.notifications.create({
        type:    'basic',
        iconUrl: 'icons/icon-48.png',
        title:   msg('notifyFailed'),
        message: await describeTaskError(code),
      });
    }
    return result;
  } catch (err) {
    browser.notifications.create({
      type:    'basic',
      iconUrl: 'icons/icon-48.png',
      title:   msg('notifyError'),
      message: err.message,
    });
    return { success: false, error: { message: err.message } };
  }
}

// ---------------------------------------------------------------------------
// Keepalive worker
// ---------------------------------------------------------------------------

/**
 * Create or remove the repeating keepalive alarm based on the current
 * setting. When enabled it pings the NAS every 3 minutes so the cached SID
 * stays valid and the popup shows "Connected" instantly on open — at the
 * cost of the NAS never seeing the extension go idle, which can prevent
 * disks from spinning down. Off by user choice, so re-checked whenever
 * settings are saved, not just on install/startup.
 */
async function syncKeepaliveAlarm() {
  const settings = await getSettings();
  if (settings.keepaliveEnabled) {
    browser.alarms.create('download-station-keepalive', { periodInMinutes: 3 });
  } else {
    browser.alarms.clear('download-station-keepalive');
  }
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'download-station-keepalive') return;
  await stateReady;
  if (!cachedSid) return; // No active session — nothing to keep alive

  try {
    const result = await apiListTasks();
    if (result.success) {
      updateBadge(result.data?.tasks ?? []);
    } else if (SESSION_ERROR_CODES.has(result.error?.code)) {
      clearSession();
      // Badge preserved — session will be re-established on next wake
    }
  } catch {
    clearSession();
    // Badge preserved — transient network error, downloads still running
  }
});

// ---------------------------------------------------------------------------
// Download polling — watches active tasks until they're done, independent
// of the "keep session alive" setting. Starts when a task is added, stops
// itself once nothing is downloading/processing any more (paused, finished,
// seeding and errored tasks don't count, so an all-paused queue goes quiet).
// ---------------------------------------------------------------------------

const POLL_ALARM = 'download-station-poll';
const ACTIVE_STATUSES = new Set([
  'downloading', 'waiting', 'extracting', 'finishing', 'hash_checking', 'filehosting_waiting',
]);

/**
 * Begin (or restart) the poll loop and run one tick straight away, so the
 * badge reflects the new task immediately instead of a minute later.
 */
function startDownloadPolling() {
  browser.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  pollDownloads();
}

/**
 * True while the popup is open. Tracked through a port so it clears itself
 * when the popup is dismissed — used to avoid logging out from under a popup
 * that is still refreshing.
 */
let popupOpen = false;

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupOpen = true;
  port.onDisconnect.addListener(() => { popupOpen = false; });
});

async function pollDownloads() {
  await stateReady;
  if (!cachedSid) {
    browser.alarms.clear(POLL_ALARM);
    return;
  }

  try {
    const result = await apiListTasks();
    if (!result.success) return;

    const tasks = result.data?.tasks ?? [];
    updateBadge(tasks);

    const stillActive = tasks.some(t => ACTIVE_STATUSES.has(t.status?.toLowerCase()));
    if (!stillActive) {
      browser.alarms.clear(POLL_ALARM);
      // Nothing left to watch. With keepalive off the user has asked us not
      // to hold the session, so hand it back instead of letting it time out.
      const { keepaliveEnabled } = await getSettings();
      if (!keepaliveEnabled && !popupOpen) await apiLogout();
    }
  } catch {
    // Transient network error — leave the alarm running, try again next tick.
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollDownloads();
});

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

function setupContextMenus() {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id:       'download-station-add',
      title:    msg('contextMenuTitle'),
      // 'selection' covers sites that fake links with JS/styling instead of
      // a real <a href>, where the browser never fires the 'link' context.
      // 'editable' covers the same case inside text inputs/textareas, e.g.
      // a magnet link a site shows in a read-to-copy text field.
      contexts: ['link', 'selection', 'editable'],
    });
  });
}

/**
 * Matches text starting with a scheme we can actually hand to Download Station.
 * Deliberately an explicit list rather than a generic `scheme:` pattern, which
 * would treat any "Word: rest of sentence" selection as a link.
 */
const URI_LIKE = /^(https?|ftps?|sftp|magnet|ed2k|thunder|flashget|qqdl):/i;

/**
 * Pull every link out of a text selection. A selection is very often a whole
 * list of links, so it is split on whitespace rather than treated as one URI —
 * otherwise the entire block would be handed to the NAS as a single task.
 */
function extractUris(text) {
  if (!text) return [];
  return text.split(/\s+/).map(s => s.trim()).filter(s => URI_LIKE.test(s));
}

// The item's visibility is sticky once set, so every onShown must set it
// explicitly — returning early on a real link would leave it hidden from a
// previous non-URL selection.
browser.contextMenus.onShown.addListener(async (info) => {
  const visible = !!info.linkUrl || extractUris(info.selectionText).length > 0;
  browser.contextMenus.update('download-station-add', { visible });
  browser.contextMenus.refresh();
});

browser.contextMenus.onClicked.addListener((info) => {
  if (info.linkUrl) {
    addDownloadTask(info.linkUrl);
    return;
  }
  const uris = extractUris(info.selectionText);
  if (uris.length === 1)     addDownloadTask(uris[0]);
  else if (uris.length > 1)  addDownloadTasksBulk(uris);
});

// ---------------------------------------------------------------------------
// Message handler (content.js + popup.js)
// ---------------------------------------------------------------------------

/**
 * Answer a message with the result of `promise`, turning a rejection into a
 * proper error response. Without this a thrown login error (bad credentials,
 * unreachable NAS) would leave sendResponse uncalled, and the popup would
 * report "Could not reach background" instead of the real reason.
 */
function respondWith(promise, sendResponse) {
  promise
    .then(sendResponse)
    .catch((err) => sendResponse({
      success: false,
      error: { message: err?.message ?? String(err) },
    }));
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case 'magnetClicked':
      respondWith(addDownloadTask(message.url), sendResponse);
      return true;

    case 'addTask':
      respondWith(addDownloadTask(message.url), sendResponse);
      return true;

    case 'addTasksBulk':
      respondWith(addDownloadTasksBulk(message.urls, message.unzipPassword), sendResponse);
      return true;

    case 'listTasks':
      respondWith(apiListTasks().then(async (r) => {
        if (!r.success && typeof r.error?.code === 'number') {
          r.error.message = await describeTaskError(r.error.code);
        }
        return r;
      }), sendResponse);
      return true;

    case 'testConnection':
      respondWith(apiTestConnection(), sendResponse);
      return true;

    case 'pauseTask':
      respondWith(apiPauseTask(message.id), sendResponse);
      return true;

    case 'resumeTask':
      respondWith(apiResumeTask(message.id), sendResponse);
      return true;

    case 'deleteTask':
      respondWith(apiDeleteTasks([message.id]), sendResponse);
      return true;

    case 'retryTask':
      respondWith(
        apiRetryTask(message.id, message.uri, message.unzipPassword).then((r) => {
          if (r.success) startDownloadPolling();
          return r;
        }),
        sendResponse,
      );
      return true;

    case 'pauseAll':
      respondWith(
        bulkOverTasks('pause', t => PAUSABLE.has(t.status?.toLowerCase())),
        sendResponse,
      );
      return true;

    case 'resumeAll':
      respondWith(
        bulkOverTasks('resume', t => RESUMABLE.has(t.status?.toLowerCase()))
          .then((r) => {
            if (r.success && r.affected > 0) startDownloadPolling();
            return r;
          }),
        sendResponse,
      );
      return true;

    case 'deleteAll':
      respondWith(bulkOverTasks('delete', () => true), sendResponse);
      return true;

    case 'addTaskFiles':
      respondWith(addTaskFiles(message.files, message.unzipPassword), sendResponse);
      return true;

    case 'getDsInfo':
      respondWith(apiGetInfo(), sendResponse);
      return true;

    case 'getStatistics':
      respondWith(apiStatistics(), sendResponse);
      return true;

    case 'consumeSetupFlag':
      // Read-and-clear, so the popup only jumps to Settings once per attempt.
      browser.storage.session.get({ setupRequired: false }).then(({ setupRequired }) => {
        if (setupRequired) browser.storage.session.remove('setupRequired');
        sendResponse({ setupRequired });
      });
      return true;

    case 'clearCompleted':
      respondWith(apiListTasks().then(r => {
        if (!r.success) return { success: false, error: r.error };
        // Only genuinely completed tasks. Seeding torrents are still doing
        // work and get their own remove button instead of being swept up.
        const ids = (r.data?.tasks ?? [])
          .filter(t => t.status?.toLowerCase() === 'finished')
          .map(t => t.id);
        if (ids.length === 0) return { success: true, removed: 0 };
        return apiDeleteTasks(ids).then(d => ({ ...d, removed: ids.length }));
      }), sendResponse);
      return true;

    case 'getStatus':
      // Wait for cachedSid to be restored from storage.session before replying
      stateReady.then(() => {
        sendResponse({ connected: cachedSid !== null });
      });
      return true; // keep message channel open for async response

    case 'settingsUpdated':
      // The old session belongs to the old host/account and will never be
      // used again — release it before dropping the credentials for it.
      apiLogout()
        .catch(() => {})
        .then(() => {
          clearAll(); // host/port/protocol may have changed
          return syncKeepaliveAlarm();
        })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Extension install / startup
// ---------------------------------------------------------------------------

browser.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  syncKeepaliveAlarm();
});

browser.runtime.onStartup?.addListener(() => {
  setupContextMenus();
  syncKeepaliveAlarm();
});
