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
let cachedConnection = null;

/**
 * Ids of tasks seen running during the current watch. Kept so the closing
 * notification can say what became of them rather than just "done", and
 * mirrored to storage.session so a background restart mid-download does not
 * lose the tally. Declared here because stateReady below restores it.
 */
let watchedIds = new Set();

/**
 * Polls in a row that failed, towards the limit that ends the watch. Mirrored
 * for the same reason as the tally: Firefox unloads an idle event page after
 * about half a minute, often between two ticks a minute apart, and a count kept
 * only in memory could start from zero again at the next one.
 */
let pollFailures = 0;

/**
 * When the NAS last accepted a session, and which session it was. A call that
 * succeeded has done the keepalive's job, so a keepalive due within one period
 * of it has nothing left to do — with the watch polling every minute, it used
 * to add twenty full task lists an hour. Mirrored like the rest, or a freshly
 * loaded event page asked again straight away. The id ties the time to its
 * session: a newer session has not been kept alive by the older one's calls.
 */
let sessionUsed = { sid: null, at: -Infinity };
/** What was last written of it — see noteSessionUsed. */
let sessionUsedStored = null;

// Restore persisted state on startup.
// Stored as a Promise so every entry point (alarms, messages, context menus)
// can await it before touching cachedSid / cachedApiPaths, preventing a race
// between the async read and the first incoming event that wakes the script.
const stateReady = browser.storage.session
  .get({ sid: null, apiPaths: null, sessionConnection: null, watchedIds: [], pollFailures: 0, sessionUsed: null })
  .then(async ({ sid, apiPaths, sessionConnection, watchedIds: stored, pollFailures: failures, sessionUsed: used }) => {
    if (sid) {
      cachedSid = sid;
      cachedConnection = sessionConnection ?? connectionSettings(await getSettings());
    }
    if (apiPaths) cachedApiPaths = apiPaths;
    if (Array.isArray(stored) && stored.length) watchedIds = new Set(stored);
    if (Number.isInteger(failures) && failures > 0) pollFailures = failures;
    if (typeof used?.sid === 'string' && Number.isFinite(used.at)) sessionUsed = sessionUsedStored = used;
  });

// ---------------------------------------------------------------------------
// Default settings — shared with the popup, see actions.js
// ---------------------------------------------------------------------------
const DEFAULTS = SETTINGS_DEFAULTS;

const isConfigured = hasCredentials;

/** Which setting governs each kind of notification. */
const NOTIFY_SETTING = {
  added:    'notifyOnAdded',
  failed:   'notifyOnFailed',
  finished: 'notifyOnFinished',
};

/**
 * Show a notification about a download, if the user wants that kind.
 *
 * Everything routed through here concerns individual downloads, and every one
 * of them can be silenced — the master switch turns off all three at once.
 * What must never be silenced goes through `notifyAlways` instead: a failed
 * sign-in or a broken destination folder stops *every* download, and with the
 * message suppressed the extension would simply appear to do nothing.
 */
async function notify(category, title, message) {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;
  if (!settings[NOTIFY_SETTING[category]]) return;
  notifyAlways(title, message);
}

function notifyAlways(title, message) {
  browser.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon-48.png',
    title,
    message,
  });
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
 * Errors that mean the setup is wrong, not that one link was bad:
 * 105 the account may not use Download Station, 402 destination denied,
 * 403 destination does not exist, 406 no default destination at all,
 * 407 setting the destination failed.
 *
 * Every one of these breaks *every* download until it is fixed, so like a
 * sign-in failure they are reported even with notifications switched off.
 * A link the NAS simply could not fetch is not in here — that is one download,
 * and silencing those is exactly what the setting is for.
 */
const CONFIG_ERROR_CODES = new Set([105, 402, 403, 406, 407]);
const isConfigError = (code) => CONFIG_ERROR_CODES.has(code);

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

/**
 * A single request may take this long before it counts as no answer. Kept
 * short on purpose — waiting on a request that will not arrive is wasted
 * time when the next attempt is only ten seconds away anyway.
 */
const REQUEST_TIMEOUT_MS = 8000;
/**
 * The same limit for a call that gets only one attempt.
 *
 * A create is not repeated, so its deadline is final: run out of time and the
 * download is reported as failed even though the NAS may be about to accept it.
 * Eight seconds is right for something that will be tried again in ten; for
 * something that will not, it is a false verdict waiting to happen.
 *
 * It does not need to cover a sleeping NAS — nothing is written until wakeNas
 * has had an answer — only a NAS that is awake and briefly busy, plus the time
 * to push a torrent file up. Twelve seconds is generous for that.
 */
const WRITE_TIMEOUT_MS = 12000;
/**
 * Added on top for every URI in a batch.
 *
 * Download Station queues all of them before it answers, so the work behind one
 * request grows with the batch while a fixed deadline would not. Fifty links —
 * the most the API takes at once — get 27 seconds rather than 12.
 */
const PER_URI_TIMEOUT_MS = 300;
/** Wait before trying again, giving a waking NAS time to finish. */
const RETRY_DELAY_MS = 10000;
/**
 * Attempts per call. How long that adds up to depends on how the NAS refuses:
 * a spun-down box usually rejects the connection at once, which is three waits
 * and about 30 seconds. One that accepts the connection and then says nothing
 * costs four timeouts on top, so a little over a minute. Both are shorter than
 * the wait for disks to spin up, which is the point.
 */
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, with "did not answer" told apart from "answered no".
 * fetch itself only rejects when nothing came back at all: refused connection,
 * DNS failure, TLS handshake gone wrong, or our own timeout.
 */
async function fetchOnce(input, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  let resp;
  try {
    resp = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    const err = new Error(msg('errNasUnreachable'));
    err.nasUnreachable = true;
    // Fetch does not say whether a network error happened before or after the
    // request reached the NAS. TypeError is not proof that nothing was sent.
    err.deliveryUnknown = true;
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    // A NAS that is still starting its services answers 502/503 for a while.
    if (resp.status >= 500) {
      err.nasUnreachable = true;
      // It reached something. Whether that something passed it on is unknowable.
      err.deliveryUnknown = true;
    }
    throw err;
  }
  return resp;
}

/**
 * fetch that waits out a sleeping NAS.
 *
 * With disks spun down — or the whole box in hibernation — the first request
 * is refused and the NAS only becomes reachable half a minute later. Reporting
 * a failure straight away would mean the user sees an error for something that
 * fixes itself, so an unanswered request is quietly repeated. An answer that
 * simply says no (wrong password, missing folder) is returned immediately:
 * repeating that would only delay a message the user needs to see.
 *
 * Only reads and other repeatable operations may be retried. A failed fetch
 * cannot prove that a create was not already processed by the NAS.
 */
