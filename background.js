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

// A kept failure blocks automatic logins, but not use of an existing session.
let cachedConnectFailure = null;

// Restore persisted state on startup.
// Stored as a Promise so every entry point (alarms, messages, context menus)
// can await it before touching cachedSid / cachedApiPaths, preventing a race
// between the async read and the first incoming event that wakes the script.
const stateReady = browser.storage.session
  .get({ sid: null, apiPaths: null, sessionConnection: null, watchedIds: [], pollFailures: 0, sessionUsed: null, lastConnect: null })
  .then(async ({ sid, apiPaths, sessionConnection, watchedIds: stored, pollFailures: failures, sessionUsed: used, lastConnect }) => {
    cachedConnectFailure = lastConnect;
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

/**
 * What a notification says about a failure.
 *
 * A notification has room for one short line and Firefox cuts off the rest —
 * and for a refused certificate the part that disappeared was the browser's own
 * reason, which is the part worth reading. Quoting it here was doing the user
 * no good at all. So the long form is not sent to a notification any more: this
 * says what happened and where the whole of it stands, and the connection panel
 * in the popup carries the reason in full, where it can also be copied.
 *
 * Missing NAS access also gets a short explanation of why access is needed.
 * The address and full instructions stay in the connection panel.
 */
function shortReason(err, fallback = null) {
  if (err?.permissionMissing === true) return msg('notifyNasPermission');
  if (err?.certificateError === true) return msg('notifyCertificate');
  return err?.message ?? fallback;
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
async function describeTaskError(code, destination) {
  if (code === 403) {
    // What the call actually sent, handed down from the create itself.
    //
    // An empty string is an answer, not a gap: it says no folder of our own went
    // out, so the broken path is the NAS's own default. Treating it as missing
    // read the setting instead, which pointed the user at a folder the request
    // had never named — and a setting changed while the request was away got it
    // wrong in the other direction, naming a folder nobody had sent.
    //
    // Only a caller that cannot know — a task action, a list — falls back to the
    // setting, which is the best guess available to it.
    const sent = destination ?? (await getSettings()).defaultDestination;
    if (!sent) {
      return msg('errWithCode', msg('errTask403NoDest'), '403');
    }
  }
  return describeError(TASK_ERRORS, code);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  // get() takes the defaults object and fills in every key that is not stored,
  // so what comes back already carries them all. Spreading DEFAULTS over the
  // top again changed nothing.
  return browser.storage.local.get(DEFAULTS);
}

function buildBaseUrl(protocol, host, port) {
  return `${buildConnectionUrl(protocol, host, port)}/webapi`;
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
 * has had an answer — only a NAS that is awake and briefly busy. Twelve seconds
 * looked generous for exactly that,
 * and was not: a NAS took the link and answered after the deadline, which is
 * how a user ended up adding the same downloads twice. Waiting for the real
 * answer beats having to work out afterwards what happened.
 */
const WRITE_TIMEOUT_MS = 25000;
/**
 * Added on top for every URI in a batch.
 *
 * Download Station queues all of them before it answers, so the work behind one
 * request grows with the batch while a fixed deadline would not. Fifty links —
 * the most the API takes at once — get 40 seconds rather than 25.
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
 * What the browser refused, recorded so it can be read back.
 *
 * fetch collapses every network failure into one opaque TypeError — the Fetch
 * standard requires it, so that a page cannot use failures to probe the
 * network. An expired certificate, one issued for a different name, and a NAS
 * that is genuinely asleep therefore reach the catch in fetchOnce
 * indistinguishable from one another, and all three are reported as "the NAS
 * did not answer" and tried three more times.
 *
 * webRequest.onErrorOccurred is the one place Firefox names the real reason.
 * MDN calls details.error an internal string with no promise to stay the same
 * between releases, so nothing is classified from it here yet: this records
 * what actually arrives, so the classification can be built on an observed
 * value instead of a guess.
 */
/** Match patterns the listener is registered for. Added to, never pruned. */
const watchedPatterns = new Set();
/**
 * Addresses this extension has out right now, without their query strings.
 *
 * Each entry counts the requests to that address and remembers whether two
 * were ever out together. The flag has to outlive the overlap: the second
 * request often finishes first, and by the time the first one asks, a count
 * taken at that moment says one and looks unambiguous. It is cleared when the
 * address falls quiet, which is when the entry goes.
 */
const inFlight = new Map();
/** Refusals seen but not yet claimed by the request they belong to. */
const transportFailures = [];
/** Long enough to bridge a slow turn, short enough that nothing stale is used. */
const TRANSPORT_MEMORY_MS = 60000;

/**
 * How long to go on asking for the browser's reason once a request has failed.
 *
 * fetch's rejection and the error event are raised independently, and the order
 * measured in Firefox is the unhelpful one: the rejection first, the reason a
 * turn or more later. The first build of this yielded exactly once and then
 * gave up, which is why a refused certificate was named on one attempt at best
 * and reported as an unreachable NAS on every one after it — the reason landed
 * when the request had already been struck off, and the listener dropped it as
 * belonging to nobody.
 *
 * A budget rather than a fixed pause: the wait ends the moment the reason
 * arrives, so the full half second is only ever paid where no reason is coming
 * at all. Our own timeout aborting a request is one such case, and simply
 * waiting longer is no answer on its own — it moves the point at which the
 * message is lost again rather than removing it.
 */
const TRANSPORT_WAIT_MS = 500;
const TRANSPORT_WAIT_STEP_MS = 25;

/**
 * The individual requests this extension has out right now.
 *
 * `inFlight` counts addresses; this holds the attempts themselves, so the
 * browser's reason can be handed to the one request that met it rather than to
 * an address several requests share. Firefox stamps every event of one request
 * with the same requestId, and onBeforeRequest is where that id can be learnt
 * early enough to be of use — see noteRequestStart.
 *
 * An entry goes the moment its request is released, and that is what keeps a
 * late reason off the next attempt: it carries the id of an attempt that is no
 * longer here, so it is recorded and claimed by nobody.
 */
const openAttempts = new Set();

/**
 * Ids of requests that are over, and when they ended.
 *
 * A reason can still arrive after its request has been given up on. Handed to
 * nobody it would fall through to the shared list below, and the next request
 * to that address — one that has not yet learnt an id of its own, so still
 * decides by address — would take it as its own. That is precisely what the id
 * is here to prevent, so an id known to be finished with is enough to keep the
 * reason out of that list altogether.
 *
 * Pruned on the same window as the list: the entries go in ordered by time, so
 * the walk stops at the first one still young enough to matter.
 */
const retiredRequests = new Map();

function retireRequest(attempt) {
  if (attempt.requestId === null) return;
  const at = Date.now();
  retiredRequests.set(attempt.requestId, at);
  for (const [id, when] of retiredRequests) {
    if (at - when <= TRANSPORT_MEMORY_MS) break;
    retiredRequests.delete(id);
  }
}

/**
 * An address without its query string, in the one spelling both sides can agree
 * on.
 *
 * The query string is not part of an endpoint's identity, and this is what the
 * in-flight bookkeeping is keyed on. Nothing secret is being kept out of it:
 * every request that carries a session id puts it in the POST body, never in
 * the URL — see apiListTasks and the log-keeping note at wakeNas.
 *
 * The settings always name a port, so a NAS on 443 is asked for
 * "https://nas:443/webapi/…" while the browser reports the same request as
 * "https://nas/webapi/…": the URL standard drops a scheme's default port.
 * Compared as raw text those are two different addresses, and a genuine
 * certificate refusal was thrown away as belonging to nobody. `origin` does
 * that normalisation for us, and the same for host case and a stray "..".
 */
const addressOf = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
};

/**
 * Listen for the hosts this extension is talking to.
 *
 * Driven from the requests themselves rather than from the stored settings: the
 * filter is then right by construction for discovery, sign-in and every later
 * call, and it follows a changed address without plumbing of its own. On an
 * event page the registration goes when the page does, which costs nothing —
 * the set goes with it, so the next request registers again.
 *
 * A pattern names scheme and host only: Firefox cannot express a port in one
 * (bug 1362809) and does not refuse one either — a pattern carrying a port is
 * accepted, registered, and then matches nothing at all. The first build of
 * this asked for `https://host:5001/*` and recorded a watch that could never
 * fire, which looked exactly like a NAS with nothing wrong.
 *
 * The listener therefore re-registers with the *union* of every pattern seen.
 * Holding only the newest would drop errors from a sign-in at a new NAS while
 * a farewell to the old one is still on its way — the two overlap, and the
 * later registration would silently unwatch the earlier host. Nothing is
 * pruned: this is a coarse sieve, and what it lets through is still measured
 * against the addresses actually in flight.
 *
 * Two events are watched for, not one. onErrorOccurred carries the reason;
 * onBeforeRequest carries nothing worth reading, and is here only for the
 * requestId that ties the two together — see noteRequestStart. Neither is
 * registered as blocking, so nothing can be held up, changed or cancelled.
 */
function watchTransportErrors(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return;
  }
  const pattern = `${url.protocol}//${url.hostname}/*`;
  if (watchedPatterns.has(pattern)) return;
  watchedPatterns.add(pattern);
  browser.webRequest.onErrorOccurred.removeListener(recordTransportError);
  browser.webRequest.onErrorOccurred.addListener(recordTransportError, { urls: [...watchedPatterns] });
  browser.webRequest.onBeforeRequest.removeListener(noteRequestStart);
  browser.webRequest.onBeforeRequest.addListener(noteRequestStart, { urls: [...watchedPatterns] });
  // Kept so that a reading can tell "nothing went wrong" apart from "nothing
  // was ever listening" — an empty record looks the same either way.
  browser.storage.session.set({ transportWatch: { patterns: [...watchedPatterns], at: Date.now() } });
}

/**
 * Whether an event is about a request this extension made itself.
 *
 * Asked of both watched events, so the two cannot drift apart: an id learnt
 * from a request that was never ours would tie the wrong reason to one of
 * these attempts, which is worse than learning no id at all.
 */
function ourRequest(details) {
  // What the filter itself could not say. It carries no port and covers every
  // host seen in this page's life, so an address this extension has out right
  // now is what actually decides — that is both narrower than the pattern and
  // free of its blind spots.
  if (!inFlight.has(addressOf(details.url))) return false;
  // And only what this extension asked for itself. The NAS's own web interface,
  // open in a tab, fails against the very same certificate — and adopting its
  // failure would put a message on screen about a request nobody here made. A
  // request belonging to a tab carries that tab's id; ours belong to no tab.
  if (details.tabId !== -1) return false;
  // originUrl names what triggered the request. Where it is given it has to be
  // this extension; where it is not, its absence is no reason to discard —
  // requiring it would silently throw away every event if a build left it out.
  if (details.originUrl && !details.originUrl.startsWith(browser.runtime.getURL(''))) return false;
  return true;
}

/**
 * Tie a request's id to the attempt that made it, while that is still knowable.
 *
 * Firefox stamps every event of one request with the same requestId, and it is
 * the only thing that tells two requests to the same address apart. By the time
 * the refusal arrives it is far too late to work out whose it is: address and
 * time cannot do it — `create` and `list` go to the same endpoint and are
 * regularly out together — and until now a refusal that met either of them was
 * given up on rather than risk blaming the wrong one.
 *
 * The oldest attempt still without an id is the one this belongs to: requests
 * to one address go out in the order they were started, and the browser reports
 * their starts in that same order.
 *
 * Nothing here depends on the id arriving. An attempt that never gets one falls
 * back to the address, exactly as before.
 */
function noteRequestStart(details) {
  if (!ourRequest(details)) return;
  // An id that is not given is no id at all. Binding an attempt to `undefined`
  // would mark it identified and so deaf to the address-based claim as well,
  // which is worse than never having been identified in the first place.
  // An id that is not given is no id at all. Binding an attempt to `undefined`
  // would mark it identified and so deaf to the address-based claim as well,
  // which is worse than never having been identified in the first place.
  // An id that is not given is no id at all. Binding an attempt to `undefined`
  // would mark it identified and so deaf to the address-based claim as well,
  // while the reason it waits for is filed under an id it never learnt.
  if (details.requestId === undefined || details.requestId === null) return;
  const address = addressOf(details.url);
  for (const attempt of openAttempts) {
    if (attempt.address !== address || attempt.requestId !== null) continue;
    attempt.requestId = details.requestId;
    return;
  }
}

function recordTransportError(details) {
  if (!ourRequest(details)) return;

  // Deliberately not narrowed by request type. If these requests do not carry
  // the type expected of them, a type filter would drop the very event being
  // measured — so the type is recorded instead. The query string is dropped
  // because it is not part of the address this is filed under — see addressOf.
  const seen = {
    error: details.error,
    type:  details.type,
    url:   addressOf(details.url),
    at:    Date.now(),
  };
  browser.storage.session.set({ lastTransportError: seen });

  // Handed straight to the attempt whose id this carries. That attempt is still
  // waiting for it, and being named outright it needs none of the caution below
  // — two requests to the same address no longer make each other's reason
  // unusable, because neither is guessing which one it is.
  const owner = [...openAttempts].find(attempt => attempt.requestId !== null
    && attempt.requestId === details.requestId);
  if (owner) {
    owner.seen = seen;
    return;
  }

  // An id we know belonged to a request that is over. Nobody here can claim it,
  // and in the shared list it would be handed to whatever asks next at that
  // address — the one thing the id exists to prevent. Written down above, kept
  // out of the list here.
  const requestId = details.requestId ?? null;
  if (requestId !== null && retiredRequests.has(requestId)) return;

  // No id to go by, or one belonging to an attempt still waiting that has not
  // learnt it yet. Held in memory as well as written down, because fetchOnce
  // asks for it in the same breath, where a storage read would be a turn too
  // late. The id travels with the copy in the list, so an attempt that learns
  // its own late can still recognise its reason here; it stays out of what is
  // stored, which nothing reads it from.
  transportFailures.push({ ...seen, requestId });
  while (transportFailures.length && seen.at - transportFailures[0].at > TRANSPORT_MEMORY_MS) {
    transportFailures.shift();
  }
}

/**
 * The refusal belonging to this request — only when it can be said which one
 * that is.
 *
 * An address and a time do not identify a request. `create` and `list` go to
 * the same endpoint and are regularly in flight together, and taking the
 * failure out of the list stops it serving twice without making the one use
 * correct. So the claim is made only where it is unambiguous: exactly one
 * matching refusal, and no second request to the same address alongside this
 * one. Anything else is left alone, and the caller keeps the general answer —
 * which, unlike a wrong verdict, still says that the outcome is uncertain.
 *
 * `startedAt` keeps a failure from an earlier attempt out: after a retry the
 * same address comes round again.
 */
function takeTransportFailure(address, startedAt) {
  if (inFlight.get(address)?.contended) return null;
  const matches = transportFailures.filter(seen => seen.url === address && seen.at >= startedAt);
  if (matches.length !== 1) return null;
  transportFailures.splice(transportFailures.indexOf(matches[0]), 1);
  return matches[0];
}

/**
 * The refusal carrying this request's own id, wherever it ended up.
 *
 * A reason can land while its attempt is still unidentified — the start event
 * and the error event are two separate deliveries — and it then goes to the
 * shared list rather than to the attempt. Once the id does arrive, the attempt
 * can name its own reason there, and needs neither the address nor the timing
 * to do it.
 */
function takeFailureById(requestId) {
  const index = transportFailures.findIndex(seen => seen.requestId === requestId);
  return index === -1 ? null : transportFailures.splice(index, 1)[0];
}

/**
 * An ordinary network failure and a refusal by the security layer, told apart
 * without knowing a single word of any language.
 *
 * Measured against Firefox 156 on 2026-09-22: an ordinary failure arrives as a
 * symbolic name — NS_ERROR_NET_TIMEOUT, NS_ERROR_CONNECTION_REFUSED — while the
 * security layer answers in prose, already translated for the reader ("Angefor-
 * derter Domainname stimmt nicht mit dem Zertifikat des Servers überein"). The
 * shape is therefore what gets asked, not the wording. This was worth measuring
 * first: matching SSL_ERROR_BAD_CERT_DOMAIN and its relatives, which is the
 * obvious thing to write, would have matched nothing at all here.
 *
 * Symbolic security names are accepted too, for a build that reports them.
 */
const SYMBOLIC_ERROR = /^[A-Z][A-Z0-9_]*$/;
const SECURITY_ERROR_NAME = /^(?:SEC_ERROR|SSL_ERROR|MOZILLA_PKIX_ERROR)_/;

function securityRefusal(error, secure) {
  if (typeof error !== 'string' || error === '') return false;
  if (SECURITY_ERROR_NAME.test(error)) return true;
  // Prose rather than a name means the security layer spoke, and only a TLS
  // request can have reached it. Over http the general message stands — which
  // is also what anything unrecognised falls back to, rather than claiming a
  // certificate is at fault.
  return secure && !SYMBOLIC_ERROR.test(error);
}

/**
 * The NAS address a failure is about, in the browser's own spelling.
 *
 * Scheme, host and port and nothing else: that is what a certificate is checked
 * against and what the user typed into the connection fields, and it is the
 * identity the kept message below lives under. `origin` drops a scheme's
 * default port, so the settings' "https://nas:443" and the browser's
 * "https://nas" come out as one address rather than two.
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The last connection failure at an address, kept for the popup to show in
 * full.
 *
 * A notification shows one short line and cuts off the rest, and the browser's
 * reason is regularly longer than that line — so it is written down here
 * instead, and the notification only says where to read it.
 *
 * Two things are kept, because they answer different questions. `certificate`
 * says what the *last* attempt ran into, and `reason` is the last reason the
 * browser actually gave, which outlives the attempt that got it: after a
 * refused certificate the attempts that follow usually come back as a plain
 * unreachable NAS, and dropping the reason there would take away the one thing
 * the user can act on. Shown as what it is — the last precise reason, not a
 * fresh verdict — so neither is presented as more than it is.
 *
 * Nothing is written for a plain failure at an address with no reason on
 * record: the general message already says that much, and a panel repeating it
 * would be noise. That also keeps this off the ordinary path — a NAS that is
 * simply asleep writes nothing at all.
 */
let connectionProblem;
const connectionResults = new Map();
let connectionProblemWrites = Promise.resolve();

/** Order results before diagnostic lookups or storage can delay their handling. */
function noteConnectionResult(url, epoch) {
  const origin = originOf(url);
  if (origin === null || epoch !== sessionEpoch) return null;
  const result = { origin, epoch };
  connectionResults.set(origin, result);
  return result;
}

function currentConnectionResult(result) {
  return result !== null && result.epoch === sessionEpoch
    && connectionResults.get(result.origin) === result;
}

/** Persist every accepted cache change in order, including a queued clear. */
function writeConnectionProblem(value) {
  const write = connectionProblemWrites.then(() => {
    // Validated before the cache changed. A newer result may leave that cache
    // unchanged, so it must not cancel the write that brings storage up to date.
    return value === null
      ? browser.storage.session.remove('connectionProblem')
      : browser.storage.session.set({ connectionProblem: value });
  });
  connectionProblemWrites = write.catch(() => {});
  return write;
}

async function readConnectionProblem() {
  if (connectionProblem !== undefined) return connectionProblem;
  const stored = await browser.storage.session.get({ connectionProblem: null });
  // Another request may have loaded and updated the record during this read.
  // Its newer value, including a deliberate clear, must survive the snapshot.
  if (connectionProblem === undefined) connectionProblem = stored.connectionProblem;
  return connectionProblem;
}

async function rememberConnectionProblem(url, reason, epoch = sessionEpoch,
  result = noteConnectionResult(url, epoch)) {
  const origin = originOf(url);
  if (!currentConnectionResult(result)) return;
  // Only ever about the address configured now. A request to the NAS just
  // switched away from can still fail after the switch, and its reason would
  // take the place of the one belonging to the NAS actually in use — which the
  // popup then shows nothing at all for, because the address no longer matches
  // its own. Nothing is kept for an address nobody is using: there is nowhere
  // it could be shown, and a single record cannot serve two of them.
  const { protocol, host, port } = await getSettings();
  if (!currentConnectionResult(result)
    || origin !== originOf(buildConnectionUrl(protocol, host, port))) return;
  const before = await readConnectionProblem();
  // A newer answer at this same address retires the old diagnosis too, even
  // when the settings have not changed and the epoch therefore still matches.
  if (!currentConnectionResult(result)) return;
  const kept = before?.origin === origin ? before : null;
  if (reason === null && !kept?.reason) return;
  const at = Date.now();
  connectionProblem = {
    origin,
    certificate: reason !== null,
    reason:      reason ?? kept?.reason ?? null,
    reasonAt:    reason !== null ? at : (kept?.reasonAt ?? null),
    at,
  };
  await writeConnectionProblem(connectionProblem);
}

async function forgetConnectionProblem(url, epoch = sessionEpoch,
  result = noteConnectionResult(url, epoch)) {
  if (!currentConnectionResult(result)) return;
  const problem = await readConnectionProblem();
  if (!currentConnectionResult(result) || problem === null || problem.origin !== originOf(url)) return;
  connectionProblem = null;
  await writeConnectionProblem(null);
}

/**
 * The browser's own reason for turning this request down, when that reason was
 * the secure connection itself — otherwise null.
 *
 * fetch's rejection and the error event are raised independently, so the event
 * is usually still on its way when the catch runs. It is waited for here, for
 * TRANSPORT_WAIT_MS at the outside, and the request stays registered for the
 * whole of that wait — released any earlier, the listener has nothing to file
 * the reason under and drops it.
 *
 * An attempt whose id is known is answered by name or not at all. The shared
 * list is for attempts that never learnt one: a reason in it is known only to
 * belong to this address and to have arrived within this attempt's lifetime,
 * and both of those can be true of a reason that is really the previous
 * request's, arriving after that request was struck off. Which is the whole
 * hazard — a lost message is an inconvenience, one pinned on the wrong request
 * is a wrong answer. The id is read on every turn rather than once, because it
 * can still be on its way when the request has already failed.
 */
async function certificateRefusal(input, attempt) {
  let secure;
  try {
    secure = new URL(input).protocol === 'https:';
  } catch {
    return null;
  }
  const until = Date.now() + TRANSPORT_WAIT_MS;
  for (;;) {
    const seen = attempt.requestId !== null
      ? attempt.seen ?? takeFailureById(attempt.requestId)
      : attempt.seen ?? takeTransportFailure(attempt.address, attempt.startedAt);
    if (seen) return securityRefusal(seen.error, secure) ? seen.error : null;
    if (Date.now() >= until) return null;
    await sleep(TRANSPORT_WAIT_STEP_MS);
  }
}

/**
 * One request, with "did not answer" told apart from "answered no".
 * fetch itself only rejects when nothing came back at all: refused connection,
 * DNS failure, TLS handshake gone wrong, or our own timeout.
 */
/**
 * Keep the address in flight until the body has been read.
 *
 * fetch settles as soon as the headers are in — the body is still arriving,
 * and the security layer can refuse it after that. Releasing at that point
 * left the address free, so the next request to the same endpoint started
 * uncontended and adopted the refusal belonging to the earlier one, losing its
 * own retries in the bargain. Held until the first read either way, so the
 * newcomer is marked contended and claims nothing.
 *
 * The refusal that arrives during a body is still not classified — by then the
 * catch in fetchOnce is long past, and it surfaces at the caller's read as it
 * always has. It is recorded, claimed by nobody, and ages out.
 */
/**
 * Read a body nobody wants, so its address stays occupied until it has
 * genuinely finished.
 *
 * Two answers are never read — sign-out and the wake probe, which care only
 * that something replied — and neither is one thrown out on its status. Freeing
 * those at the headers left the address open while their body was still on its
 * way: the wake probe's body failing after discovery had started on the same
 * query.cgi handed discovery a refusal that was never its own, and discovery
 * broke off on it. Draining costs one read of an answer already paid for.
 */
function releaseAfterBody(resp, release) {
  Promise.resolve()
    .then(() => (typeof resp.text === 'function' ? resp.text() : resp.json?.()))
    .catch(() => {})
    .finally(release);
}

function holdUntilRead(resp, release) {
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    release();
  };
  return {
    ok: resp.ok,
    status: resp.status,
    async json() {
      try {
        return await resp.json();
      } finally {
        done();
      }
    },
  };
}

// Permission API replies can describe the state before a grant-change event.
// Repeat those reads instead of applying an answer the browser already retired.
let permissionGeneration = 0;

async function hasCurrentPermissions(request) {
  for (;;) {
    const generation = permissionGeneration;
    const granted = await browser.permissions.contains(request);
    if (generation === permissionGeneration) return granted;
  }
}

/** A missing Firefox grant is a setup problem, before any request is sent. */
async function requireNasPermission(input) {
  if (await hasCurrentPermissions(hostPermissionForUrl(input))) return;
  const error = new Error(msg('errNasPermission', new URL(input).origin));
  error.permissionMissing = true;
  error.deliveryUnknown = false;
  throw error;
}

async function fetchOnce(input, init, timeoutMs = REQUEST_TIMEOUT_MS,
  { holdBody = true, epoch = sessionEpoch } = {}) {
  checkSessionEpoch(epoch);
  // Outside the transport catch: no grant is neither an unreachable NAS nor
  // uncertain delivery, and retrying cannot supply the user's permission.
  await requireNasPermission(input);
  checkSessionEpoch(epoch);
  // Before the request, so the browser's own reason for refusing it is caught.
  watchTransportErrors(input);
  const address = addressOf(input);
  const attempt = { address, startedAt: Date.now(), requestId: null, seen: null };
  const flight = inFlight.get(address) ?? { count: 0, contended: false };
  flight.count += 1;
  if (flight.count > 1) flight.contended = true;
  inFlight.set(address, flight);
  openAttempts.add(attempt);
  let handedOver = false;
  const release = () => {
    retireRequest(attempt);
    openAttempts.delete(attempt);
    flight.count -= 1;
    if (flight.count <= 0) inFlight.delete(address);
  };
  try {
    let resp, connectionResult;
    try {
      // Never follow a redirect. Every request from here carries something
      // private — the account password, a two-factor code, or the session id —
      // and 307 and 308 keep the method *and* the body, so a NAS, or anything
      // answering in its place, could have those re-sent to an address of its
      // choosing. Refusing afterwards would be too late: the body has gone.
      // `redirect` sits after the spread so no caller can soften it.
      resp = await fetch(input, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      connectionResult = noteConnectionResult(input, epoch);
    } catch {
      connectionResult = noteConnectionResult(input, epoch);
      const refusal = await certificateRefusal(input, attempt);
      // Kept where the popup can show it in full, and kept after this attempt
      // is over: a notification has room for one line, and the reason is worth
      // more than that.
      await rememberConnectionProblem(input, refusal, epoch, connectionResult);
      if (refusal) {
        // Two statements that have to be kept apart: what was refused, and
        // whether anything was sent.
        //
        // The wording can be confident, because the browser is quoted rather
        // than second-guessed, and repeating is pointless either way: this
        // connection was answered and turned down, so waiting for a NAS to
        // wake is no remedy. `nasUnreachable` is therefore left unset — that
        // flag is what earns a retry.
        //
        // The delivery cannot be confident. A handshake that fails before any
        // application data goes out sends nothing, but the security layer also
        // speaks up *after* a request has gone — a bad MAC on a reply, say —
        // and the two are not distinguishable from what arrives here. So this
        // stays as uncertain as every other transport failure, and an add that
        // may have landed is still reconciled against the task list.
        const err = new Error(msg('errCertificate', refusal));
        err.certificateError = true;
        err.deliveryUnknown = true;
        throw err;
      }
      const err = new Error(msg('errNasUnreachable'));
      err.nasUnreachable = true;
      // Fetch does not say whether a network error happened before or after the
      // request reached the NAS. TypeError is not proof that nothing was sent.
      err.deliveryUnknown = true;
      throw err;
    }
    // Something answered, so whatever was refused at this address before has
    // been answered with it — including a certificate the user has since dealt
    // with. Its status is beside the point here: a 401 is the NAS talking, and
    // nothing reaches the NAS through a handshake that failed.
    await forgetConnectionProblem(input, epoch, connectionResult);
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      // A NAS that is still starting its services answers 502/503 for a while.
      if (resp.status >= 500) {
        err.nasUnreachable = true;
        // It reached something. Whether that something passed it on is unknowable.
        err.deliveryUnknown = true;
      }
      // Refused on its status, but its body is still arriving and nobody here
      // will read it — so it is drained rather than abandoned.
      handedOver = true;
      releaseAfterBody(resp, release);
      throw err;
    }
    handedOver = true;
    if (!holdBody) {
      releaseAfterBody(resp, release);
      return resp;
    }
    return holdUntilRead(resp, release);
  } finally {
    // After the catch above has asked, never before it. The error event is
    // raised independently of fetch's rejection and may still be a turn away;
    // dropping the address first would have the listener discard it as
    // belonging to nothing. On the way out with a body still to come, the
    // release goes with the response instead — see holdUntilRead.
    if (!handedOver) release();
  }
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
async function apiFetch(input, init,
  { repeatable = true, timeout, deadline, epoch = sessionEpoch, delivery } = {}) {
  // Every attempt belongs to the connection this call started on. Leaving the
  // default to fetchOnce would adopt a new epoch after a settings change while
  // still retrying the old URL and session id.
  const perAttempt = timeout ?? (repeatable ? REQUEST_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  let deliveryUnknown = delivery?.unknown === true;
  for (let attempt = 1; ; attempt++) {
    // A caller working to a deadline of its own gets what is left of it and no
    // more. Without this the retries below ran their full course inside a
    // caller that had far less time to give — four attempts and three
    // ten-second waits, a minute in all — and the caller looked at its watch
    // only once they were over.
    const left = deadline === undefined
      ? perAttempt
      : Math.min(perAttempt, deadline - Date.now());
    if (left <= 0) {
      const err = new Error(msg('errNasUnreachable'));
      // This attempt never went out; an earlier one may still have arrived.
      err.nasUnreachable = true;
      if (deliveryUnknown) err.deliveryUnknown = true;
      throw err;
    }
    try {
      return await fetchOnce(input, init, left, { epoch });
    } catch (err) {
      // A later refusal only answers its own attempt. Even HTTP 403 cannot
      // settle an earlier pause/delete whose answer was lost.
      deliveryUnknown ||= err.deliveryUnknown === true;
      if (deliveryUnknown) {
        err.deliveryUnknown = true;
        if (err.connectionChanged) {
          err.sent = true;
          err.confirmed = null;
        }
      }
      // Task writes also need this history when fetch returns an HTTP response
      // and when withSession starts another call after a fresh login.
      if (delivery) delivery.unknown = deliveryUnknown;
      // Only wait for another go if there is still time to take one.
      const room = deadline === undefined || Date.now() + RETRY_DELAY_MS < deadline;
      const mayRepeat = repeatable && err.nasUnreachable && room;
      if (!mayRepeat || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Reading the response is part of a sent request's uncertain delivery window.
 *
 * The headers coming back say the NAS received it; they say nothing about what
 * it did. A body that tears halfway, or one that is not the shape the API
 * promises, therefore leaves the outcome open — not failed. Used by everything
 * that writes: creating a task, and pausing, resuming or deleting one.
 */
async function readSentResponse(response) {
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
    const url = `${buildBaseUrl(protocol, host, port)}/query.cgi` +
      `?api=SYNO.API.Info&version=1&method=query&query=${query}`;

    // No retry here on purpose: the well-known fallback paths are right for
    // every standard DSM, and the login that follows does the waiting.
    //
    // Through fetchOnce for its refusal to follow redirects. This request
    // carries nothing private, but its answer decides where the login and every
    // later call are addressed — so it is not a place to let something else
    // answer in the NAS's stead. A bad status throws there and lands in the
    // catch below, which is the same fallback the status check used to make.
    const resp = await fetchOnce(url);
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
  } catch (err) {
    // Neither a refused certificate nor missing website access can be fixed
    // by trying another API path at the same address.
    if (err?.certificateError || err?.permissionMissing) throw err;
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
async function login(settings, otpCode, knownApis, { deadline, epoch = sessionEpoch } = {}) {
  const { protocol, host, port, username, password } = settings;
  if (!isConfigured(settings)) {
    throw new Error(msg('setupRequired'));
  }
  // Read before anything goes out, so a refusal can be compared against the
  // sign-ins that succeeded while it was away — see outdatedAuthFailure.
  const startedAt = signInsAccepted;
  // Callers that already resolved the paths pass them in. Discovery has its own
  // timeout, and with an unreachable NAS repeating it here doubled the wait
  // before the caller ever got an answer.
  const apis = knownApis ?? await discoverApiPaths(protocol, host, port);
  const base = buildBaseUrl(protocol, host, port);

  const { deviceToken } = await browser.storage.local.get({ deviceToken: '' });
  // A saved connection can change while discovery or this read is waiting.
  // Never send a code or password prepared by a view of the previous one.
  checkSessionEpoch(epoch);

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
  //
  // A code is good for one use, so a login carrying one is never repeated. An
  // unanswered request is not a request that failed: the NAS may well have
  // accepted the code and only the reply went missing, and asking again then
  // spends it a second time — DSM answers "wrong code", and that is what got
  // kept as the reason. A password or a device token can be offered as often
  // as it takes, which is what a sleeping NAS relies on; see wakeNas.
  const resp = await apiFetch(`${base}/${apis.authPath}`, { method: 'POST', body: params },
    { deadline, repeatable: !otpCode, epoch });
  const json = await resp.json();

  if (!json.success) {
    const code = json.error?.code;
    const err = new Error(msg('errLoginFailed', describeError(AUTH_ERRORS, code ?? 'unknown')));
    // Marks this as a sign-in problem, which is reported even with
    // notifications switched off.
    err.authFailed = true;
    err.startedAt = startedAt;
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
 * Sign-ins the NAS has accepted, counted so a refusal can be placed in time.
 *
 * Every refused login is stamped with this count as it stood when that attempt
 * began — see login() — which is what tells a refusal that still stands apart
 * from one a later, successful sign-in has already overtaken.
 */
let signInsAccepted = 0;

/**
 * Whether a refused sign-in has been overtaken by one that worked.
 *
 * A task list or a poll signs in on its own account. While it is away the user
 * types a two-factor code, that login succeeds, and the older refusal arrives
 * last — asking for a code the session no longer needs. In the popup it put the
 * prompt back up and stopped the refresh; in the poll it ended the watch and
 * threw away the tasks being watched, over a NAS that was answering fine.
 *
 * The sign-in has to have been accepted *since* this attempt started, and a
 * session has to be in hand now. Either alone proves nothing.
 */
function outdatedAuthFailure(err) {
  return err?.authFailed === true
    && Number.isInteger(err.startedAt)
    && !!cachedSid
    && signInsAccepted > err.startedAt;
}

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

function checkSessionEpoch(epoch, { sent = false, confirmed = false } = {}) {
  if (epoch === sessionEpoch) return;
  const error = new Error(msg('connectionFailed'));
  error.connectionChanged = true;
  // Whether the call this interrupts had already gone out, and what the NAS
  // said about it. A connection change discovered *after* a delete was carried
  // out is not "nothing happened": the task is gone, and with it the only copy
  // of the link it was created from. Without these marks the retry treated
  // every change as a step that never ran and let the link go.
  //
  // `confirmed` has three answers, not two: true when the NAS carried the call
  // out, false when it plainly turned it down, null when its reply does not
  // say. It used to be `result.success === true`, which is the envelope alone —
  // a reply of "call accepted" carrying a refusal for this very task, or no
  // task result at all, both counted as a confirmed deletion. The caller then
  // announced a task it had not removed. See taskActionVerdict.
  error.sent = sent;
  error.confirmed = confirmed;
  throw error;
}

/**
 * Whether the connection an add was meant for has been replaced since `epoch`
 * was taken. Waits for a change still being written, so a half-saved one
 * counts. Without an epoch the caller did not bind the add to a connection.
 *
 * `connection` is the key the popup took before it began preparing the add.
 * The epoch only starts counting once the message has arrived, and preparing an
 * add takes long enough for a new connection to be saved before that: the links
 * then went to the NAS saved meanwhile.
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
    signInsAccepted++;
    cachedConnectFailure = null;
    cachedConnection = connectionSettings(settings);
    await browser.storage.session.set({ sid: cachedSid, sessionConnection: cachedConnection });
    // This account just signed in, so any kept refusal has been answered.
    // Cleared here rather than only where a test is run, so a sign-in the
    // background made on its own counts too.
    await browser.storage.session.remove('lastConnect');
    // The same answer for a refusal kept somewhere else: an add's outcome waits
    // in session storage for a popup that may open long afterwards, and it used
    // to bar the very session that has just been established. Nothing in the
    // settings changed, so the connection alone could not tell them apart — it
    // takes an attempt to. See readConnectionVersion.
    await bumpConnectionVersion();
    if (result.deviceToken) await browser.storage.local.set({ deviceToken: result.deviceToken });
    return cachedSid;
  });
}

/**
 * The refusal a kept failure hands out in place of a sign-in.
 *
 * One definition, because two places turn callers away with it: getSession,
 * where the sign-in itself would have happened, and withSession, which asks
 * before it spends anything at all. Two of them would drift apart, and every
 * caller reads these marks — the poll keeps its watch on connectBlocked, a bulk
 * add abandons the rest of its batch on authFailed.
 */
function blockedSignIn() {
  return Object.assign(
    new Error(cachedConnectFailure?.error?.message ?? msg('connectionFailed')),
    {
      connectBlocked: true,
      authFailed: cachedConnectFailure?.permissionMissing !== true,
      certificateError: cachedConnectFailure?.certificateError === true,
      permissionMissing: cachedConnectFailure?.permissionMissing === true,
      startedAt: signInsAccepted,
      otpRequired: cachedConnectFailure?.otpRequired === true,
      otpWrong: cachedConnectFailure?.otpWrong === true,
    },
  );
}

/**
 * Whether an automatic sign-in would be turned away before it is even tried.
 *
 * Asked ahead of the work, so nothing is spent on a call that cannot go out.
 * Both exceptions matter: an existing session still carries the request, and a
 * sign-in already on its way was started before the failure was kept, so it is
 * not blocked either. Only when neither can help is the answer already fixed.
 */
function signInBlocked() {
  return !!cachedConnectFailure && !cachedSid && !loginInFlight;
}

/**
 * Get a valid session ID, logging in if necessary.
 */
function getSession(settings, knownApis, { force = false, deadline } = {}) {
  if (cachedSid && !force) return Promise.resolve(cachedSid);
  if (!loginInFlight) {
    if (!force && cachedConnectFailure) return Promise.reject(blockedSignIn());
    const epoch = sessionEpoch;
    let attempt;
    // The deadline binds the login this call starts. One that was already on
    // its way belongs to whoever started it and keeps that caller's budget.
    attempt = login(settings, undefined, knownApis, { deadline })
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
async function apiLogout({ epoch = null, signIns = null } = {}) {
  await stateReady;
  // Asked for by a watcher that may have been overtaken while it read the
  // settings. The session in hand now is not the one it meant to give back if
  // the connection has changed or any sign-in has been accepted since — and
  // handing back a session that something else is using signs the user out
  // from under their own popup. Checked here, immediately before the id is
  // taken out of circulation, rather than at the call site where another turn
  // could still slip in between.
  if (epoch !== null && epoch !== sessionEpoch) return;
  if (signIns !== null && signIns !== signInsAccepted) return;
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
    //
    // Through fetchOnce rather than a fetch of its own, so the refusal to follow
    // redirects covers this request too. It carries the session id in its body,
    // and 307 and 308 keep the body — so a redirect here would hand the id to
    // whatever answered, and dropping the session on our side does not take it
    // back again.
    await fetchOnce(`${base}/${apis?.authPath ?? 'auth.cgi'}`, {
      method: 'POST',
      body: new URLSearchParams({
        api:     'SYNO.API.Auth',
        version: String(apis?.authVersion ?? 3),
        method:  'logout',
        session: 'DownloadStation',
        _sid:    sid,
      }),
    }, REQUEST_TIMEOUT_MS, { holdBody: false });
  } catch {
    // Network gone, NAS asleep — nothing useful to report.
  }
}

/**
 * How far the connection has moved on, counted in a way that outlives this
 * script: it rises when the configured NAS or account changes, and again
 * whenever a sign-in is accepted.
 *
 * Both, because both retire a kept refusal. connectionKey deliberately leaves
 * the password out — changing one does not change whose tasks these are — so a
 * sign-in refused with the old password looked to the popup exactly like news
 * about the connection in front of it and shut the corrected one out. And a
 * password that was never wrong to begin with is settled the same way: the
 * account signs in, and a refusal older than that session has been answered,
 * which is what acceptLogin has always done with the failure it keeps itself.
 *
 * sessionEpoch cannot do this job: it lives in a variable, and the event page is
 * thrown away whenever it goes idle, so it is back at zero long before a
 * recorded outcome is read. The number is kept where the records are kept, and
 * the password itself stays out of it.
 *
 * The limit, deliberately accepted: the stamp says when an add was asked for,
 * not when its refusal happened. A sign-in accepted early in an add whose later
 * sign-in is then refused retires that refusal too. It costs one refused
 * attempt until the next test; barring a session that works costs the user the
 * connection.
 */
async function readConnectionVersion() {
  const { connectionVersion } = await browser.storage.session.get({ connectionVersion: 0 });
  return connectionVersion;
}

async function bumpConnectionVersion() {
  // Only ever from the settings write queue, so this read and write are alone.
  await browser.storage.session.set({ connectionVersion: await readConnectionVersion() + 1 });
}

/** Clear everything (call when host/port/protocol changes). */
async function clearAll() {
  cachedSid      = null;
  cachedApiPaths = null;
  cachedConnection = null;
  cachedConnectFailure = null;
  // Anything still logging in was aimed at the old NAS — disown it.
  sessionEpoch++;
  loginInFlight = null;
  // The same change, in the one form a popup can still check minutes later.
  await bumpConnectionVersion();
  // Badge is intentionally NOT cleared here — active downloads may still be
  // running on the NAS. Only updateBadge() clears it when count reaches 0.
  // A kept sign-in failure belonged to the connection being left behind: it is
  // no longer true of the one configured now, in either direction.
  return browser.storage.session.remove(['sid', 'apiPaths', 'sessionConnection', 'lastConnect']);
}

// Draft operations have their own queue: typing must not wait for NAS logout.
// Every view writes through this queue, so a checked removal cannot overtake
// newer input between its storage read and the actual removal.
let connectionDraftWrites = Promise.resolve();

function updateConnectionDraft({ operation, draft, revision }) {
  const run = connectionDraftWrites.then(async () => {
    const stored = await browser.storage.session.get({ connDraftRevision: 0 });
    const current = stored.connDraftRevision;
    if (operation === 'read') return { ok: true, revision: current };
    if (operation === 'write') {
      await browser.storage.session.set({ connDraft: draft, connDraftRevision: current + 1 });
    } else if (current === revision) {
      await browser.storage.session.remove('connDraft');
      await browser.storage.session.set({ connDraftRevision: current + 1 });
    }
    return { ok: true };
  });
  connectionDraftWrites = run.catch(() => {});
  return run;
}

// Folder edits have independent ownership, including an intentionally empty
// folder. Serialize removal with writes from every view, just like credentials.
let destinationDraftWrites = Promise.resolve();

function updateDestinationDraft({ operation, draft, revision }) {
  const run = destinationDraftWrites.then(async () => {
    const { destDraftRevision: current } = await browser.storage.session.get({ destDraftRevision: 0 });
    if (operation === 'read') return { ok: true, revision: current };
    if (operation === 'write') {
      await browser.storage.session.set({ destDraft: draft, destDraftRevision: current + 1 });
    } else if (current === revision) {
      await browser.storage.session.remove('destDraft');
      await browser.storage.session.set({ destDraftRevision: current + 1 });
    }
    return { ok: true };
  });
  destinationDraftWrites = run.catch(() => {});
  return run;
}

// A later magnet choice or reset retires errors from an earlier queued save.
let magnetPreferenceGeneration = 0;

/** Apply a connection change while its previous endpoint is still known. */
function updateSettings({ connection, options = {}, signOut = false, reset = false, draftRevision, destDraftRevision }) {
  const magnetGeneration = reset || Object.hasOwn(options, 'autoCaptureMagnets')
    ? ++magnetPreferenceGeneration : null;
  // The popup can close while the old NAS is signing out. Capture ownership
  // before queuing this operation and finish its cleanup here, independently
  // of the view that requested it. A later draft write keeps its newer revision.
  const draftSnapshot = reset || signOut
    ? Number.isSafeInteger(draftRevision) && draftRevision >= 0
      ? Promise.resolve({ revision: draftRevision })
      : updateConnectionDraft({ operation: 'read' })
    : null;
  draftSnapshot?.catch(() => {});
  const destinationSnapshot = reset
    ? Number.isSafeInteger(destDraftRevision) && destDraftRevision >= 0
      ? Promise.resolve({ revision: destDraftRevision })
      : updateDestinationDraft({ operation: 'read' })
    : null;
  destinationSnapshot?.catch(() => {});
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
      if (draftSnapshot) {
        const { revision } = await draftSnapshot;
        await updateConnectionDraft({ operation: 'clear', revision });
      }
      // Retire the old reset state before waiting for the NAS. Input entered
      // during that network wait is new work and must not be cleared afterwards.
      if (reset) {
        const { revision } = await destinationSnapshot;
        await updateDestinationDraft({ operation: 'clear', revision });
        await browser.storage.session.remove(['bulkDraft', 'lastAdd', 'lastTab', 'setupRequired']);
      }
      await logoutSession(oldSid, oldConnection, oldApis);
      updateBadge([]);
    }

    // Connection fields and trusted-device tokens are never option writes.
    const optionValues = Object.fromEntries(Object.entries(options)
      .filter(([key]) => !CONNECTION_KEYS.includes(key) && key !== 'deviceToken'));
    await browser.storage.local.set(optionValues);
    await syncKeepaliveAlarm();
    if (magnetGeneration !== null) {
      // These removals share the write queue with error records: every saved
      // choice settles older errors, even while another choice is queued.
      await browser.storage.session.remove('magnetPreferenceError');
    }
    return { ok: true };
  });
}

/** Own the save after its toolbar popup closes to reveal Firefox's prompt. */
function queueMagnetPreference(enabled) {
  const writing = updateSettings({ options: { autoCaptureMagnets: enabled } });
  const generation = magnetPreferenceGeneration;
  writing.catch(error => queueSettingsWrite(async () => {
    if (generation !== magnetPreferenceGeneration) return;
    await browser.storage.session.set({
      magnetPreferenceError: { message: error?.message || msg('extensionError'), enabled },
    });
  })).catch(() => {});
  // This confirms queue ownership, not that the preference is already stored.
  return { accepted: true };
}

let magnetSettingsGeneration = 0;
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoCaptureMagnets' in changes) magnetSettingsGeneration++;
});

/** The preference stays saved; capturing requires both broad website grants. */
async function getMagnetCaptureState() {
  for (;;) {
    const writes = settingsWriteQueue;
    await writes;
    const permission = permissionGeneration;
    const preference = magnetSettingsGeneration;
    const { autoCaptureMagnets } = await browser.storage.local.get({ autoCaptureMagnets: false });
    const enabled = autoCaptureMagnets === true
      && await hasCurrentPermissions({ origins: [...MAGNET_ORIGINS] });
    if (writes !== settingsWriteQueue || permission !== permissionGeneration
        || preference !== magnetSettingsGeneration) continue;
    return { enabled };
  }
}

/** Existing content scripts remain loaded after host access is revoked. */
async function invalidateMagnetCapture() {
  try {
    const tabs = await browser.tabs.query({});
    await Promise.all(tabs.map(tab => browser.tabs.sendMessage(tab.id, {
      action: ACTIONS.MAGNET_CAPTURE_CHANGED,
    }).catch(() => {})));
  } catch {
    // Closed tabs and pages without our content script need no update.
  }
}

// Restoring website access lifts only a refusal caused by that missing grant.
// Password, two-factor and certificate failures still need their own remedy.
browser.permissions.onAdded.addListener(() => {
  permissionGeneration++;
  const capture = invalidateMagnetCapture();
  const connection = queueSettingsWrite(async () => {
    await stateReady;
    const failure = cachedConnectFailure;
    if (!failure?.permissionMissing) return;
    const settings = await getSettings();
    const permitted = await hasCurrentPermissions(hostPermissionForUrl(
      buildConnectionUrl(settings.protocol, settings.host, settings.port)));
    if (!permitted || cachedConnectFailure !== failure) return;
    cachedConnectFailure = null;
    await browser.storage.session.remove('lastConnect');
  });
  return Promise.all([capture, connection]);
});

// Revoking access suspends capture without changing the user's preference.
browser.permissions.onRemoved.addListener(({ origins = [] }) => {
  permissionGeneration++;
  if (origins.length === 0) return;
  return invalidateMagnetCapture();
});

async function getConnectionStatus() {
  await stateReady;
  for (;;) {
    await settingsWriteQueue;
    const epoch = sessionEpoch;
    const generation = permissionGeneration;
    const settings = await getSettings();
    let missingUrl = null;
    if (isConfigured(settings)) {
      const url = buildConnectionUrl(settings.protocol, settings.host, settings.port);
      if (!await hasCurrentPermissions(hostPermissionForUrl(url))) missingUrl = url;
    }
    if (epoch !== sessionEpoch || generation !== permissionGeneration) continue;
    if (missingUrl) return { connected: false, permissionMissing: true,
      error: { message: msg('errNasPermission', new URL(missingUrl).origin) } };
    return { connected: cachedSid !== null };
  }
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
 *
 * `verdict` reads that body the way the caller reads it: true when the NAS
 * carried the call out, false when it turned it down, null when the reply does
 * not say. Only the caller can tell — this function sees an envelope, and a
 * `success: true` envelope may still carry a refusal for the very task it was
 * asked about. Without one, `success` alone answers, which is all a call with
 * nothing inside it to refuse has to go on anyway.
 */
async function withSession(apiFn, { epoch = sessionEpoch, create = false, deadline,
  verdict = null } = {}) {
  await stateReady;
  await settingsWriteQueue;
  checkSessionEpoch(epoch);
  const settings = await getSettings();
  checkSessionEpoch(epoch);
  // Asked before anything is spent. The sign-in below is going to be turned
  // away, and API discovery is a request in its own right — one that does not
  // even keep what it learns when it fails, so it runs again every time. With
  // no stored paths, after a browser restart or an earlier failed discovery,
  // every monitoring tick asked query.cgi afresh for a sign-in that never
  // happened: unbounded traffic to a NAS the extension had decided not to
  // contact.
  if (signInBlocked()) throw blockedSignIn();
  // Discovery is preparation in exactly the same sense as the sign-in below,
  // and gets the same treatment — see nothingSent. Left outside it, a refused
  // certificate during discovery was passed on as an action whose result is
  // unknown: with no cached paths, pausing a task asked query.cgi, got nothing,
  // and the popup was told the pause might have happened. Only query.cgi had
  // gone out, and the certificate message was lost behind the uncertainty.
  const apis = await nothingSent(
    discoverApiPaths(settings.protocol, settings.host, settings.port));
  checkSessionEpoch(epoch);
  // Signing in sends nothing at all — see nothingSent. This used to apply only
  // to creates, so a sign-in that got no answer ahead of a pause, resume or
  // delete was reported as an action whose result is unknown, when no action
  // had gone out to have a result.
  const signIn = () => nothingSent(getSession(settings, apis, { deadline }));
  /**
   * Refused — but if a later sign-in succeeded while this one was away, that
   * refusal is about a session nobody is using any more. Asking again costs
   * nothing: getSession hands back the cached id without another request.
   *
   * Both ways in need this. The second one below is the one the trouble came
   * through: a task list finds the session gone, signs in again on its own
   * account, and is refused while the user is part-way through typing a code.
   */
  const signInUnlessOvertaken = async () => {
    try {
      return await signIn();
    } catch (err) {
      if (!outdatedAuthFailure(err)) throw err;
      return signIn();
    }
  };
  let sid = await signInUnlessOvertaken();
  checkSessionEpoch(epoch);
  let result = await apiFn(settings, sid, apis);
  if (result.success) noteSessionUsed(sid);
  // A parsed successful create is a known outcome even if the user changed
  // connections while its reply was on the way. Do not offer it again.
  if (create && result.success) return result;
  checkSessionEpoch(epoch, { sent: true, confirmed: judge(verdict, result) });

  if (!result.success && SESSION_ERROR_CODES.has(result.error?.code)) {
    if (cachedSid === sid) await clearSession();
    checkSessionEpoch(epoch);
    sid = await signInUnlessOvertaken();
    checkSessionEpoch(epoch);
    result = await apiFn(settings, sid, apis);
    if (result.success) noteSessionUsed(sid);
    if (create && result.success) return result;
    checkSessionEpoch(epoch, { sent: true, confirmed: judge(verdict, result) });
  }

  return result;
}

/** What the caller makes of this reply, or the envelope where it says nothing. */
function judge(verdict, result) {
  return verdict ? verdict(result) : result.success === true;
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
 * What the reply says about each task it mentions: id to code, or to null where
 * the entry is there but unreadable.
 *
 * One reading, used twice — by the verdict the connection change is judged on
 * and by the outcome the user is shown. Two readings of the same reply could
 * disagree, and the one that disagreed would be the one nobody was looking at.
 */
function taskResultCodes(result) {
  const codes = new Map();
  // A null or non-object entry must not throw here: unreadable is unconfirmed.
  for (const item of Array.isArray(result?.data) ? result.data : []) {
    if (item && typeof item === 'object') codes.set(item.id, taskResultCode(item.error));
  }
  return codes;
}

/**
 * Did the NAS do what it was asked, to every one of `ids`? true when it did,
 * false when it plainly refused, null when its reply does not say.
 *
 * The envelope is not the answer. DSM replies `success: true` to a call it
 * accepted and then refuses individual tasks inside it — and sometimes sends no
 * task results at all. Both used to count as a confirmed deletion, so a retry
 * interrupted by a connection change announced "the task was removed" over a
 * task still sitting on the NAS, or over one whose fate nobody knew.
 *
 * 404 is not a refusal: it says the task is not there, and an earlier attempt
 * whose answer was lost may have taken it — see apiRetryTask. Tasks that do not
 * agree leave the whole thing unsaid; one id, the case this decides, is never
 * ambiguous that way.
 */
function taskActionVerdict(result, ids) {
  // A parsed error code turns the whole call down: nothing in it was carried out.
  if (result?.success !== true) return false;
  const codes = taskResultCodes(result);
  const answers = new Set(ids.map(id => {
    const code = codes.get(id) ?? null; // never mentioned reads the same as unreadable
    if (code === 0) return true;
    return code === null || code === 404 ? null : false;
  }));
  return answers.size === 1 ? [...answers][0] : null;
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
  // Kept for this whole operation, including transport retries and a renewed
  // session. Only a positive answer for an id settles its earlier lost reply.
  const delivery = { unknown: false };
  let result;
  try {
    result = await withSession(async (settings, sid, apis) => {
      const base = buildBaseUrl(settings.protocol, settings.host, settings.port);
      const body = new URLSearchParams({
        api:     'SYNO.DownloadStation.Task',
        version: String(apis.taskVersion),
        method,
        id:      ids.join(','),
        _sid:    sid,
      });
      const resp = await apiFetch(`${base}/${apis.taskPath}`, { method: 'POST', body }, { delivery });
      // This action has been sent. A body that never finishes arriving says
      // nothing about whether the NAS carried it out — see readSentResponse.
      return readSentResponse(resp);
    }, { epoch, verdict: reply => {
      const confirmed = taskActionVerdict(reply, ids);
      return delivery.unknown && confirmed === false ? null : confirmed;
    } });
  } catch (err) {
    // withSession checks answered calls; a rejected fetch or response body
    // never reaches that check. Keep its delivery outcome, but prevent an old
    // resume from starting a watch (and logging out an idle session) on a NAS
    // configured while the answer was on its way. Login errors may be shared.
    if (epoch !== sessionEpoch) {
      err = Object.assign(new Error(err.message), err, { connectionChanged: true });
    }
    if (!delivery.unknown || err.confirmed === true) throw err;
    // A failed replacement login is shared with other callers. Copy its error:
    // only this operation had already sent a task write before that login.
    throw Object.assign(new Error(err.message), err,
      { deliveryUnknown: true, sent: true, confirmed: null });
  }
  if (!result.success) {
    const reason = await describeTaskError(result.error?.code ?? 'unknown');
    const unconfirmed = delivery.unknown ? [...ids] : [];
    // A first-attempt refusal is definite. After a lost reply it leaves every
    // id open, even though this later call itself was plainly turned down.
    return { ...result, affected: 0, failed: [], unconfirmed,
      ...(delivery.unknown ? { deliveryUnknown: true } : {}), error: {
      ...result.error, message: unconfirmed.length
        ? `${reason}\n${msg('taskActionUnconfirmed', String(unconfirmed.length))}` : reason,
    } };
  }

  const responses = taskResultCodes(result);

  const failed = [], unconfirmed = [], refusals = [];
  let affected = 0;
  for (const id of ids) {
    const code = responses.get(id) ?? null; // never mentioned reads the same as unreadable
    if (code === 0) affected++;
    else {
      if (code === null || delivery.unknown) unconfirmed.push(id);
      else failed.push({ id, code });
      if (code !== null) refusals.push({ id, code });
    }
  }

  // One description per code, not per task: a hundred tasks refused for the
  // same reason are one sentence, and phrasing a 403 reads the settings.
  const texts = new Map();
  for (const code of new Set(refusals.map(item => item.code))) {
    texts.set(code, await describeTaskError(code));
  }
  const messages = refusals.map(item => `${item.id}: ${texts.get(item.code)}`);
  // Not notifyUncertain: the NAS did answer here, just not about these tasks.
  if (unconfirmed.length) messages.push(msg('taskActionUnconfirmed', String(unconfirmed.length)));

  return {
    ...result,
    success: failed.length === 0 && unconfirmed.length === 0,
    affected,
    failed,
    unconfirmed,
    ...(delivery.unknown ? { deliveryUnknown: unconfirmed.length > 0 } : {}),
    ...(messages.length
      ? { error: { code: refusals[0]?.code ?? 'unknown', message: messages.join('\n') } }
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
async function bulkOverTasks(method, pick, connection, epoch) {
  // "Delete all" confirmed while looking at the old NAS's list must not clear
  // out the new one — see taskActionEpoch.
  epoch ??= await taskActionEpoch(connection);
  // Reading the list changes nothing on the NAS, so a failure here is a
  // connection problem and not an action whose result is in doubt.
  const listed = await nothingSent(apiListTasks(epoch));
  if (!listed.success) return { success: false, error: listed.error };

  const ids = (listed.data?.tasks ?? []).filter(pick).map(t => t.id);
  if (ids.length === 0) return { success: true, affected: 0, failed: [], unconfirmed: [] };

  return apiBulkTaskAction(method, ids, epoch);
}

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
  // Ahead of everything, and above all ahead of the delete below. A link the
  // NAS cannot be given unambiguously will not come back as a task, so sending
  // the delete first cost the original and put nothing in its place.
  const unsendable = unsendableUri(uri);
  if (unsendable) {
    return { success: false, deliveryUnknown: false, error: { message: unsendable } };
  }
  // Nothing has been touched yet. The error carries the "delivery unknown" mark
  // of any unanswered request, but here it would be false: nothing was sent.
  try {
    // A kept sign-in failure also bars this add path. Even a successful wake
    // would only clear its diagnostic before the delete meets the same block.
    checkSessionEpoch(epoch);
    if (signInBlocked()) throw blockedSignIn();
    await wakeNas({ epoch });
  } catch (err) {
    return { success: false, deliveryUnknown: false,
      connectionChanged: err.connectionChanged === true,
      certificateError: err.certificateError === true,
      permissionMissing: err.permissionMissing === true, error: { message: err.message } };
  }
  let removed;
  try {
    removed = await apiBulkTaskAction('delete', [id], epoch);
  } catch (err) {
    // The delete went out and nothing came back at all. It may well have taken
    // the task with it, and the task held the only copy of this link, so the
    // link goes back into the popup's list before anything else. Still no
    // replacement: the task may equally be standing, and a second one beside it
    // is worse than none.
    //
    // Only a delete that may actually have gone out leaves anything to rescue.
    // A refused sign-in, and any failure before the request was sent — a
    // sign-in that timed out, for instance — never reached the task API.
    // Rescuing there put the link back and reported a deletion the NAS had not
    // confirmed, describing a delete that never happened and burying the
    // connection failure that was the real reason.
    //
    // A changed connection used to be counted with those, and that was wrong
    // whenever the change was noticed *after* the delete had gone out: the task
    // could already be gone, taking the only copy of this link with it, and the
    // retry let both go. `sent` says the request had left; see checkSessionEpoch.
    if (err?.deliveryUnknown !== true && err?.sent !== true) throw err;
    // The delete went out, and the NAS turned it down. The task is standing
    // with its link in it, exactly as when a refusal arrives without any
    // connection change — which is handed on as it is, keeping nothing. Before
    // this, "the request had left" was the whole question and a refusal counted
    // as a deletion: the retry announced a task it had not removed.
    if (err?.confirmed === false) throw err;
    return keptLinkOutcome(
      { success: false, deliveryUnknown: err?.deliveryUnknown === true,
        permissionMissing: err?.permissionMissing === true },
      uri, err?.message ?? msg('notifyUncertain'), destination,
      { resent: false, removed: err?.confirmed === true,
        cause: causeOf(err) ?? (err?.deliveryUnknown && !err?.nasUnreachable && !err?.connectionChanged
          ? err.message : null) });
  }
  if (!removed.success) {
    // A delete nobody confirmed may well have gone through, and the task it
    // took with it held the only copy of this link. No replacement is created —
    // an unconfirmed delete is exactly the case where one could end up beside a
    // task that is still there — but the link goes back into the popup's list,
    // so it is one press away whichever way the delete went. A delete the NAS
    // plainly refused leaves the task standing, link and all: nothing to keep.
    // 404 says the task is not there. It may have gone with an earlier attempt
    // whose answer was lost — apiFetch repeats a delete — so this is the same
    // open outcome as no answer at all, and the link is rescued the same way.
    const alreadyGone = removed.failed?.some(item => item.code === 404);
    if (!removed.unconfirmed?.length && !alreadyGone) return removed;
    return keptLinkOutcome(removed, uri,
      removed.error?.message ?? msg('notifyUncertain'), destination,
      { resent: false, cause: removed.deliveryUnknown ? removed.error?.message : null });
  }

  let outcome, reason, cause = null;
  try {
    outcome = await apiAddTaskBatch([uri], unzipPassword, epoch, { destination });
    if (outcome.success) return outcome;
    reason = await describeTaskError(outcome.error?.code ?? 'unknown',
      outcome.destinationUsed ?? destination);
  } catch (err) {
    outcome = { success: false, deliveryUnknown: err.deliveryUnknown === true,
      permissionMissing: err.permissionMissing === true };
    reason = err.deliveryUnknown ? msg('notifyUncertain') : err.message;
    // The uncertainty above stands, but it is not all there is to say: where
    // the browser named a cause, that is the one thing the user can act on.
    cause = causeOf(err);
  }

  return keptLinkOutcome(outcome, uri, reason, destination, { cause });
}

/**
 * Hand back an outcome that left the user with a link and no task.
 *
 * Every way a retry can end that way passes through here: the replacement was
 * refused, its answer never arrived, or the delete before it was never
 * confirmed. In each case the link is put back where it can be sent again, and
 * the folder the task was in is named — a NAS without a default destination
 * refuses a create that names none.
 *
 * What the user reads tells the three apart. `resent: false` means the delete
 * was never confirmed and nothing was created afterwards. An unanswered
 * replacement means the opposite: the delete did go through, and the new task
 * may well be standing. Saying "the task was removed, adding it again did not
 * work" describes a step that never ran in the first case and one whose result
 * nobody knows in the second, and invites a second Add beside a task that may
 * already be there.
 */
async function keptLinkOutcome(outcome, uri, reason, destination,
  { resent = true, removed = false, cause = null } = {}) {
  await keepLinkForLater(uri);
  // Four endings, not two. A replacement whose answer never arrived is not a
  // replacement that failed: the delete did go through, and the new task may be
  // standing. Saying "adding it again did not work" there sent people to press
  // Add beside a task that already existed. And a NAS switched away from after
  // the delete had been carried out is different again — the task really is
  // gone, and nothing was created because there was no longer anywhere to
  // create it. "The NAS did not confirm the deletion" would be untrue there.
  const message = removed ? msg('retryLinkKeptSwitched')
    : !resent ? msg('retryLinkKeptUnsent')
    : outcome.deliveryUnknown ? msg('retryLinkKeptUnknown')
    : msg('retryLinkKept', reason);
  // What the browser refused, where it said so, carried alongside rather than
  // in place of any of those: the link being kept is what the user must know,
  // the reason is what they can act on, and neither replaces the other.
  const full = [message, cause, destination ? msg('retryOriginalFolder', destination) : null]
    .filter(Boolean).join(' ');
  return {
    ...outcome,
    linkKept: true,
    error: { ...outcome.error, message: full },
  };
}

/** A specific connection problem to keep alongside delivery uncertainty. */
function causeOf(err) {
  return err?.certificateError || err?.permissionMissing ? err.message : null;
}

/*
 * There is no file upload here any more, and no SYNO.DownloadStation2.Task.
 *
 * Two walls stood in its way. A file dialog takes the focus from the popup, so
 * Firefox closes it and the code that was to read the chosen file dies with it —
 * the button did nothing at all. Moving the picker into a window of its own
 * solved that, and then the NAS refused the upload: DSM 7 answers the Task
 * API's own create with 101 whatever shape it is given, and the endpoint it
 * does accept, entry.cgi, checks the session before it parses the upload, so
 * the session id has to travel in the URL — where the NAS writes it into its
 * own web server log, which is exactly what this extension avoids everywhere
 * else.
 *
 * A torrent's link goes through the context menu with neither problem, and the
 * NAS fetches the file itself. The popup's Files section says so.
 */

/**
 * Close out a bulk add: start watching, tell the user, and shape the answer
 * the popup expects.
 *
 * Kept apart from the loop that produces these three numbers, so the reporting
 * — notification categories included — lives in one place rather than being
 * repeated by every caller that counts something up.
 */
async function reportAddOutcome(added, failed, reason, extra = {}, epoch = sessionEpoch) {
  if (added > 0) startDownloadPolling(epoch);

  // Refused and unconfirmed are not the same thing and are no longer counted as
  // one. A link turned down never reached the NAS; one whose answer went missing
  // may well be downloading right now. Rolled together, a batch of one refusal
  // and one unanswered create was announced as "0 added, 2 failed" over a
  // download that was already running, and the uncertainty never showed at all.
  const uncertain = extra.uncertain ?? 0;
  const refused   = Math.max(failed - uncertain, 0);

  const title = failed === 0 ? msg('extensionName') : msg('notifyPartial');
  // How the reason is said out loud, decided once for both places below.
  // Shorten the selected reason, including when the lookup failed for a
  // different reason from an earlier add. The popup keeps the full message.
  const announced = shortReason({ certificateError: extra.certificateReason,
    permissionMissing: extra.permissionReason, message: reason ?? '' });
  const said  = failed === 0 || refused === 0
    ? msg('notifyBulkAdded', String(added))
    : msg('notifyBulkPartial', String(added), String(refused), announced);

  const parts = [said];
  // Always said out loud when there is any, whatever else the batch did.
  if (uncertain > 0) parts.push(msg('notifyBulkUncertainCount', String(uncertain)));
  // The reason travels with the refusals above — and when there were none it
  // travelled nowhere at all. A create that went unanswered and a sign-in that
  // was then turned down announced itself as "0 added, 1 uncertain", with the
  // wrong password, the one thing anyone could act on, left out entirely.
  if (refused === 0 && failed > 0 && extra.namedReason && reason) parts.push(announced);
  const body = parts.join(' ');

  // A broken destination stops everything, so it gets through regardless.
  if (failed > 0 && extra.configError) notifyAlways(title, body);
  else notify(failed === 0 ? 'added' : 'failed', title, body);

  return { success: failed === 0, added, failed, errorMessage: reason, ...extra };
}

/**
 * Shape the per-item outcomes into the answer the popup expects. The failures
 * go back as `failedUrls`, which is what puts them into the box to be tried
 * again. This took the name as an argument while files were added the same way;
 * links are the only ones left.
 */
async function summariseAdd(added, failed, lookupRefused = null, epoch = sessionEpoch) {
  // Which failure speaks for the whole batch. Not simply the first one any
  // more: a link turned down before anything was sent sorts ahead of a refused
  // sign-in by position alone, and reporting it buried the one thing the user
  // could act on — the notification named a comma while the password was wrong.
  const first = failed.find(entry => entry.permissionMissing)
    ?? failed.find(entry => entry.authFailed)
    ?? failed.find(entry => isConfigError(entry.code))
    ?? failed.find(entry => entry.certificateError && !entry.unknown)
    ?? failed[0];
  const reason = failed.length === 0 ? null
    // The lookup could not sign in. That is the one thing the user can act on,
    // and it used to disappear behind "outcome uncertain" — or behind nothing
    // at all, since an uncertain add is not reported with notifications off.
    : lookupRefused ? lookupRefused.message
    // An unanswered create is not a refusal, and saying "the NAS is not
    // reachable" made it read as one. The notification is often the only thing
    // seen — the popup may well be closed by then — and on that wording the
    // obvious move is to press Add again, which is how links ended up twice.
    : first.unknown ? msg('notifyUncertain')
    : first.code !== undefined ? await describeTaskError(first.code, first.destinationUsed)
    : first.message;
  // A named API refusal explains the failed lookup without turning a valid
  // login into a blocked connection. Authentication, TLS and missing browser
  // permission do block further requests until the user resolves the cause.
  const blockConnection = lookupRefused?.authFailed === true
    || lookupRefused?.certificateError === true || lookupRefused?.permissionMissing === true;

  return reportAddOutcome(added.length, failed.length, reason, {
    // Counted apart, so the announcement can tell a refusal from a download
    // that may be running — see reportAddOutcome.
    uncertain:       failed.filter(f => f.unknown).length,
    // Whether the reason says more than "uncertain" does. A refused sign-in
    // during the lookup is the case: nothing was turned down outright, so the
    // reason had nothing to travel with and was dropped.
    namedReason:     !!lookupRefused,
    blockConnection,
    permissionMissing: lookupRefused?.permissionMissing === true || first?.permissionMissing === true,
    // The announcement says it short; the message handed back keeps the
    // browser's wording, because the popup has room to show all of it.
    certificateReason: lookupRefused
      ? lookupRefused.certificateError === true
      : first?.certificateError === true && !first.unknown,
    permissionReason: lookupRefused
      ? lookupRefused.permissionMissing === true : first?.permissionMissing === true,
    failedUrls:      failed.map(f => f.item),
    deliveryUnknown: failed.some(f => f.unknown),
    // A sign-in problem is reported even with notifications switched off.
    configError:     blockConnection || isConfigError(lookupRefused?.code)
      || failed.some(f => f.authFailed || f.permissionMissing || isConfigError(f.code)),
  }, epoch);
}

/**
 * How long to keep asking after an unanswered create, and how long to leave
 * between asks.
 *
 * The NAS does not list a task the moment it accepts it: the create we stopped
 * listening to may still be working its way through Download Station. Asking
 * once, straight away, therefore answers "not there" for a download that turns
 * up two seconds later — and that answer is the one that puts the link back in
 * front of the user to be sent a second time.
 *
 * Only spent when the outcome is genuinely open, and left as soon as every link
 * is accounted for.
 */
const CONFIRM_BUDGET_MS = 15000;
const CONFIRM_GAP_MS = 3000;

/**
 * How an add is recognised in the task list: by the URI it was created from,
 * which is the exact string that was sent.
 */
const LINK_MATCH = {
  key: item => String(item).trim(),
  taskKeys: task => [task.additional?.detail?.uri?.trim()],
};

/**
 * Ask the NAS which of these it ended up with.
 *
 * A create that ran into our own deadline leaves the outcome open: the NAS may
 * have processed the request after we stopped listening. Reporting that and
 * keeping the links invited the very second press that adds everything twice.
 *
 * So rather than leave it open, look. Every task carries the URI it was created
 * from — the same string that was sent — so a link found there is on the NAS,
 * however the create ended.
 *
 * A link that was on the NAS before this add is found too. For the question
 * being asked that is still the right answer: it is there, sending it again
 * would only duplicate it.
 */
async function onNas(wanted, epoch, taskKeys) {
  const looking = new Set(wanted);
  const found = new Set();
  // Whether the NAS had the *last* word, and that word was a task list. Only
  // that settles anything: Download Station lists a create a moment after
  // taking it, so an empty list early in the budget proves nothing, and an
  // answer from the middle of it is no answer at all once the asks after it
  // went nowhere. Recorded afresh each time round rather than once and for all.
  let answered = false;
  // What turned the lookup away: an API refusal, a refused sign-in or a refused
  // certificate. Repeating the lookup cannot resolve any of these.
  let refusal = null;
  const deadline = Date.now() + CONFIRM_BUDGET_MS;

  for (;;) {
    try {
      // The budget is the request's too — see apiFetch. Checked only out here,
      // one unanswered ask could spend a minute of retries inside a lookup
      // that had fifteen seconds, and block the add for all of it.
      const result = await apiListTasks(epoch, { deadline });
      answered = result.success === true;
      if (result.success === false) {
        // withSession already tried a fresh login where that could help. An
        // API refusal after it is an answer about the lookup, not the create.
        const code = result.error?.code ?? 'unknown';
        const refusal = Object.assign(new Error(await describeTaskError(code)), { code });
        return { found, answered, refusal };
      }
      for (const task of (result.success ? result.data?.tasks ?? [] : [])) {
        for (const key of taskKeys(task)) {
          if (key && looking.has(key)) found.add(key);
        }
      }
    } catch (err) {
      answered = false;
      // A different NAS is configured now; this add was never about that one.
      if (err?.connectionChanged) return { found, answered, refusal };
      // A NAS that turned the sign-in down turns the next one down the same
      // way. Asking again only repeats a rejected password — or spends another
      // of the account's attempts on a wrong code — and buries the one thing
      // the user can act on behind "not reachable".
      //
      // A refused certificate is the same kind of wall, and was not treated as
      // one: the lookup kept asking for the whole budget and then reported the
      // NAS as unreachable, throwing away the browser's own explanation. What
      // the create did stays unknown either way — that is the caller's to keep.
      if (err?.authFailed || err?.certificateError || err?.permissionMissing) {
        return { found, answered, refusal: err };
      }
      // Not answering this time. There may still be room for another ask.
    }
    if (found.size === looking.size || Date.now() + CONFIRM_GAP_MS >= deadline) {
      return { found, answered, refusal };
    }
    await sleep(CONFIRM_GAP_MS);
  }
}

/**
 * Say what became of every link whose create went unanswered.
 *
 * Three outcomes, and the difference is what the user acts on. The NAS lists
 * the link: it arrived, and it moves over to the added ones. The NAS answers
 * and does not list it: it did not arrive, which is a plain failure and may be
 * tried again. The NAS says nothing at all: nothing can be established, the
 * entry keeps its "delivery unknown" mark, and the popup says as much.
 */
async function settleUncertain(added, failed, epoch, match) {
  const uncertain = failed.filter(entry => entry.unknown);
  if (uncertain.length === 0) return null;

  const { found, answered, refusal } = await onNas(
    uncertain.map(entry => match.key(entry.item)), epoch, match.taskKeys);

  for (let i = failed.length - 1; i >= 0; i--) {
    const entry = failed[i];
    if (!entry.unknown) continue;
    if (found.has(match.key(entry.item))) {
      added.push(entry.item);
      failed.splice(i, 1);
      continue;
    }
    // Only a NAS that had the last word has really been asked. Short of that
    // the question stays open and the entry keeps its mark: an open outcome
    // reported as a plain failure is exactly what invited the second press
    // that put the same link on the NAS twice.
    if (!answered) continue;
    entry.unknown = false;
    entry.message = msg('addNotListed');
    entry.certificateError = false;
  }

  // Handed up so the reason can be named. The add's own outcome stays unknown:
  // the lookup not getting in says nothing about what the create did.
  return refusal;
}

/**
 * Why a link cannot be handed to the NAS at all, or null if it can.
 *
 * One check for every way in, because all four reach the same create call: the
 * popup's list, a right-click, a magnet picked up from a page, and a retry.
 * Only the list filtered, so the rest sent such a link through unchanged — and
 * the retry deleted the original task first, leaving nothing behind and nothing
 * to put back.
 *
 * The API separates links with commas, so one that contains a comma cannot be
 * told apart from two. Percent-encoding it would alter the address we were
 * given, so it is refused by name instead.
 */
function unsendableUri(uri) {
  return String(uri ?? '').includes(',') ? msg('linkHasComma') : null;
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
    // Carried back so the error text can name the folder this request used.
    // Reading the setting again once the answer arrives asks a different
    // question: it may have been changed, or emptied, in between.
    return { ...await readSentResponse(resp), destinationUsed: target };
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
    // Carried along with the refusal: the folder this create sent is the one the
    // error text has to name, whatever the setting says by the time it is read.
    refused = {
      code: result.error?.code ?? 'unknown', destinationUsed: result.destinationUsed,
    };
  } catch (err) {
    for (const item of batch) failed.push({
      item, unknown: err.deliveryUnknown === true, authFailed: err.authFailed,
      certificateError: err.certificateError === true,
      permissionMissing: err.permissionMissing === true,
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

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    try {
      const result = await apiAddTaskBatch([item], unzipPassword, epoch);
      if (result.success) added.push(item);
      else failed.push({ item, code: result.error?.code ?? 'unknown',
        destinationUsed: result.destinationUsed });
    } catch (err) {
      failed.push({ item, unknown: err.deliveryUnknown === true,
        authFailed: err.authFailed, certificateError: err.certificateError === true,
        permissionMissing: err.permissionMissing === true,
        message: err.message });
      // Same reason as the loop over batches: the next sign-in meets the same
      // password. Asking one link at a time turned one refusal into fifty.
      // A certificate that blocked preparation is just as final; no create
      // was sent, so the remaining links need neither a retry nor a lookup.
      if (err.authFailed || err.permissionMissing || (err.certificateError && err.deliveryUnknown !== true)) {
        for (const rest of batch.slice(i + 1)) {
          failed.push({ item: rest, authFailed: err.authFailed,
            certificateError: err.certificateError === true,
            permissionMissing: err.permissionMissing === true, message: err.message });
        }
        return;
      }
    }
  }
}

async function addDownloadTasksBulk(urls, unzipPassword, { announce = false, epoch, connection } = {}) {
  if (await connectionChangedSince(epoch, connection)) {
    return reportAddOutcome(0, urls.length, msg('addConnectionChanged'), {
      failedUrls: [...urls], connectionChanged: true, deliveryUnknown: false, configError: false,
    }, epoch);
  }
  if (!await requireSetup()) {
    return { success: false, setupRequired: true, error: { message: msg('setupRequired') } };
  }
  epoch ??= sessionEpoch;

  const added = [];
  const failed = [];
  // The API separates links with commas, so a link that contains one cannot be
  // told apart from two links: one address arrived as two nonsense downloads,
  // and a crafted link produced exactly the request two separate links would.
  // There is no way to send it unambiguously — percent-encoding the comma would
  // alter the address we were given — so it is turned down by name instead.
  const sendable = [];
  for (const url of urls) {
    const unsendable = unsendableUri(url);
    if (unsendable) failed.push({ item: url, message: unsendable });
    else sendable.push(url);
  }
  // Nothing left worth waking the NAS for.
  if (sendable.length === 0) return summariseAdd(added, failed, null, epoch);

  // Nothing has been sent yet, so a NAS that cannot be woken is a clean
  // failure: every link stays in the list and none of them was half-added.
  try {
    // A saved sign-in failure already prevents this add. A successful wake
    // would clear its connection panel without allowing the blocked login.
    checkSessionEpoch(epoch);
    if (signInBlocked()) throw blockedSignIn();
    await wakeNas({ announce, epoch });
  } catch (err) {
    return reportAddOutcome(0, urls.length,
      err.connectionChanged ? msg('addConnectionChanged') : err.message, {
      // The message handed back keeps the browser's wording for the popup; the
      // announcement takes the short form — see shortReason. Without this the
      // whole reason went into a notification again by this one route, and was
      // cut off there exactly as before.
      certificateReason: err.certificateError === true,
      permissionReason: err.permissionMissing === true,
      permissionMissing: err.permissionMissing === true,
      connectionChanged: err.connectionChanged === true,
      failedUrls: [...urls], deliveryUnknown: false,
      configError: err.authFailed === true || err.permissionMissing === true,
    }, epoch);
  }

  // Shared across every batch, so a long list cannot multiply the follow-up
  // calls batch by batch.
  const budget = { left: MAX_ITEMISED };

  const batches = chunk(sendable, MAX_URIS_PER_TASK_CALL);
  for (let i = 0; i < batches.length; i++) {
    await addBatchWithDetail(batches[i], unzipPassword, added, failed, budget, epoch);

    // A NAS that turns the sign-in down turns the next one down the same way.
    // Two hundred and fifty links meant six refused logins, each one another
    // attempt against an account DSM is entitled to lock. The rest are reported
    // without being sent — which is what they are.
    // The same applies when the certificate refused discovery or sign-in.
    const refused = failed.find(entry => entry.authFailed || entry.permissionMissing
      || (entry.certificateError && !entry.unknown));
    if (!refused) continue;
    for (const item of batches.slice(i + 1).flat()) {
      failed.push({ item, authFailed: refused.authFailed,
        certificateError: refused.certificateError === true,
        permissionMissing: refused.permissionMissing === true, message: refused.message });
    }
    break;
  }

  // Whatever went unanswered is settled against the task list — see onNas.
  const lookupRefused = await settleUncertain(added, failed, epoch, LINK_MATCH);

  return summariseAdd(added, failed, lookupRefused, epoch);
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
async function apiListTasks(epoch = sessionEpoch, { deadline } = {}) {
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
    const resp = await apiFetch(`${base}/${apis.taskPath}`, { method: 'POST', body }, { deadline });
    const json = await resp.json();
    // Whose ids these are, and how recent the list is. The popup sends the
    // first back with every action on them; the poll compares the second.
    return { ...json, connection: connectionKey(settings), listSeq };
  }, { epoch, deadline });
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

/**
 * Connection tests in the order they were started, and the newest one to have
 * answered — the same bookkeeping the task lists above keep.
 *
 * Two refused tests carry the same connection and the same count of accepted
 * sign-ins, so those stamps cannot tell them apart. Only the order can: a test
 * that says "code wrong" must not be overwritten by an older one answering
 * "code required" after it.
 */
let connectTestsStarted = 0;
let newestConnectTestAnswered = 0;

async function apiTestConnection(otpCode, expected = {}) {
  await stateReady;
  await settingsWriteQueue;
  const epoch = sessionEpoch;
  // Who this attempt is, before any snapshot read can be overtaken by another
  // test: its connection, accepted sign-ins and position among test requests.
  const attempt = { epoch, startedAt: signInsAccepted, seq: ++connectTestsStarted };
  const settings = await getSettings();
  const version = expected.connectionVersion === undefined ? undefined : await readConnectionVersion();
  // The requesting view may still display another NAS or an older password.
  // Reject its snapshot before discovery/login and leave current results alone.
  if (epoch !== sessionEpoch
      || (expected.connection !== undefined && expected.connection !== connectionKey(settings))
      || (expected.connectionVersion !== undefined && expected.connectionVersion !== version)
      || (expected.connectionSnapshot !== undefined
        && CONNECTION_KEYS.some(key => expected.connectionSnapshot?.[key] !== settings[key]))) {
    return { success: false, connectionChanged: true, outdated: true,
      error: { message: msg('connectionFailed') } };
  }
  try {
    checkSessionEpoch(epoch);
    const apis = await discoverApiPaths(settings.protocol, settings.host, settings.port);
    checkSessionEpoch(epoch);

    // An explicit code bypasses the shared-login cache: the user just typed
    // it, so this attempt must actually carry it.
    if (otpCode) {
      const result = await login(settings, otpCode, apis, { epoch });
      await acceptLogin(result, settings, apis, epoch);
    } else {
      // Reuse an existing login attempt, including one started by an add in a
      // popup that has since closed. Testing must not cancel that operation.
      await getSession(settings, apis, { force: true });
    }
    checkSessionEpoch(epoch);

    return rememberConnectOutcome({
      success: true,
      info: {
        authVersion: apis.authVersion,
        taskVersion: apis.taskVersion,
        authPath:    apis.authPath,
      },
    }, attempt);
  } catch (err) {
    return rememberConnectOutcome({
      success: false,
      connectionChanged: err.connectionChanged === true,
      otpRequired:    err.otpRequired === true,
      otpWrong:       err.otpWrong === true,
      nasUnreachable: err.nasUnreachable === true,
      // Carried so the announcement can be kept short — see shortReason. The
      // message itself stays as it is: the popup has room for all of it.
      certificateError: err.certificateError === true,
      permissionMissing: err.permissionMissing === true,
      error: { message: err.message },
    }, attempt);
  }
}

/**
 * The ground a sign-in attempt stood on, and whether it has moved since.
 *
 * Two things hold it up. The configured NAS must still be the one it was aimed
 * at. And for a refusal, no sign-in may have been accepted since it set off:
 * that answers the refusal for good — this deliberately does *not* also ask
 * whether that session is still open, the way outdatedAuthFailure does. That
 * function asks "should I try again now?", for which a session in hand matters;
 * this one asks "is this answer still true?", for which it does not. A session
 * ends on its own soon enough, and a refusal from before it does not become
 * true again when it does.
 *
 * A success is not asked the second half at all. acceptLogin raises
 * signInsAccepted during the very call whose answer this is, so a test that had
 * just succeeded declared itself overtaken — and the popup, told to ignore it,
 * left the code prompt standing over a session that was already signed in.
 */
function groundMoved({ epoch, startedAt } = {}, success = false) {
  if (epoch !== sessionEpoch) return true;
  return !success && signInsAccepted > startedAt;
}

/**
 * Whether a newer test has already had its say.
 *
 * Two refusals against the same connection carry identical stamps, so the order
 * they set off in is the only thing that separates them.
 *
 * `recorded` marks the one moment that changes the arithmetic: the point where
 * this attempt has itself been written down as the newest to answer. Before it,
 * an equal number can only be somebody else's; after it, that number is our own
 * and only a higher one belongs to a newer test.
 */
function laterTestAnswered({ seq } = {}, recorded = false) {
  if (seq === undefined) return false;
  return recorded ? seq < newestConnectTestAnswered : seq <= newestConnectTestAnswered;
}

/**
 * Whether an attempt's answer still says anything about the connection now.
 *
 * Asked again after every await that stores the result. Each of those is a
 * window in its own right: the connection can change in it, a sign-in can be
 * accepted, a newer test can answer. Skipping the second look handed an
 * overtaken success back as the current state, and announced a refusal that a
 * newer one had already replaced.
 */
function outdatedAttempt(attempt = {}, { success = false, recorded = false } = {}) {
  return groundMoved(attempt, success) || laterTestAnswered(attempt, recorded);
}

/**
 * Keep what became of a sign-in, so a popup that closed before the answer came
 * back can still say what happened.
 *
 * The answer used to travel only through sendResponse. Close the popup while a
 * sign-in is in flight and it went nowhere: the next open found no session,
 * started another attempt, and said nothing about the one that had just been
 * refused. With a wrong password that quietly spent one more of DSM's attempts
 * on every open, and DSM locks an account out on enough of them.
 *
 * Only TEST_CONNECTION arrives here and only the popup sends it, so this is
 * always an attempt someone asked for — never a background re-login.
 *
 * A connection that changed underneath is not kept. The details it failed
 * against are gone, and the reason would be read against the new ones.
 */
function rememberConnectOutcome(outcome, attempt) {
  // Serialize the outcome and its revision with logins and settings changes.
  // A permission response shares the grant listener's queue too, so a restored
  // grant cannot be followed by this older refusal becoming a permanent block.
  return queueSettingsWrite(async () => {
    if (outcome.permissionMissing) {
      const settings = await getSettings();
      if (await hasCurrentPermissions(hostPermissionForUrl(
        buildConnectionUrl(settings.protocol, settings.host, settings.port)))) {
        return { ...outcome, outdated: true };
      }
    }
    return recordConnectOutcome(outcome, attempt);
  });
}

async function recordConnectOutcome(outcome, attempt) {
  // An answer from an attempt that has been overtaken says nothing about the
  // connection configured now. It is not stored and not announced — and it does
  // not clear what a newer attempt has already left here. A stale refusal used
  // to be reported against the NAS that replaced its target, and a stale
  // "connection changed" used to wipe a fresh refusal on its way past.
  // Marked for whoever asked, too. Returning it unchanged left the popup that
  // was waiting to act on it: a refusal from before a sign-out still put the
  // code prompt back up, over an account name that had just been emptied.
  // A success is measured against the ground alone, never against the sign-in
  // it made itself — see groundMoved. The order still counts for both: a
  // success that a newer test has already overtaken describes a state that has
  // been asked about again since, and used to be handed back as the current one.
  const { success } = outcome;
  if (outdatedAttempt(attempt, { success })) return { ...outcome, outdated: true };
  // Unlike connectionVersion, this also advances for refusals. A success can
  // already be on its way to one view when another view's newer test fails.
  // Persisted rather than starting over when Firefox restarts the event page.
  const { connectionTestRevision } = await browser.storage.session.get({ connectionTestRevision: 0 });
  if (outdatedAttempt(attempt, { success })) return { ...outcome, outdated: true };
  const testRevision = connectionTestRevision + 1;
  const recordedOutcome = { ...outcome, testRevision };
  if (attempt?.seq !== undefined) newestConnectTestAnswered = attempt.seq;
  // Every look from here on is the second kind: this attempt is now itself the
  // newest to have answered, so only a higher number is somebody else.
  const settled = { success, recorded: true };

  if (outcome.success || outcome.connectionChanged) {
    cachedConnectFailure = null;
    await browser.storage.session.remove('lastConnect');
    // That await is a window too, and this branch had no second look at all: a
    // success overtaken while it was clearing the record was reported as the
    // connection's current state.
    if (outdatedAttempt(attempt, settled)) return { ...outcome, outdated: true };
    await browser.storage.session.set({ connectionTestRevision: testRevision });
    if (outdatedAttempt(attempt, settled)) return { ...outcome, outdated: true };
    return recordedOutcome;
  }
  cachedConnectFailure = { ...recordedOutcome, at: Date.now() };
  await browser.storage.session.set({ lastConnect: cachedConnectFailure, connectionTestRevision: testRevision });
  // Asked again, because that await is a window of its own: signing out during
  // it left the announcement to arrive about a connection nobody is using, and
  // a newer test answering during it made this the older of two refusals — it
  // was still announced, over the newer reason the popup had already been given.
  if (outdatedAttempt(attempt, settled)) return { ...outcome, outdated: true };
  // A refused sign-in stops every download, so it is never silenced — see
  // notify(). Being asked for a code is not a refusal: DSM asks that of a
  // correct password too, and the popup puts the prompt back up on its own.
  if (!outcome.otpRequired) {
    notifyAlways(msg('notifyError'), shortReason({ ...outcome, message: outcome.error?.message },
      msg('connectionFailed')));
  }
  return recordedOutcome;
}

// ---------------------------------------------------------------------------
// Download task helper
// ---------------------------------------------------------------------------

/**
 * How long to keep knocking before giving up on a sleeping NAS.
 *
 * A budget rather than a number of attempts, because that is the figure worth
 * reasoning about: it has to cover spinning up parked disks. Half a minute was
 * the first estimate and turned out to be cut close on a real NAS, so it is a
 * minute — long, but spent only on a box that is not answering, and the
 * alternative is reporting a failure for a download that would have worked.
 *
 * A sleeping NAS usually refuses the connection outright, so a probe costs
 * almost nothing and the time goes into the gaps between them. Short gaps mean
 * the add starts within a few seconds of the NAS becoming reachable, rather
 * than sitting idle until some longer interval happens to elapse.
 */
const WAKE_BUDGET_MS = 60000;
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
async function wakeNas({ announce = false, epoch = sessionEpoch } = {}) {
  checkSessionEpoch(epoch);
  const { protocol, host, port } = await getSettings();
  checkSessionEpoch(epoch);
  const url = `${buildBaseUrl(protocol, host, port)}/query.cgi` +
    '?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth';

  const deadline = Date.now() + WAKE_BUDGET_MS;
  let hadToWait = false;

  for (;;) {
    try {
      // holdBody: false — the answer's content is of no interest here, only
      // that one arrived, so nothing would ever read it and release the hold.
      await fetchOnce(url, {}, WAKE_PROBE_TIMEOUT_MS, { holdBody: false, epoch });
      checkSessionEpoch(epoch);
      break;
    } catch (err) {
      // A late refusal belongs to the old NAS too. Stop before classifying it
      // or waiting for another probe, while this add still owns the queue.
      checkSessionEpoch(epoch);
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
      checkSessionEpoch(epoch);
    }
  }

  if (hadToWait) await sleep(WAKE_SETTLE_MS);
  checkSessionEpoch(epoch);
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

/**
 * Resumes still waiting for an answer.
 *
 * A resume ends by starting the watch, and the watch runs on the session that
 * is signed in when it starts. A poll finishing while the resume was in flight
 * used to hand that session back — the popup was closed and nothing looked
 * active from where it stood — so the watch the answer started stopped at its
 * first tick for want of a session, and the badge and the "finished" notice
 * went with it. Adds are held out of that same door by addsPending.
 */
let resumesPending = 0;

function whileResuming(work) {
  resumesPending++;
  return work.finally(() => { resumesPending--; });
}

/**
 * Watch after a resume whose answer never came back.
 *
 * The NAS may well have acted on it, and the download would then be running
 * with nothing watching: no badge, and no word when it finishes. Watching a
 * task that turns out to be paused after all costs one poll, which ends the
 * watch again; not watching one that is running costs the user the very notice
 * they were waiting for.
 *
 * A refused initial sign-in never reached the task. A replacement sign-in may
 * follow an unanswered resume; that earlier attempt still needs a watch.
 */
function watchIfPerhapsResumed(err, epoch) {
  if (err?.connectionChanged || (err?.authFailed && !err?.deliveryUnknown)) return;
  if (err?.deliveryUnknown) startDownloadPolling(epoch);
}

/** Keep both resume follow-ups bound while replies and error descriptions wait. */
function resumeWithWatch(connection, run) {
  return whileResuming(taskActionEpoch(connection).then(async epoch => {
    try {
      const result = await run(epoch);
      if (mayBeRunning(result)) startDownloadPolling(epoch);
      return result;
    } catch (err) {
      watchIfPerhapsResumed(err, epoch);
      throw err;
    }
  }));
}
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
async function recordForPopup(result, connection, version = null) {
  // Nothing was attempted, and the popup finds an unconfigured connection on
  // its own — recording it would only produce a message about zero links.
  if (!result.setupRequired) {
    // Which NAS this outcome is about. The popup turns a refusal reported here
    // into a block on signing in again, and an outcome that arrives after the
    // user has switched NAS would otherwise block the new one — whose session
    // is perfectly good. The key the popup took before the add began, not the
    // connection configured by the time the answer turns up.
    //
    // The version beside it answers what the key cannot: it leaves the password
    // out on purpose, so a password corrected while the add was running left a
    // refusal that still looked current, and the popup shut the new sign-in out
    // over credentials nobody was using any more. Taken when the add was asked
    // for, for the same reason the key is.
    const values = { lastAdd: { ...result, connection, connectionVersion: version, at: Date.now() } };
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
// a suspended instance may claim. lastAdd and lastConnect deliberately survive:
// they are results waiting to be read, not claims about what is happening now.
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
  // Before anything else: a right-click and a magnet picked up from a page come
  // through here, and neither went past the list that used to do this check.
  const unsendable = unsendableUri(url);
  if (unsendable) {
    notify('failed', msg('notifyFailed'), unsendable);
    return { success: false, deliveryUnknown: false, error: { message: unsendable } };
  }
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
    // Keep the same pre-wake guard as the bulk path, including its diagnostic.
    checkSessionEpoch(epoch);
    if (signInBlocked()) throw blockedSignIn();
    await wakeNas({ announce, epoch });
  } catch (err) {
    if (err.connectionChanged) {
      notify('failed', msg('notifyFailed'), msg('addConnectionChanged'));
      return { success: false, connectionChanged: true, deliveryUnknown: false,
        error: { message: msg('addConnectionChanged') } };
    }
    if (err.authFailed || err.permissionMissing) notifyAlways(msg('notifyError'), shortReason(err));
    else notify('failed', msg('notifyError'), shortReason(err));
    return { success: false, deliveryUnknown: false,
      certificateError: err.certificateError === true,
      permissionMissing: err.permissionMissing === true, error: { message: err.message } };
  }

  try {
    const result = await apiAddTaskBatch([url], undefined, epoch);
    if (result.success) {
      notify('added', msg('extensionName'), msg('notifyAdded'));
      // Also refreshes the badge right away via its immediate first tick.
      startDownloadPolling(epoch);
    } else {
      const code = result.error?.code ?? 'unknown';
      const body = await describeTaskError(code, result.destinationUsed);
      // A broken destination breaks every download, so it is always reported.
      if (isConfigError(code)) notifyAlways(msg('notifyFailed'), body);
      else notify('failed', msg('notifyFailed'), body);
    }
    return result;
  } catch (err) {
    // A sign-in failure gets through either way — see notify() above.
    if (err.authFailed || (err.permissionMissing && !err.deliveryUnknown)) {
      notifyAlways(msg('notifyError'), shortReason(err));
    } else if (err.connectionChanged) {
      // Changed while the NAS was being woken; the create was never sent.
      notify('failed', msg('notifyFailed'), msg('addConnectionChanged'));
      return { success: false, connectionChanged: true, deliveryUnknown: false,
        error: { message: msg('addConnectionChanged') } };
    } else if (err.deliveryUnknown) {
      // Our own deadline ran out with the request already on its way. Ask the
      // NAS what became of it: leaving it to the user is what got the same
      // download queued twice, once by right-click and once by hand.
      const { found, answered, refusal } = await onNas([LINK_MATCH.key(url)], epoch, LINK_MATCH.taskKeys);
      if (found.size > 0) {
        notify('added', msg('extensionName'), msg('notifyAdded'));
        startDownloadPolling(epoch);
        return { success: true, deliveryUnknown: false };
      }
      // The lookup could not get in. That reason is worth more to the user
      // than "not reachable", and what became of the create stays open.
      if (refusal) {
        // A page click has no popup displaying deliveryUnknown. Keep that
        // uncertainty in the title, visible even when the reason is cut off.
        const title = msg('notifyAddUnconfirmed');
        if (refusal.authFailed || refusal.certificateError || refusal.permissionMissing || isConfigError(refusal.code)) {
          notifyAlways(title, shortReason(refusal));
        } else {
          notify('failed', title, shortReason(refusal));
        }
        return { success: false, deliveryUnknown: true,
          certificateError: refusal.certificateError === true,
          permissionMissing: refusal.permissionMissing === true,
          error: { code: refusal.code, message: refusal.message } };
      }
      // Same three outcomes as the bulk path — see settleUncertain. Only the
      // answering NAS has refused the download; without an answer the question
      // stays open, and the mark travels with it.
      const body = msg(answered ? 'addNotListed' : 'addNasUnreachable');
      notify('failed', answered ? msg('notifyFailed') : msg('notifyError'), body);
      return { success: false, deliveryUnknown: !answered, error: { message: body } };
    } else {
      notify('failed', msg('notifyError'), shortReason(err));
    }
    return {
      success: false,
      deliveryUnknown: err.deliveryUnknown === true,
      certificateError: err.certificateError === true,
      permissionMissing: err.permissionMissing === true,
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
  // The session this tick is about, held on to for the answer. A newer one can
  // be established while the list below is away — see the refusal branch.
  const sid = cachedSid;
  if (!sid) return; // No active session — nothing to keep alive
  // Only this session's own calls count — see sessionUsed.
  if (sessionUsed.sid === sid
      && Date.now() - sessionUsed.at < KEEPALIVE_PERIOD_MINUTES * 60 * 1000) return;

  try {
    const result = await apiListTasks();
    if (result.success) {
      // Same order check the poll makes, and for the same reason: a keepalive
      // list is slow and infrequent, so a newer one — the popup's, typically —
      // regularly answers first. Taken unconditionally, this stale and empty
      // list wiped a badge that was correctly showing two running downloads.
      if (newestListAnswered > result.listSeq) return;
      updateBadge(result.data?.tasks ?? []);
    } else if (SESSION_ERROR_CODES.has(result.error?.code)) {
      // Only the session that was actually refused, the same question
      // withSession asks before it clears one. A "Test connection" that went
      // through while this tick was away leaves a working session in the cache,
      // and taking this answer for it reported the NAS as disconnected over a
      // session nobody was using any more. A session the NAS really has
      // forgotten is cleared by the next call that runs into it.
      if (cachedSid === sid) clearSession();
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
function startDownloadPolling(epoch) {
  // A confirmed create stays successful after a NAS switch, but its follow-up
  // belongs to the old connection. Leave the new watch and session untouched.
  if (epoch !== sessionEpoch) return;
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
 * True while any popup or extension tab is open. Each view owns a port so
 * closing one cannot log out another view that is still refreshing.
 */
let popupOpen = false;
const popupPorts = new Set();

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  popupOpen = true;
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    popupOpen = popupPorts.size > 0;
  });
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

  // The heading used to say "all downloads finished" over a tally that could
  // read "0 completed · 1 failed".
  const title = failed === 0 && paused === 0 ? msg('notifyAllDone')
    : failed === 0 ? msg('notifyWatchResult')
    : done > 0 ? msg('notifyPartial')
    : msg('notifyFailed');

  notify('finished', title, parts.join(' · '));
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
  const epoch = sessionEpoch;
  // No session normally means the watch is over: signed out, switched NAS, or
  // handed back after the last download. Not after a failed poll. A session the
  // NAS turned down is dropped before signing in again, and when that sign-in
  // got no answer either, stopping here at the next tick skipped the failure
  // limit — one unanswered login ended the watch. The ticks after a failure
  // sign in again instead, until the limit ends it.
  //
  // Nor while tasks are still being watched. Every end of a watch empties that
  // set itself — the closing tally, the failure limit, a refused sign-in, a
  // connection change — so anything left in it means the watch is still on and
  // the missing session is an accident. The keepalive makes exactly that gap:
  // it drops a session the NAS has forgotten and signs in again only when
  // something next needs one. A tick landing in between ended the watch, and
  // the downloads it was following finished without their notification.
  if (!cachedSid && pollFailures === 0 && watchedIds.size === 0) {
    browser.alarms.clear(POLL_ALARM);
    return;
  }

  try {
    const result = await apiListTasks(epoch);
    // The old watch ended when its connection changed. Neither its successes
    // nor its failures may change the watch or failure count of the new NAS.
    if (epoch !== sessionEpoch) return;
    // On the same connection a failure still counts even if an add intervened.
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
    const outdated = () => epoch !== sessionEpoch || pollAgain || newestListAnswered > result.listSeq;
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
      // Noted before the settings are read: the NAS can be changed and signed
      // into while that await is out, and the session this watch meant to hand
      // back is then long gone.
      const signIns = signInsAccepted;
      const { keepaliveEnabled } = await getSettings();
      if (!keepaliveEnabled && !popupOpen && !outdated()
          && addsPending === 0 && resumesPending === 0) await apiLogout({ epoch, signIns });
    }
  } catch (err) {
    // A connection change has ended this watch already. A refused sign-in ends
    // it too: a minute later it meets the same password, and DSM blocks an
    // address after enough failed logins. Anything else is a NAS that did not
    // answer — try again next tick, but not indefinitely.
    if (epoch !== sessionEpoch || err?.connectionChanged) return;
    // Refused by a sign-in a later one has already overtaken. There is a
    // session again, so ending the watch here would throw away the tasks being
    // followed over a NAS that is answering perfectly well. Ask again with the
    // session we have now — pollDownloads queues it behind this one.
    if (outdatedAuthFailure(err)) { pollDownloads({ fresh: true }); return; }
    // Turned away before anything went out: a kept failure is blocking new
    // sign-ins. That is a state the user lifts from the popup, not the NAS
    // refusing us — and the reason kept need not be a refusal at all, since an
    // unreachable NAS is kept the same way. Ending the watch here threw away
    // downloads that were still running, and they finished with no notification
    // and no badge. The alarm stays: while the block holds, a tick costs nothing
    // because it never reaches the network.
    if (err?.connectBlocked || err?.permissionMissing) return;
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
  // Before the click, Firefox withholds linkUrl/selectionText without access
  // to the source page. Context types remain available even without that
  // permission. Validate a withheld selection when the user clicks instead.
  const contexts = info.contexts ?? [];
  const visible = contexts.includes('link') || !!info.linkUrl
    || (info.selectionText === undefined
      ? contexts.includes('selection')
      : extractUris(info.selectionText).length > 0);
  browser.contextMenus.update('download-station-add', { visible });
  browser.contextMenus.refresh();
});

/** A queued add's permission refusal is useful only for the current connection. */
async function contextMenuNeedsNasAccess(epoch) {
  for (;;) {
    if (await connectionChangedSince(epoch)) return false;
    const generation = permissionGeneration;
    const settings = await getSettings();
    const granted = await hasCurrentPermissions(hostPermissionForUrl(
      buildConnectionUrl(settings.protocol, settings.host, settings.port)));
    if (await connectionChangedSince(epoch)) return false;
    if (generation === permissionGeneration) return !granted;
  }
}

/** Bring an explicitly requested download's missing NAS access into view. */
async function offerNasAccessFromContextMenu(result, epoch, windowId) {
  // A kept sign-in failure can stop the add before it reaches the permission
  // check. Inspect today's grant after any failure of this connection too.
  if (result?.success !== false || result.setupRequired || result.connectionChanged) return;
  try {
    if (!await contextMenuNeedsNasAccess(epoch)) return;
    const targetWindow = Number.isInteger(windowId) ? { windowId } : {};
    try {
      await browser.action.openPopup(targetWindow);
    } catch {
      // Firefox 142–148 requires a user gesture for openPopup. The awaits above
      // have consumed it, so use the same interface in an ordinary extension
      // tab. Its startup permission check opens Settings → Connection in both.
      if (!await contextMenuNeedsNasAccess(epoch)) return;
      await browser.tabs.create({
        url: browser.runtime.getURL('popup/popup.html'),
        active: true,
        ...targetWindow,
      });
    }
  } catch {
    // The add already reported the missing grant in a notification. Keep that
    // fallback if Firefox cannot open either surface (e.g. the window closed).
  }
}

// Queued, not refused: two right-clicks in a row are two different links, and
// the second must not be dropped because the first is still waiting for a NAS
// to wake up. `announce` because a right-click has no window to report into.
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'download-station-add') return;
  const uris = info.linkUrl ? [info.linkUrl] : extractUris(info.selectionText);
  if (uris.length === 0) return;
  return enqueueAdd(async epoch => {
    const result = uris.length === 1
      ? await addDownloadTask(uris[0], { announce: true, epoch })
      : await addDownloadTasksBulk(uris, undefined, { announce: true, epoch });
    await offerNasAccessFromContextMenu(result, epoch, tab?.windowId);
    return result;
  }).catch(err => {
    notify('failed', msg('notifyFailed'), err?.message ?? String(err));
  });
});

// ---------------------------------------------------------------------------
// Message handler (content.js + popup.js)
// ---------------------------------------------------------------------------

/**
 * Answer a message with the result of `promise`, turning a rejection into a
 * proper error response. Without this a thrown login error (bad credentials,
 * unreachable NAS) would leave sendResponse uncalled, and the popup would
 * report "Could not reach background" instead of the real reason.
 *
 * `uncertain` names the message that stands in for a transport failure, and it
 * differs by what was being attempted. It used to be "whether the download
 * arrived is unknown" for every action, so merely reading the task list could
 * announce a download that had never been sent. Reads and tests pass nothing
 * and keep the plain reason; pausing, resuming or deleting says the result is
 * unconfirmed; only adding talks about a download having arrived.
 *
 * A refused initial sign-in never reached the task API, so its own reason
 * stands. A replacement login after an unanswered task write cannot settle
 * that earlier write; both the uncertainty and the new refusal are retained.
 */
function respondWith(promise, sendResponse, uncertain) {
  promise
    .then(sendResponse)
    .catch((err) => sendResponse({
      success: false,
      // Lets the popup show a code field instead of a plain failure.
      otpRequired: err?.otpRequired === true,
      otpWrong:    err?.otpWrong === true,
      connectionChanged: err?.connectionChanged === true,
      connectBlocked: err?.connectBlocked === true,
      permissionMissing: err?.permissionMissing === true,
      deliveryUnknown: err?.deliveryUnknown === true,
      error: {
        // The uncertainty stands — but where the browser named a cause, that
        // cause is worth more than the uncertainty alone and is carried with
        // it. Pausing against a refused certificate used to reach the popup as
        // nothing but "the result is unconfirmed", with the one thing the user
        // could act on dropped on the way.
        message: uncertain && err?.deliveryUnknown && (!err?.authFailed || err?.sent)
          ? [msg(uncertain), causeOf(err)
            ?? (err?.sent && !err?.nasUnreachable && !err?.connectionChanged ? err.message : null)]
            .filter(Boolean).join(' ')
          : (err?.message ?? String(err)),
      },
    }));
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case ACTIONS.CONNECTION_DRAFT:
    case ACTIONS.DESTINATION_DRAFT: {
      const ownView = typeof _sender.url === 'string'
        && _sender.url.startsWith(browser.runtime.getURL(''));
      const destination = message.action === ACTIONS.DESTINATION_DRAFT;
      const valid = message.operation === 'read'
        || (message.operation === 'clear' && Number.isSafeInteger(message.revision) && message.revision >= 0)
        || (message.operation === 'write' && (destination ? typeof message.draft === 'string'
          : message.draft && CONNECTION_KEYS.every(key => typeof message.draft[key] === 'string')
            && Object.keys(message.draft).every(key => CONNECTION_KEYS.includes(key))));
      if (!ownView || !valid) {
        sendResponse({ ok: false, error: { message: msg('extensionError') } });
        return false;
      }
      respondWith(destination ? updateDestinationDraft(message) : updateConnectionDraft(message), sendResponse);
      return true;
    }

    case ACTIONS.QUEUE_MAGNET_PREFERENCE:
      // Only an extension view may submit this write. The webpage content
      // script gets a read-only capture query, never a preference setter.
      if (typeof _sender.url !== 'string' || !_sender.url.startsWith(browser.runtime.getURL(''))
          || typeof message.enabled !== 'boolean'
          || Object.keys(message).some(key => key !== 'action' && key !== 'enabled')) {
        sendResponse({ accepted: false, error: { message: msg('extensionError') } });
      } else {
        sendResponse(queueMagnetPreference(message.enabled));
      }
      return false;

    case ACTIONS.GET_MAGNET_CAPTURE_STATE:
      respondWith(getMagnetCaptureState(), sendResponse);
      return true;

    // Like the context menu: a click on a page, one link, no window of its own.
    case ACTIONS.MAGNET_CLICKED:
      respondWith(
        enqueueAdd(async epoch => {
          // A click may reach us before its tab receives a revocation notice,
          // or wait in this queue while capture is turned off. No notification
          // is needed for capture that is currently inactive.
          if (!(await getMagnetCaptureState()).enabled) {
            return { success: false, magnetCaptureDisabled: true };
          }
          return addDownloadTask(message.url, { announce: true, epoch });
        }),
        sendResponse, 'notifyUncertain',
      );
      return true;

    case ACTIONS.ADD_TASKS_BULK: {
      // Read now, with the connection this add is about still configured — not
      // when its outcome is written, by which time the password it was refused
      // over may already have been corrected. See readConnectionVersion.
      const version = readConnectionVersion();
      respondWith(
        exclusiveAdd(async epoch => recordForPopup(
          await addDownloadTasksBulk(message.urls, message.unzipPassword,
            { epoch, connection: message.connection }), message.connection, await version)),
        sendResponse, 'notifyUncertain',
      );
      return true;
    }

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
      respondWith(apiTestConnection(message.otpCode, message), sendResponse);
      return true;

    // Every action on listed tasks first checks that the list came from the
    // connection configured now — see taskActionEpoch.
    case ACTIONS.PAUSE_TASK:
      respondWith(taskActionEpoch(message.connection)
        .then(epoch => apiBulkTaskAction('pause', [message.id], epoch)),
        sendResponse, 'actionResultUnknown');
      return true;

    case ACTIONS.RESUME_TASK:
      respondWith(resumeWithWatch(message.connection,
        epoch => apiBulkTaskAction('resume', [message.id], epoch)),
        sendResponse, 'actionResultUnknown');
      return true;

    case ACTIONS.DELETE_TASK:
      respondWith(taskActionEpoch(message.connection)
        .then(epoch => apiBulkTaskAction('delete', [message.id], epoch)),
        sendResponse, 'actionResultUnknown');
      return true;

    case ACTIONS.RETRY_TASK:
      respondWith(
        taskActionEpoch(message.connection)
          .then(epoch => exclusiveAdd(() => apiRetryTask(message.id, message.uri, message.unzipPassword,
            { epoch, destination: message.destination }))
            .then((r) => {
              if (r.success) startDownloadPolling(epoch);
              return r;
            })),
        sendResponse, 'notifyUncertain',
      );
      return true;

    case ACTIONS.PAUSE_ALL:
      respondWith(
        bulkOverTasks('pause', t => canPauseTask(t.status), message.connection),
        sendResponse, 'actionResultUnknown',
      );
      return true;

    case ACTIONS.RESUME_ALL:
      respondWith(
        resumeWithWatch(message.connection,
          epoch => bulkOverTasks('resume', t => canResumeTask(t.status), message.connection, epoch)),
        sendResponse, 'actionResultUnknown',
      );
      return true;

    case ACTIONS.DELETE_ALL:
      respondWith(bulkOverTasks('delete', () => true, message.connection),
        sendResponse, 'actionResultUnknown');
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
        .then(r => ({ ...r, removed: r.affected ?? 0 })),
        sendResponse, 'actionResultUnknown');
      return true;

    case ACTIONS.GET_STATUS:
      // A cached NAS session cannot bypass a Firefox permission the user revoked.
      respondWith(getConnectionStatus(), sendResponse);
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