async function apiFetch(input, init, { repeatable = true, timeout } = {}) {
  const deadline = timeout ?? (repeatable ? REQUEST_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(input, init, deadline);
    } catch (err) {
      const mayRepeat = repeatable && err.nasUnreachable;
      if (!mayRepeat || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** Reading the response is part of a write's uncertain delivery window. */
async function readCreateResponse(response) {
  try {
    const result = await response.json();
    if (!result || typeof result.success !== 'boolean') throw new Error();
    return result;
  } catch {
    const error = new Error(msg('notifyUncertain'));
    error.deliveryUnknown = true;
    throw error;
  }
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
  const epoch = sessionEpoch;

  const fallback = {
    authPath:       'auth.cgi',
    authVersion:    3,
    taskPath:       'DownloadStation/task.cgi',
    taskVersion:    3,
  };

  try {
    const query = encodeURIComponent(
      'SYNO.API.Auth,SYNO.DownloadStation.Task'
    );
    const url = `${protocol}://${host}:${port}/webapi/query.cgi` +
      `?api=SYNO.API.Info&version=1&method=query&query=${query}`;

    // No retry here on purpose: the well-known fallback paths are right for
    // every standard DSM, and the login that follows does the waiting.
    const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!resp.ok) return fallback;
    const json = await resp.json();
    if (!json.success) return fallback;

    const authInfo = json.data['SYNO.API.Auth'];
    const taskInfo = json.data['SYNO.DownloadStation.Task'];

    const discovered = {
      authPath:    authInfo?.path ?? fallback.authPath,
      authVersion: pickVersion(authInfo, VERSION_CEILING.auth, fallback.authVersion),
      taskPath:    taskInfo?.path ?? fallback.taskPath,
      taskVersion: pickVersion(taskInfo, VERSION_CEILING.task, fallback.taskVersion),
    };
    if (epoch === sessionEpoch) {
      cachedApiPaths = discovered;
      browser.storage.session.set({ apiPaths: discovered });
    }
    return discovered;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Session / Auth
// ---------------------------------------------------------------------------

/** Auth error codes for the two-step verification flow. */
const OTP_REQUIRED_CODE = 403;
const OTP_WRONG_CODE    = 404;

/** Shown in DSM's trusted-devices list once a device token is issued. */
const DEVICE_NAME = 'Firefox - Download Station Manager';

/**
 * Log in and return the session ID and optional device token. The caller
 * commits both only if the connection is still current.
 *
 * Two-step verification: DSM answers 403 when it wants a code. The caller
 * then asks the user for one and calls again with `otpCode`; that login also
 * requests a device token, which is sent on every later login so
 * background work never needs a code again.
 *
 * Throws on failure. A 403 carries `otpRequired` so callers can tell "needs a
 * code" apart from "wrong credentials".
 */
async function login(settings, otpCode, knownApis) {
  const { protocol, host, port, username, password } = settings;
  if (!isConfigured(settings)) {
    throw new Error(msg('setupRequired'));
  }
  // Callers that already resolved the paths pass them in. Discovery has its own
  // timeout, and with an unreachable NAS repeating it here doubled the wait
  // before the caller ever got an answer.
  const apis = knownApis ?? await discoverApiPaths(protocol, host, port);
  const base = buildBaseUrl(protocol, host, port);

  const { deviceToken } = await browser.storage.local.get({ deviceToken: '' });

  const params = new URLSearchParams({
    api:      'SYNO.API.Auth',
    version:  String(apis.authVersion),
    method:   'login',
    account:  username,
    passwd:   password,
    session:  'DownloadStation',
    format:   'sid',
  });

  if (otpCode) {
    // Ask DSM to remember us, so this is the only time a code is needed.
    params.set('otp_code', otpCode);
    params.set('enable_device_token', 'yes');
    params.set('device_name', DEVICE_NAME);
  } else if (deviceToken) {
    params.set('device_id', deviceToken);
  }

  // POST, not GET: a query string is written to the NAS's own web server log,
  // which would leave the account password there in plain text on every login.
  const resp = await apiFetch(`${base}/${apis.authPath}`, { method: 'POST', body: params });
  const json = await resp.json();

  if (!json.success) {
    const code = json.error?.code;
    const err = new Error(msg('errLoginFailed', describeError(AUTH_ERRORS, code ?? 'unknown')));
    // Marks this as a sign-in problem, which is reported even with
    // notifications switched off.
    err.authFailed = true;
    if (code === OTP_REQUIRED_CODE) err.otpRequired = true;
    if (code === OTP_WRONG_CODE)    err.otpWrong = true;
    throw err;
  }

  // The token is present only on the login that asked for one.
  if (!json.data?.sid) throw new Error(msg('connectionFailed'));
  return { sid: json.data.sid, deviceToken: json.data.did || json.data.device_id };
}

/**
 * A login already on its way. Opening the popup fires several calls at once
 * (status, task list, the poll alarm's first tick); without this they would
 * each see an empty cache and open their own session on the NAS.
 */
let loginInFlight = null;

/**
 * Bumped whenever the configured NAS or account changes. A login that was
 * already on its way when that happened belongs to the old target, so its
 * session must not end up in the cache.
 */
let sessionEpoch = 0;

// Settings changes and login commits share one queue. A login response cannot
// write a token back after a sign-out has already removed it.
let settingsWriteQueue = Promise.resolve();

function queueSettingsWrite(fn) {
  const run = settingsWriteQueue.then(fn);
  settingsWriteQueue = run.catch(() => {});
  return run;
}

function checkSessionEpoch(epoch) {
  if (epoch === sessionEpoch) return;
  const error = new Error(msg('connectionFailed'));
  error.connectionChanged = true;
  throw error;
}

/**
 * Whether the connection an add was meant for has been replaced since `epoch`
 * was taken. Waits for a change still being written, so a half-saved one
 * counts. Without an epoch the caller did not bind the add to a connection.
 *
 * `connection` is the key the popup took before it began preparing the add.
 * The epoch only starts counting once the message has arrived, and reading a
 * torrent file takes long enough for a new connection to be saved before that:
 * the upload then went to the NAS saved meanwhile.
 */
async function connectionChangedSince(epoch, connection) {
  if (epoch === undefined && connection === undefined) return false;
  await stateReady;
  await settingsWriteQueue;
  if (epoch !== undefined && epoch !== sessionEpoch) return true;
  return connection !== undefined && connection !== connectionKey(await getSettings());
}

/**
 * Check that an action on listed tasks still aims at the connection the list
 * came from, and return the epoch to run it under.
 *
 * The popup's list outlives the connection it was fetched from: it stays on
 * screen while a new NAS is being saved. An id taken from it then named
 * whatever task has that id on the new NAS, and "Delete" deleted that one. So
 * every action carries the key its list arrived with and is refused otherwise.
 * The returned epoch still stops a change that begins after this check.
 */
async function taskActionEpoch(expected) {
  await stateReady;
  await settingsWriteQueue;
  const epoch = sessionEpoch;
  if (expected !== connectionKey(await getSettings())) {
    const error = new Error(msg('taskListStale'));
    error.connectionChanged = true;
    throw error;
  }
  return epoch;
}

function acceptLogin(result, settings, apis, epoch) {
  return queueSettingsWrite(async () => {
    if (epoch !== sessionEpoch) {
      await logoutSession(result.sid, settings, apis);
      checkSessionEpoch(epoch);
    }
    cachedSid = result.sid;
    cachedConnection = connectionSettings(settings);
    await browser.storage.session.set({ sid: cachedSid, sessionConnection: cachedConnection });
    if (result.deviceToken) await browser.storage.local.set({ deviceToken: result.deviceToken });
    return cachedSid;
  });
}

/**
 * Get a valid session ID, logging in if necessary.
 */
function getSession(settings, knownApis, { force = false } = {}) {
  if (cachedSid && !force) return Promise.resolve(cachedSid);
  if (!loginInFlight) {
    const epoch = sessionEpoch;
    let attempt;
    attempt = login(settings, undefined, knownApis)
      .then(result => acceptLogin(result, settings, knownApis, epoch))
      // Only clear the slot if it is still ours — a settings change may have
      // started a newer login in the meantime.
      .finally(() => { if (loginInFlight === attempt) loginInFlight = null; });
    loginInFlight = attempt;
  }
  return loginInFlight;
}

/** Clear cached session ID (keeps API path cache — same NAS). */
function clearSession() {
  cachedSid = null;
  cachedConnection = null;
  return browser.storage.session.remove(['sid', 'sessionConnection']);
}

/**
 * Hand the session back to the NAS instead of leaving it to time out.
 * Best effort: if it fails the session is lost to us either way, and there
 * is nothing the user could do about it.
 *
 * Dropped here before it is handed back, not after. The other way round, a
 * download starting while the logout was still on its way was given the old
 * id; the logout cleared it from under that download once it returned, and the
 * next poll ended the watch for lack of a session. Dropped first, anything that
 * starts in the meantime signs in afresh.
 */
async function apiLogout() {
  await stateReady;
  const sid = cachedSid;
  if (!sid) return;
  const connection = cachedConnection;
  const apis = cachedApiPaths;
  // No await between reading the id and taking it out of circulation.
  const dropped = clearSession();
  const settings = connection ?? connectionSettings(await getSettings());
  await dropped;
  await logoutSession(sid, settings, apis);
}

async function logoutSession(sid, settings, apis) {
  if (!sid) return;
  try {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    // POST for the same reason as login — keeps the session id out of the log.
    // Not retried: handing the session back is a courtesy, and if the NAS is
    // asleep it has forgotten the session anyway.
    await fetch(`${base}/${apis?.authPath ?? 'auth.cgi'}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: 'POST',
      body: new URLSearchParams({
        api:     'SYNO.API.Auth',
        version: String(apis?.authVersion ?? 3),
        method:  'logout',
        session: 'DownloadStation',
        _sid:    sid,
      }),
    });
  } catch {
    // Network gone, NAS asleep — nothing useful to report.
  }
}

/** Clear everything (call when host/port/protocol changes). */
function clearAll() {
  cachedSid      = null;
  cachedApiPaths = null;
  cachedConnection = null;
  // Anything still logging in was aimed at the old NAS — disown it.
  sessionEpoch++;
  loginInFlight = null;
  // Badge is intentionally NOT cleared here — active downloads may still be
  // running on the NAS. Only updateBadge() clears it when count reaches 0.
  return browser.storage.session.remove(['sid', 'apiPaths', 'sessionConnection']);
}

/** Apply a connection change while its previous endpoint is still known. */
function updateSettings({ connection, options = {}, signOut = false, reset = false }) {
  return queueSettingsWrite(async () => {
    await stateReady;
    const previous = await getSettings();
    const next = reset ? { ...DEFAULTS } : signOut
      ? { ...previous, username: '', password: '' }
      : { ...previous, ...connection };
    const changed = reset || signOut || CONNECTION_KEYS.some(key => previous[key] !== next[key]);

    if (changed) {
      const oldSid = cachedSid;
      const oldConnection = cachedConnection ?? connectionSettings(previous);
      const oldApis = cachedApiPaths;
      await clearAll();
      browser.alarms.clear(POLL_ALARM);
      clearWatched();
      // Counted against the old connection. Left standing, it would also let a
      // poll without a session sign in to the new one — see runPoll.
      setPollFailures(0);
      if (reset) await browser.storage.local.clear();
      await browser.storage.local.remove('deviceToken');
      await browser.storage.local.set(connectionSettings(next));
      await logoutSession(oldSid, oldConnection, oldApis);
      updateBadge([]);
    }

    // Connection fields and trusted-device tokens are never option writes.
    const optionValues = Object.fromEntries(Object.entries(options)
      .filter(([key]) => !CONNECTION_KEYS.includes(key) && key !== 'deviceToken'));
    await browser.storage.local.set(optionValues);
    await syncKeepaliveAlarm();
    return { ok: true };
  });
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

/**
 * Codes that are worth one more attempt with a fresh session: 106 timeout,
 * 107 interrupted by a duplicate login, 119 the code DSM documents for an
 * invalid session id — what a cached id turns into after the NAS restarted.
 *
 * Stale ids matter more now that a keepalive without an answer keeps the
 * session. Clearing it there used to be the only way out of one, and it ended
 * the download watch as a side effect.
 *
 * 105 is ambiguous. The guide calls it "the logged in session does not have
 * permission", which re-authenticating cannot fix — but DSM also answers 105
 * for a session id it does not recognise, where it can: the Download Station
 * endpoint of a DSM 7 test NAS did exactly that for a made-up id. It stays
 * in, because the cost of keeping it is one wasted login on a genuinely
 * under-privileged account, while removing it would leave a stale session
 * showing a permission error until the popup is reopened. The retry runs once,
 * and a second 105 is reported as the configuration problem it then is.
 */
const SESSION_ERROR_CODES = new Set([105, 106, 107, 119]);

/**
 * Hand on a sign-in failure as one that sent no download.
 *
 * A login that got no answer carries the "delivery unknown" mark like any other
 * request, and for the login that is true. A create passed it on, though, so a
 * login that timed out was reported as a download the NAS may have taken —
 * before the create had even been sent. The error is copied, not changed: a
 * login in flight is shared, and its other callers get the same object.
 */
async function nothingSent(signIn) {
  try {
    return await signIn;
  } catch (err) {
    if (!err?.deliveryUnknown) throw err;
    throw Object.assign(new Error(err.message), err, { deliveryUnknown: false });
  }
}

/**
 * Execute an API call, re-authenticating once if the session has expired.
 * `apiFn` receives `(settings, sid, apis)` and must return the parsed JSON body.
 */
async function withSession(apiFn, { epoch = sessionEpoch, create = false } = {}) {
  await stateReady;
  await settingsWriteQueue;
  checkSessionEpoch(epoch);
  const settings = await getSettings();
  checkSessionEpoch(epoch);
  const apis = await discoverApiPaths(settings.protocol, settings.host, settings.port);
  checkSessionEpoch(epoch);
  // Signing in sends nothing that could add a download — see nothingSent.
  const signIn = () => (create ? nothingSent(getSession(settings, apis)) : getSession(settings, apis));
  let sid = await signIn();
  checkSessionEpoch(epoch);
  let result = await apiFn(settings, sid, apis);
  if (result.success) noteSessionUsed(sid);
  // A parsed successful create is a known outcome even if the user changed
  // connections while its reply was on the way. Do not offer it again.
  if (create && result.success) return result;
  checkSessionEpoch(epoch);

  if (!result.success && SESSION_ERROR_CODES.has(result.error?.code)) {
    if (cachedSid === sid) await clearSession();
    checkSessionEpoch(epoch);
    sid = await signIn();
    checkSessionEpoch(epoch);
    result = await apiFn(settings, sid, apis);
    if (result.success) noteSessionUsed(sid);
    if (create && result.success) return result;
    checkSessionEpoch(epoch);
  }

  return result;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Read one entry's `error` field: 0 for a task the NAS acted on, a code for one
 * it refused. DSM sends numbers as strings often enough that a numeric string
 * counts too. Everything else — missing, null, unparsable — states nothing, and
 * comes back as null so the caller can keep it apart from a refusal.
 */
function taskResultCode(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const code = Number(value);
    return Number.isFinite(code) ? code : null;
  }
  return null;
}

/**
 * Pause, resume or delete tasks. Every one of these methods takes the same
 * comma-separated id list, and a single task is simply a list of one — which
 * is why there are no separate one-task versions of them.
 *
 * Delete used to have its own function that also sent `force_complete: false`.
 * That is the API's default, so the two were doing the same thing by different
 * routes — and only one of them handled an empty list.
 *
 * The reply is read as three sets, the same way adding a download is: confirmed
 * done, confirmed refused, and unconfirmed. A task the NAS did not mention, or
 * mentioned without a usable code, belongs in the third — counting it as a
 * refusal turns missing information into a claim. One reply can hold all three.
 * The reason this matters beyond wording: a `success: true` without any `data`
 * array used to mark every single task as failed.
 */
async function apiBulkTaskAction(method, ids, epoch = sessionEpoch) {
  if (ids.length === 0) return { success: true, affected: 0, failed: [], unconfirmed: [] };
  const result = await withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const body = new URLSearchParams({
      api:     'SYNO.DownloadStation.Task',
      version: String(apis.taskVersion),
      method,
      id:      ids.join(','),
      _sid:    sid,
    });
    const resp = await apiFetch(`${base}/${apis.taskPath}`, { method: 'POST', body });
    return resp.json();
  }, { epoch });
  if (!result.success) {
    // A parsed error code is a refusal of the whole call, not missing news.
    return { ...result, affected: 0, failed: [], unconfirmed: [], error: {
      ...result.error, message: await describeTaskError(result.error?.code ?? 'unknown'),
    } };
  }

  // A null or non-object entry must not throw here: unreadable is unconfirmed.
  const responses = new Map();
  for (const item of Array.isArray(result.data) ? result.data : []) {
    if (item && typeof item === 'object') responses.set(item.id, taskResultCode(item.error));
  }

  const failed = [], unconfirmed = [];
  let affected = 0;
  for (const id of ids) {
    const code = responses.get(id) ?? null; // never mentioned reads the same as unreadable
    if (code === 0) affected++;
    else if (code === null) unconfirmed.push(id);
    else failed.push({ id, code });
  }

  // One description per code, not per task: a hundred tasks refused for the
  // same reason are one sentence, and phrasing a 403 reads the settings.
  const texts = new Map();
  for (const code of new Set(failed.map(item => item.code))) {
    texts.set(code, await describeTaskError(code));
  }
  const messages = failed.map(item => `${item.id}: ${texts.get(item.code)}`);
  // Not notifyUncertain: the NAS did answer here, just not about these tasks.
  if (unconfirmed.length) messages.push(msg('taskActionUnconfirmed', String(unconfirmed.length)));

  return {
    ...result,
    success: failed.length === 0 && unconfirmed.length === 0,
    affected,
    failed,
    unconfirmed,
    ...(messages.length
      ? { error: { code: failed[0]?.code ?? 'unknown', message: messages.join('\n') } }
      : {}),
  };
}

/**
 * Whether a resumed task may now be running. Unconfirmed is not refused: the
 * task may well have started, and the watch has to cover that — otherwise the
 * one case where the user most needs to see what happened is the one case
 * nothing keeps looking.
 */
function mayBeRunning(result) {
  return result.affected > 0 || (result.unconfirmed?.length ?? 0) > 0;
}

/**
 * Apply a bulk action to whichever tasks currently match `pick`.
 * The id list has to be fetched first — the API has no "all" shorthand.
 */
async function bulkOverTasks(method, pick, connection) {
  // "Delete all" confirmed while looking at the old NAS's list must not clear
  // out the new one — see taskActionEpoch.
  const epoch = await taskActionEpoch(connection);
  const listed = await apiListTasks(epoch);
  if (!listed.success) return { success: false, error: listed.error };

  const ids = (listed.data?.tasks ?? []).filter(pick).map(t => t.id);
  if (ids.length === 0) return { success: true, affected: 0, failed: [], unconfirmed: [] };

  return apiBulkTaskAction(method, ids, epoch);
}

const PAUSABLE  = new Set(['downloading', 'waiting', 'filehosting_waiting']);
const RESUMABLE = new Set(['paused', 'stopped']);

/**
 * Put a link back among the ones waiting in the popup, after whatever is
 * already there. Runs while the add lock is held, when the popup keeps its list
 * read-only and takes the change over, so nothing typed there is lost.
 */
async function keepLinkForLater(uri) {
  const { bulkDraft } = await browser.storage.session.get({ bulkDraft: '' });
  if (bulkDraft.split('\n').some(line => line.trim() === uri)) return;
  const kept = bulkDraft.trimEnd();
  await browser.storage.session.set({ bulkDraft: kept ? `${kept}\n${uri}` : uri });
}

/**
 * Download Station has no "retry" method — an errored task can only be
 * removed and queued again from its original URI, which the list call
 * returns under additional.detail.uri.
 *
 * Queued again in its own folder, `destination`, rather than the default. A NAS
 * without a default destination refuses a create that names none (406), and it
 * did so after the original task was already gone.
 *
 * Removing first leaves a moment with no task at all. A create that failed in
 * that moment used to leave nothing behind; the link now goes back into the
 * popup's list, so the download is one click away once the cause is fixed.
 */
async function apiRetryTask(id, uri, unzipPassword, { epoch = sessionEpoch, destination = '' } = {}) {
  if (!uri) throw new Error(msg('errTask408'));
  // Nothing has been touched yet. The error carries the "delivery unknown" mark
  // of any unanswered request, but here it would be false: nothing was sent.
  try {
    await wakeNas();
  } catch (err) {
    return { success: false, deliveryUnknown: false, error: { message: err.message } };
  }
  const removed = await apiBulkTaskAction('delete', [id], epoch);
  if (!removed.success) return removed;

  let outcome, reason;
  try {
    outcome = await apiAddTaskBatch([uri], unzipPassword, epoch, { destination });
    if (outcome.success) return outcome;
    reason = await describeTaskError(outcome.error?.code ?? 'unknown');
  } catch (err) {
    outcome = { success: false, deliveryUnknown: err.deliveryUnknown === true };
    reason = err.deliveryUnknown ? msg('notifyUncertain') : err.message;
  }

  await keepLinkForLater(uri);
  const message = msg('retryLinkKept', reason);
  return {
    ...outcome,
    linkKept: true,
    error: {
      ...outcome.error,
      message: destination ? `${message} ${msg('retryOriginalFolder', destination)}` : message,
    },
  };
}

/**
 * Upload a .torrent / .nzb file as a new task. The file travels from the popup
 * as a plain ArrayBuffer — File objects do not survive runtime messaging
 * reliably — and is rebuilt into a multipart body here.
 */
async function apiAddTaskFile(name, buffer, unzipPassword, epoch = sessionEpoch) {
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

    // Creating a task is not repeatable — see apiFetch.
    const resp = await apiFetch(`${base}/${apis.taskPath}`, { method: 'POST', body: form },
                                { repeatable: false });
    return readCreateResponse(resp);
  }, { epoch, create: true });
}

async function addTaskFiles(files, unzipPassword, epoch, connection) {
  if (await connectionChangedSince(epoch, connection)) {
    return reportAddOutcome(0, files.length, msg('addConnectionChanged'), {
      failedNames: files.map(f => f.name), deliveryUnknown: false, configError: false,
    });
  }
  if (!await requireSetup()) {
    return { success: false, setupRequired: true, error: { message: msg('setupRequired') } };
  }
  epoch ??= sessionEpoch;

  try {
    await wakeNas();
  } catch (err) {
    return reportAddOutcome(0, files.length, err.message, {
      failedNames: files.map(f => f.name), deliveryUnknown: false, configError: false,
    });
  }

  // Files go up one at a time anyway, so which one failed is known without
  // asking twice.
  const added = [];
  const failed = [];

  for (const { name, buffer } of files) {
    try {
      const result = await apiAddTaskFile(name, buffer, unzipPassword, epoch);
      if (result.success) added.push(name);
      else failed.push({ item: name, code: result.error?.code ?? 'unknown' });
    } catch (err) {
      failed.push({ item: name, unknown: err.deliveryUnknown === true,
        authFailed: err.authFailed, message: err.message });
    }
  }

  return summariseAdd(added, failed, 'failedNames');
}

/**
 * Close out a bulk add: start watching, tell the user, and shape the answer
 * the popup expects.
 *
 * Shared by the two ways of adding several things at once — a list of links
 * and a set of files. They differ only in the loop that produces these three
 * numbers; everything after it was identical, which meant changes like the
 * notification categories had to be made twice.
 */
async function reportAddOutcome(added, failed, reason, extra = {}) {
  if (added > 0) startDownloadPolling();

  const title = failed === 0 ? msg('extensionName') : msg('notifyPartial');
  const body  = failed === 0
    ? msg('notifyBulkAdded', String(added))
    : msg('notifyBulkPartial', String(added), String(failed), reason ?? '');

  // A broken destination stops everything, so it gets through regardless.
  if (failed > 0 && extra.configError) notifyAlways(title, body);
  else notify(failed === 0 ? 'added' : 'failed', title, body);

  return { success: failed === 0, added, failed, errorMessage: reason, ...extra };
}

/**
 * Shape the per-item outcomes into the answer the popup expects. `listKey` says
 * what the failures are called there — links go back into the box to be tried
 * again, file names only get named.
 */
async function summariseAdd(added, failed, listKey) {
  const first = failed[0];
  const reason = failed.length === 0
    ? null
    : (first.code !== undefined ? await describeTaskError(first.code) : first.message);

  return reportAddOutcome(added.length, failed.length, reason, {
    [listKey]:       failed.map(f => f.item),
    deliveryUnknown: failed.some(f => f.unknown),
    configError:     failed.some(f => f.authFailed || isConfigError(f.code)),
  });
}

// Download Station rejects task creation with more than 50 URIs per call,
// so bulk adds are split into batches of this size.
const MAX_URIS_PER_TASK_CALL = 50;

async function apiAddTaskBatch(urls, unzipPassword, epoch = sessionEpoch, { destination = '' } = {}) {
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
    // A retry names the folder its task was in; everything else goes where the
    // settings say, or to the NAS's own default.
    const target = destination || settings.defaultDestination;
    if (target) {
      body.set('destination', target);
    }
    if (unzipPassword) {
      body.set('unzip_password', unzipPassword);
    }

    // Creating a task is not repeatable — see apiFetch. The deadline grows with
    // the batch because the NAS queues every URI before it answers.
    const resp = await apiFetch(endpoint, { method: 'POST', body }, {
      repeatable: false,
      timeout: WRITE_TIMEOUT_MS + urls.length * PER_URI_TIMEOUT_MS,
    });
    return readCreateResponse(resp);
  }, { epoch, create: true });
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * How many links may be asked about individually across one whole add.
 *
 * Naming the culprit is worth an extra round of calls; it is not worth an
 * unbounded one. Someone pasting three hundred links into a NAS with no
 * destination set would otherwise trigger three hundred more requests to be
 * told six times over what the first one already said.
 */
const MAX_ITEMISED = 50;

/**
 * Add one batch and record the outcome per link.
 *
 * The API answers a multi-URI create with a single verdict, so a batch that is
 * refused says nothing about which link it objected to. The only way to find
 * out is to offer them one at a time — done here, but only after a refusal, and
 * only after a parsed API refusal. A network or response-reading failure
 * cannot establish whether the NAS already processed the batch.
 *
 * Two refusals are not worth itemising. A configuration problem — no
 * destination, no permission — turns down every link for the same reason, which
 * the batch already told us. And once the budget is spent the rest are reported
 * together rather than one call at a time.
 */
async function addBatchWithDetail(batch, unzipPassword, added, failed, budget, epoch = sessionEpoch) {
  let refused;
  try {
    const result = await apiAddTaskBatch(batch, unzipPassword, epoch);
    if (result.success) { added.push(...batch); return; }
    refused = { code: result.error?.code ?? 'unknown' };
  } catch (err) {
    for (const item of batch) failed.push({
      item, unknown: err.deliveryUnknown === true, authFailed: err.authFailed,
      message: err.message,
    });
    return;
  }

  const worthAsking = batch.length > 1
    && (refused.code === 400 || refused.code === 408)
    && budget.left >= batch.length;

  if (!worthAsking) {
    for (const item of batch) failed.push({ item, ...refused });
    return;
  }
  budget.left -= batch.length;

  for (const item of batch) {
    try {
      const result = await apiAddTaskBatch([item], unzipPassword, epoch);
      if (result.success) added.push(item);
      else failed.push({ item, code: result.error?.code ?? 'unknown' });
    } catch (err) {
      failed.push({ item, unknown: err.deliveryUnknown === true,
        authFailed: err.authFailed, message: err.message });
    }
  }
}

async function addDownloadTasksBulk(urls, unzipPassword, { announce = false, epoch, connection } = {}) {
  if (await connectionChangedSince(epoch, connection)) {
    return reportAddOutcome(0, urls.length, msg('addConnectionChanged'), {
      failedUrls: [...urls], deliveryUnknown: false, configError: false,
    });
  }
  if (!await requireSetup()) {
    return { success: false, setupRequired: true, error: { message: msg('setupRequired') } };
  }
  epoch ??= sessionEpoch;

  // Nothing has been sent yet, so a NAS that cannot be woken is a clean
  // failure: every link stays in the list and none of them was half-added.
  try {
    await wakeNas({ announce });
  } catch (err) {
    return reportAddOutcome(0, urls.length, err.message, {
      failedUrls: [...urls], deliveryUnknown: false, configError: false,
    });
  }

  const added = [];
  const failed = [];
  // Shared across every batch, so a long list cannot multiply the follow-up
  // calls batch by batch.
  const budget = { left: MAX_ITEMISED };

  for (const batch of chunk(urls, MAX_URIS_PER_TASK_CALL)) {
    await addBatchWithDetail(batch, unzipPassword, added, failed, budget, epoch);
  }

  return summariseAdd(added, failed, 'failedUrls');
}

/**
 * POST rather than GET, for the same reason as the login.
 *
 * These two only read, so a query string looks harmless — but `_sid` in it is a
 * session id, and the NAS writes the whole request line to its own access log.
 * This is the most frequent call the extension makes: once a minute from the
 * poll alarm and every few seconds while the Tasks tab is open, which would
 * leave a working session id in that log hundreds of times a day. Anyone who
 * can read the log could use it until DSM expires the session.
 */
async function apiListTasks(epoch = sessionEpoch) {
  const listSeq = ++listsRequested;
  const result = await withSession(async (settings, sid, apis) => {
    const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
    const body = new URLSearchParams({
      api:        'SYNO.DownloadStation.Task',
      version:    String(apis.taskVersion),
      method:     'list',
      additional: 'detail,transfer',
      _sid:       sid,
    });
    const resp = await apiFetch(`${base}/${apis.taskPath}`, { method: 'POST', body });
    const json = await resp.json();
    // Whose ids these are, and how recent the list is. The popup sends the
    // first back with every action on them; the poll compares the second.
    return { ...json, connection: connectionKey(settings), listSeq };
  }, { epoch });
  if (result.success && listSeq > newestListAnswered) newestListAnswered = listSeq;
  return result;
}

/**
 * Task lists in the order they were asked for, and the newest one that has come
 * back. Every list counts, the popup's every few seconds as much as the poll's
 * once a minute: any of them can show a download running, and an older answer
 * that says otherwise is out of date.
 */
let listsRequested = 0;
let newestListAnswered = 0;

async function apiTestConnection(otpCode) {
  await stateReady;
  await settingsWriteQueue;
  const epoch = sessionEpoch;
  const settings = await getSettings();
  try {
    checkSessionEpoch(epoch);
    const apis = await discoverApiPaths(settings.protocol, settings.host, settings.port);
    checkSessionEpoch(epoch);

    // An explicit code bypasses the shared-login cache: the user just typed
    // it, so this attempt must actually carry it.
    if (otpCode) {
      const result = await login(settings, otpCode, apis);
      await acceptLogin(result, settings, apis, epoch);
    } else {
      // Reuse an existing login attempt, including one started by an add in a
      // popup that has since closed. Testing must not cancel that operation.
      await getSession(settings, apis, { force: true });
    }
    checkSessionEpoch(epoch);

    return {
      success: true,
      info: {
        authVersion: apis.authVersion,
        taskVersion: apis.taskVersion,
        authPath:    apis.authPath,
      },
    };
  } catch (err) {
    return {
      success: false,
      connectionChanged: err.connectionChanged === true,
      otpRequired:    err.otpRequired === true,
      otpWrong:       err.otpWrong === true,
      nasUnreachable: err.nasUnreachable === true,
      error: { message: err.message },
    };
  }
}

// ---------------------------------------------------------------------------
// Download task helper
// ---------------------------------------------------------------------------

/**
 * How long to keep knocking before giving up on a sleeping NAS.
 *
 * A budget rather than a number of attempts, because that is the figure worth
 * reasoning about: half a minute is roughly how long spinning up parked disks
 * takes, and it is also about as long as anyone will wait for a button.
 *
 * A sleeping NAS usually refuses the connection outright, so a probe costs
 * almost nothing and the time goes into the gaps between them. Short gaps mean
 * the add starts within a few seconds of the NAS becoming reachable, rather
 * than sitting idle until some longer interval happens to elapse.
 */
const WAKE_BUDGET_MS = 30000;
const WAKE_PROBE_TIMEOUT_MS = 5000;
const WAKE_GAP_MS = 3000;

/**
 * Once the NAS has answered, give Download Station a moment. Its web server is
 * up before the package is ready to take a task, and the create that follows
 * gets only one attempt.
 */
const WAKE_SETTLE_MS = 2000;

/**
 * Get the NAS talking before sending it something that must not be sent twice.
 *
 * Logging in used to do this by accident: the first request to a sleeping NAS
 * was the login, which is repeatable and waits patiently. But with a session
 * already cached there is no login, so the first thing to reach a sleeping NAS
 * was the create itself — one attempt, eight seconds, and a failure reported
 * for a download the NAS accepted a moment later.
 *
 * This is a plain read of the API index: no session, no side effect, safe to
 * repeat as often as it takes. Only once it answers does anything get written.
 *
 * `announce` is for the ways in that have no screen of their own. The popup
 * greys out its button and says "Adding…", but a right-click shows nothing at
 * all — and half a minute of nothing looks exactly like a menu entry that is
 * broken. Only sent once the first probe has actually failed, so an awake NAS
 * stays silent.
 */
async function wakeNas({ announce = false } = {}) {
  const { protocol, host, port } = await getSettings();
  const url = `${protocol}://${host}:${port}/webapi/query.cgi` +
    '?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth';

  const deadline = Date.now() + WAKE_BUDGET_MS;
  let hadToWait = false;

  for (;;) {
    try {
      await fetchOnce(url, {}, WAKE_PROBE_TIMEOUT_MS);
      break;
    } catch (err) {
      // It answered, just not with a 200 — waiting will not change that.
      if (!err.nasUnreachable) throw err;
      // Only start another probe if there is room for it to finish. Checking
      // afterwards would let the last one overrun the budget by its full length.
      if (Date.now() + WAKE_PROBE_TIMEOUT_MS + WAKE_GAP_MS > deadline) throw err;
      // Part of the "you added something" story, so it follows that setting:
      // whoever silenced those does not want this either.
      if (!hadToWait && announce) notify('added', msg('extensionName'), msg('notifyWaking'));
      hadToWait = true;
      await sleep(WAKE_GAP_MS);
    }
  }

  if (hadToWait) await sleep(WAKE_SETTLE_MS);
}

/**
 * Run one add at a time, and let the popup know while any are running.
 *
 * Two adds at once are the problem: each wakes the NAS and writes, and a create
 * is not repeatable, so overlapping them is how two links became a dozen. They
 * are therefore put in a line rather than run side by side.
 *
 * The flag lives in session storage because the popup's own disabled button
 * only lasts as long as the popup does, and Firefox closes it the moment
 * anything outside is clicked. Reopening gave a fresh, enabled button with no
 * idea that a request was still on its way. The popup reads the flag on open
 * and watches it through storage.onChanged.
 *
 * The in-memory counter is what the decisions are made on: storage is async,
 * and two calls arriving together would both read "not running".
 */
/** Adds queued or running. The flag follows this reaching and leaving zero. */
let addsPending = 0;
/** Tail of the chain; the next add hangs off it. */
let addQueue = Promise.resolve();
/** Keeps the two storage writes in the order they were asked for. */
let busyWrite = Promise.resolve();

function markAddBusy(busy) {
  busyWrite = busyWrite
    .then(() => (busy
      ? browser.storage.session.set({ addInFlight: true })
      : browser.storage.session.remove('addInFlight')))
    .catch(() => {});
  return busyWrite;
}

function finishAdd() {
  if (--addsPending === 0) return markAddBusy(false);
}

/**
 * Queue an add behind whatever is already running.
 *
 * Used by the context menu and by magnet links, where each call is a different
 * link the user picked deliberately — turning the second one away would simply
 * lose it. The returned promise settles only after the flag has been written
 * back, so a caller that reads it afterwards sees the finished state.
 */
function enqueueAdd(fn) {
  // The connection an add is meant for is fixed now, when it is asked for. Taken
  // when its turn came instead, a right-click queued behind a slow add went to
  // whatever NAS had been configured in the meantime.
  const epoch = sessionEpoch;
  addsPending++;
  if (addsPending === 1) markAddBusy(true);
  // Runs whichever way the one before it ended; its own outcome is the
  // caller's, while the chain carries on regardless.
  const run = addQueue.then(() => fn(epoch), () => fn(epoch)).finally(finishAdd);
  addQueue = run.catch(() => {});
  return run;
}

/**
 * Start an add only if nothing else is going on, otherwise say so.
 *
 * This is the popup's way in, and there the second press is the *same* request
 * again — someone who thought the button was broken. Queuing that would add
 * everything twice, so it is refused and the popup says why.
 */
function exclusiveAdd(fn) {
  if (addsPending > 0) {
    return Promise.resolve({ success: false, busy: true, error: { message: msg('addBusy') } });
  }
  return enqueueAdd(fn);
}

/**
 * Leave the outcome where a popup that was not there can still find it.
 *
 * Everything the popup does with a result — empty the list, put the refused
 * links back, colour the box, count what got through — used to live in the
 * continuation after its own sendMessage. Firefox destroys the popup on the
 * first click outside it, and an add against a sleeping NAS takes far longer
 * than that, so the answer regularly arrived with nobody left to read it: the
 * links stayed in the box as if nothing had happened, and pressing the button
 * again added every one of them a second time.
 *
 * Only the popup's own adds are recorded. A right-click on a page is not about
 * the list in the popup, and writing its links there would put URLs in front of
 * someone who never typed them.
 */
async function recordForPopup(result) {
  // Nothing was attempted, and the popup finds an unconfigured connection on
  // its own — recording it would only produce a message about zero links.
  if (!result.setupRequired) {
    const values = { lastAdd: { ...result, at: Date.now() } };
    if (Array.isArray(result.failedUrls)) {
      values.bulkDraft = result.success ? '' : result.failedUrls.join('\n');
    }
    // Commit the draft with the result before releasing the add lock. Closing
    // the popup while it displays the result cannot resurrect submitted links.
    await browser.storage.session.set(values);
  }
  return result;
}

// A fresh script means nothing of ours is running, whatever a leftover flag from
// a suspended instance may claim. lastAdd deliberately survives: it is a result
// waiting to be read, not a claim about what is happening now.
browser.storage.session.remove('addInFlight');

/**
 * Bail out before touching the API when the connection was never set up.
 * Flags the popup so it opens on the Settings tab with the missing fields
 * marked, and opens it for the user when the browser allows it (a download
 * started from a context menu has no popup open yet).
 */
async function requireSetup() {
  await stateReady;
  await settingsWriteQueue;
  const settings = await getSettings();
  if (isConfigured(settings)) return true;

  await browser.storage.session.set({ setupRequired: true });
  // Always shown: without credentials nothing works at all, and staying silent
  // would leave a right-click that simply does nothing.
  notifyAlways(msg('setupRequiredShort'), msg('setupRequired'));
  // Only allowed in response to a user gesture; ignore when it isn't.
  try { await browser.action.openPopup(); } catch {}
  return false;
}

async function addDownloadTask(url, { announce = false, epoch } = {}) {
  if (await connectionChangedSince(epoch)) {
    notify('failed', msg('notifyFailed'), msg('addConnectionChanged'));
    return { success: false, connectionChanged: true, deliveryUnknown: false,
      error: { message: msg('addConnectionChanged') } };
  }
  if (!await requireSetup()) {
    return { success: false, setupRequired: true, error: { message: msg('setupRequired') } };
  }
  epoch ??= sessionEpoch;

  // Same as the bulk path: get the NAS answering before writing anything,
  // because this create gets one attempt and is never repeated. Caught on its
  // own, because nothing has been sent yet — the error carries the "delivery
  // unknown" mark of any unanswered request, and reporting that here told the
  // user to go and check for a download that was never sent.
  try {
    await wakeNas({ announce });
  } catch (err) {
    notify('failed', msg('notifyError'), err.message);
    return { success: false, deliveryUnknown: false, error: { message: err.message } };
  }

  try {
    const result = await apiAddTaskBatch([url], undefined, epoch);
    if (result.success) {
      notify('added', msg('extensionName'), msg('notifyAdded'));
      // Also refreshes the badge right away via its immediate first tick.
      startDownloadPolling();
    } else {
      const code = result.error?.code ?? 'unknown';
      const body = await describeTaskError(code);
      // A broken destination breaks every download, so it is always reported.
      if (isConfigError(code)) notifyAlways(msg('notifyFailed'), body);
      else notify('failed', msg('notifyFailed'), body);
    }
    return result;
  } catch (err) {
    // A sign-in failure gets through either way — see notify() above.
    if (err.authFailed) {
      notifyAlways(msg('notifyError'), err.message);
    } else if (err.connectionChanged) {
      // Changed while the NAS was being woken; the create was never sent.
      notify('failed', msg('notifyFailed'), msg('addConnectionChanged'));
      return { success: false, connectionChanged: true, deliveryUnknown: false,
        error: { message: msg('addConnectionChanged') } };
    } else if (err.deliveryUnknown) {
      // Our own deadline ran out with the request already on its way. Calling
      // that a failure invites a second right-click, which is how the same
      // download ends up queued twice — the bulk path says the same thing to
      // the popup as "linksUncertain".
      notify('failed', msg('notifyError'), msg('notifyUncertain'));
    } else {
      notify('failed', msg('notifyError'), err.message);
    }
    return {
      success: false,
      deliveryUnknown: err.deliveryUnknown === true,
      error: { message: err.message },
    };
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
const KEEPALIVE_ALARM = 'download-station-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 3;

async function syncKeepaliveAlarm() {
  const settings = await getSettings();
  if (settings.keepaliveEnabled) {
    browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  } else {
    browser.alarms.clear(KEEPALIVE_ALARM);
  }
}

const SESSION_USED_MIRROR_MS = 60 * 1000;

/**
 * Note a call the NAS accepted with `sid`. Written to storage at most once a
 * minute: the popup's refresh succeeds every few seconds, and the stored time
 * only has to be close enough for a three-minute period. It can lag behind the
 * real one but never run ahead, so the most it costs is a keepalive that was
 * not needed.
 */
function noteSessionUsed(sid) {
  sessionUsed = { sid, at: Date.now() };
  const stored = sessionUsedStored;
  if (stored?.sid === sid && sessionUsed.at - stored.at < SESSION_USED_MIRROR_MS) return;
  sessionUsedStored = sessionUsed;
  browser.storage.session.set({ sessionUsed });
}

async function runKeepalive() {
  await stateReady;
  if (!cachedSid) return; // No active session — nothing to keep alive
  // Only this session's own calls count — see sessionUsed.
  if (sessionUsed.sid === cachedSid
      && Date.now() - sessionUsed.at < KEEPALIVE_PERIOD_MINUTES * 60 * 1000) return;

  try {
    const result = await apiListTasks();
    if (result.success) {
      updateBadge(result.data?.tasks ?? []);
    } else if (SESSION_ERROR_CODES.has(result.error?.code)) {
      clearSession();
      // Badge preserved — session will be re-established on next wake
    }
  } catch {
    // The session stays. A NAS that did not answer has not forgotten it, and
    // clearing it here ended the download watch at its next tick, which stops
    // on a missing session — over one dropped request. Repeated failures are
    // the watch's own limit to count. A session the NAS really has forgotten
    // answers 105 or 119 once it is back, and withSession signs in again.
  }
}

// ---------------------------------------------------------------------------
// Download polling — watches active tasks until they're done, independent
// of the "keep session alive" setting. Starts when a task is added, stops
// itself once nothing is downloading/processing any more (paused, finished,
// seeding and errored tasks don't count, so an all-paused queue goes quiet).
// ---------------------------------------------------------------------------

const POLL_ALARM = 'download-station-poll';
// Which tasks keep the watch going is shared with the popup: isWorkingTask.

/**
 * Begin (or restart) the poll loop and run one tick straight away, so the
 * badge reflects the new task immediately instead of a minute later.
 */
function startDownloadPolling() {
  setPollFailures(0); // a fresh start deserves a fresh set of attempts
  browser.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  // Fresh: a poll already running asked before whatever called this.
  pollDownloads({ fresh: true });
}

/**
 * Take in a task list that shows downloads running.
 *
 * Its running tasks join the watch's tally either way. They used to only when
 * this list started the watch — and a newer list makes the poll's older answer
 * count as out of date, so with both passed over, a download that finished
 * before the next tick was missing from the closing count.
 *
 * When nothing is polling for them the watch is picked back up — after it gave
 * up on a NAS that stopped answering, for instance. Opening the popup is when
 * that becomes visible, so that is when it is repaired. An alarm that already
 * exists is left alone: the popup asks every few seconds, and restarting each
 * time would keep pushing the next tick back.
 */
async function resumeWatch(tasks, epoch) {
  if (!tasks.some(isWorkingTask)) return;
  const watching = await browser.alarms.get(POLL_ALARM);
  // Signed out or switched NAS while the list was on its way.
  if (epoch !== sessionEpoch || !cachedSid) return;
  if (!watching) {
    setPollFailures(0);
    browser.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  }
  rememberWatched(tasks);
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

/**
 * Consecutive failed polls before the loop gives up. Without a limit a NAS
 * that has gone away — or credentials that stopped working — would be
 * contacted once a minute forever, with nobody left to see the result.
 * Opening the popup or adding a task starts it again.
 */
const POLL_MAX_FAILURES = 5;

/** Mirrored only when it changes — a successful tick is the usual case. */
function setPollFailures(count) {
  if (count === pollFailures) return;
  pollFailures = count;
  if (count === 0) browser.storage.session.remove('pollFailures');
  else browser.storage.session.set({ pollFailures: count });
}

function pollFailed() {
  setPollFailures(pollFailures + 1);
  if (pollFailures >= POLL_MAX_FAILURES) {
    browser.alarms.clear(POLL_ALARM);
    setPollFailures(0);
    // The watch never reached a conclusion, so there is nothing to report.
    clearWatched();
  }
}

/** Forget the current watch. Called whenever it ends, however it ends. */
function clearWatched() {
  if (watchedIds.size === 0) return;
  watchedIds = new Set();
  browser.storage.session.remove('watchedIds');
}

/**
 * Note every task that is running right now. Called on each tick rather than
 * only at the start, so links added while a watch is already going join the
 * same tally instead of starting a second one.
 */
function rememberWatched(tasks) {
  let added = false;
  for (const task of tasks) {
    const id = task.id;
    if (id !== undefined && isWorkingTask(task) && !watchedIds.has(id)) {
      watchedIds.add(id);
      added = true;
    }
  }
  if (added) browser.storage.session.set({ watchedIds: [...watchedIds] });
}

/**
 * Report how the watch ended.
 *
 * Only the tasks that were actually running while we watched are counted —
 * downloads that were already sitting finished beforehand are not news, and
 * counting them would make every notification look like a big haul.
 */
function notifyWatchFinished(tasks) {
  if (watchedIds.size === 0) return;

  const statusById = new Map(tasks.map(t => [t.id, t.status?.toLowerCase()]));
  let done = 0, failed = 0, paused = 0;

  for (const id of watchedIds) {
    const status = statusById.get(id);
    if (status === undefined) continue; // deleted while we were watching
    // Seeding means the download itself is complete; the upload is a bonus.
    if      (status === 'finished' || status === 'seeding') done++;
    else if (status === 'error')                            failed++;
    else if (status === 'paused'   || status === 'stopped')  paused++;
  }

  clearWatched();

  // Nothing actually ran to a conclusion: the queue was paused, which the user
  // did themselves a moment ago. Announcing it would be noise.
  if (done === 0 && failed === 0) return;

  const parts = [msg('notifyDoneCount', String(done))];
  if (failed > 0) parts.push(msg('notifyFailedCount', String(failed)));
  if (paused > 0) parts.push(msg('notifyPausedCount', String(paused)));

  notify('finished', msg('notifyAllDone'), parts.join(' · '));
}

/**
 * One poll at a time.
 *
 * Overlapping polls went wrong both ways. A NAS that does not answer takes up
 * to 62 seconds per request with its retries, longer than the minute between
 * alarms, so with the newest poll deciding, every failure had been overtaken by
 * the time it arrived: none was counted, and the limit never ended the watch.
 * An alarm that fires while a poll is running is now simply dropped — that
 * poll is already doing the job.
 *
 * An add is different. The running poll asked before it and cannot know about
 * the new download, so its "nothing running" is not to be trusted. `pollAgain`
 * marks that, and a fresh poll follows as soon as the running one is done.
 */
let pollRunning = null;
let pollAgain = false;

function pollDownloads({ fresh = false } = {}) {
  if (pollRunning) {
    if (fresh) pollAgain = true;
    return pollRunning;
  }
  pollRunning = runPoll().finally(() => {
    pollRunning = null;
    if (pollAgain) {
      pollAgain = false;
      pollDownloads();
    }
  });
  return pollRunning;
}

async function runPoll() {
  await stateReady;
  // No session normally means the watch is over: signed out, switched NAS, or
  // handed back after the last download. Not after a failed poll. A session the
  // NAS turned down is dropped before signing in again, and when that sign-in
  // got no answer either, stopping here at the next tick skipped the failure
  // limit — one unanswered login ended the watch. The ticks after a failure
  // sign in again instead, until the limit ends it.
  if (!cachedSid && pollFailures === 0) {
    browser.alarms.clear(POLL_ALARM);
    clearWatched();
    return;
  }

  try {
    const result = await apiListTasks();
    // A failure counts whatever happened meanwhile: it says the NAS is not
    // answering, and that does not go out of date.
    if (!result.success) { pollFailed(); return; }
    setPollFailures(0);

    const tasks = result.data?.tasks ?? [];
    // Even an answer that turns out to be out of date shows what was running
    // while we watched. Dropped with it, a download that finished before the
    // next tick was missing from the closing count.
    rememberWatched(tasks);

    // Out of date if an add came in after this poll asked, or if a list asked
    // for later — typically the popup's — has already come back. That answer
    // knows better, whichever way it went.
    const outdated = () => pollAgain || newestListAnswered > result.listSeq;
    if (outdated()) return;

    updateBadge(tasks);

    const stillActive = tasks.some(isWorkingTask);
    if (!stillActive) {
      browser.alarms.clear(POLL_ALARM);
      // Before the logout below — it needs the tally that this clears.
      notifyWatchFinished(tasks);
      // Nothing left to watch. With keepalive off the user has asked us not
      // to hold the session, so hand it back instead of letting it time out —
      // unless something newer turned up or an add started while the settings
      // were read.
      const { keepaliveEnabled } = await getSettings();
      if (!keepaliveEnabled && !popupOpen && !outdated() && addsPending === 0) await apiLogout();
    }
  } catch (err) {
    // A connection change has ended this watch already. A refused sign-in ends
    // it too: a minute later it meets the same password, and DSM blocks an
    // address after enough failed logins. Anything else is a NAS that did not
    // answer — try again next tick, but not indefinitely.
    if (err?.connectionChanged) return;
    if (err?.authFailed) {
      browser.alarms.clear(POLL_ALARM);
      clearWatched();
      return;
    }
    pollFailed();
  }
}

// One listener for both alarms. Two of them worked, but every alarm woke both
// and each had to recognise its own name — with the pair sitting 150 lines
// apart, which is how you end up adding a third somewhere else again.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM)      pollDownloads();
  else if (alarm.name === KEEPALIVE_ALARM) runKeepalive();
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

// Queued, not refused: two right-clicks in a row are two different links, and
// the second must not be dropped because the first is still waiting for a NAS
// to wake up. `announce` because a right-click has no window to report into.
browser.contextMenus.onClicked.addListener((info) => {
  if (info.linkUrl) {
    enqueueAdd(epoch => addDownloadTask(info.linkUrl, { announce: true, epoch }));
    return;
  }
  const uris = extractUris(info.selectionText);
  if (uris.length === 1) {
    enqueueAdd(epoch => addDownloadTask(uris[0], { announce: true, epoch }));
  } else if (uris.length > 1) {
    enqueueAdd(epoch => addDownloadTasksBulk(uris, undefined, { announce: true, epoch }));
  }
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
      // Lets the popup show a code field instead of a plain failure.
      otpRequired: err?.otpRequired === true,
      otpWrong:    err?.otpWrong === true,
      connectionChanged: err?.connectionChanged === true,
      deliveryUnknown: err?.deliveryUnknown === true,
      error: { message: err?.deliveryUnknown ? msg('notifyUncertain') : (err?.message ?? String(err)) },
    }));
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    // Like the context menu: a click on a page, one link, no window of its own.
    case ACTIONS.MAGNET_CLICKED:
      respondWith(
        enqueueAdd(epoch => addDownloadTask(message.url, { announce: true, epoch })),
        sendResponse,
      );
      return true;

    case ACTIONS.ADD_TASKS_BULK:
      respondWith(
        exclusiveAdd(async epoch => recordForPopup(
          await addDownloadTasksBulk(message.urls, message.unzipPassword,
            { epoch, connection: message.connection }))),
        sendResponse,
      );
      return true;

    case ACTIONS.LIST_TASKS: {
      // Taken before asking: a list that was on its way while the connection
      // changed must not restart a watch for the new one.
      const epoch = sessionEpoch;
      respondWith(apiListTasks().then(async (r) => {
        if (r.success) await resumeWatch(r.data?.tasks ?? [], epoch);
        else if (typeof r.error?.code === 'number') {
          r.error.message = await describeTaskError(r.error.code);
        }
        return r;
      }), sendResponse);
      return true;
    }

    case ACTIONS.TEST_CONNECTION:
      respondWith(apiTestConnection(message.otpCode), sendResponse);
      return true;

    // Every action on listed tasks first checks that the list came from the
    // connection configured now — see taskActionEpoch.
    case ACTIONS.PAUSE_TASK:
      respondWith(taskActionEpoch(message.connection)
        .then(epoch => apiBulkTaskAction('pause', [message.id], epoch)), sendResponse);
      return true;

    case ACTIONS.RESUME_TASK:
      respondWith(taskActionEpoch(message.connection)
        .then(epoch => apiBulkTaskAction('resume', [message.id], epoch))
        .then(r => {
          if (mayBeRunning(r)) startDownloadPolling();
          return r;
        }), sendResponse);
      return true;

    case ACTIONS.DELETE_TASK:
      respondWith(taskActionEpoch(message.connection)
        .then(epoch => apiBulkTaskAction('delete', [message.id], epoch)), sendResponse);
      return true;

    case ACTIONS.RETRY_TASK:
      respondWith(
        taskActionEpoch(message.connection)
          .then(epoch => exclusiveAdd(() => apiRetryTask(message.id, message.uri, message.unzipPassword,
            { epoch, destination: message.destination })))
          .then((r) => {
            if (r.success) startDownloadPolling();
            return r;
          }),
        sendResponse,
      );
      return true;

    case ACTIONS.PAUSE_ALL:
      respondWith(
        bulkOverTasks('pause', t => PAUSABLE.has(t.status?.toLowerCase()), message.connection),
        sendResponse,
      );
      return true;

    case ACTIONS.RESUME_ALL:
      respondWith(
        bulkOverTasks('resume', t => RESUMABLE.has(t.status?.toLowerCase()), message.connection)
          .then((r) => {
            if (mayBeRunning(r)) startDownloadPolling();
            return r;
          }),
        sendResponse,
      );
      return true;

    case ACTIONS.DELETE_ALL:
      respondWith(bulkOverTasks('delete', () => true, message.connection), sendResponse);
      return true;

    case ACTIONS.ADD_TASK_FILES:
      respondWith(
        exclusiveAdd(async epoch => recordForPopup(
          await addTaskFiles(message.files, message.unzipPassword, epoch, message.connection))),
        sendResponse,
      );
      return true;

    case ACTIONS.CONSUME_SETUP_FLAG:
      // Read-and-clear, so the popup only jumps to Settings once per attempt.
      browser.storage.session.get({ setupRequired: false }).then(({ setupRequired }) => {
        if (setupRequired) browser.storage.session.remove('setupRequired');
        sendResponse({ setupRequired });
      });
      return true;

    case ACTIONS.CLEAR_COMPLETED:
      respondWith(bulkOverTasks('delete', t => t.status?.toLowerCase() === 'finished', message.connection)
        .then(r => ({ ...r, removed: r.affected ?? 0 })), sendResponse);
      return true;

    case ACTIONS.GET_STATUS:
      // Wait for cachedSid to be restored from storage.session before replying
      stateReady.then(() => {
        sendResponse({ connected: cachedSid !== null });
      });
      return true; // keep message channel open for async response

    case ACTIONS.SETTINGS_UPDATED: {
      respondWith(updateSettings(message), sendResponse);
      return true;
    }

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Extension install / startup
// ---------------------------------------------------------------------------

browser.runtime.onInstalled.addListener(({ reason } = {}) => {
  setupContextMenus();
  syncKeepaliveAlarm();
  // Earlier versions kept both drafts in storage.local, where an unsaved
  // password outlived the browser indefinitely. They live in session storage
  // now. Cleared once when the extension updates, not on every popup open.
  if (reason === 'update') browser.storage.local.remove(['connDraft', 'bulkDraft']);
});

browser.runtime.onStartup?.addListener(() => {
  setupContextMenus();
  syncKeepaliveAlarm();
});
