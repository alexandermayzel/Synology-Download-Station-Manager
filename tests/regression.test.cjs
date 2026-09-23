/* Run with: node --test tests/regression.test.cjs
 *
 * Without a Node installation, VS Code's own runtime does the job:
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" tests\regression.test.cjs
 *
 * Values crossing back from the vm context carry that context's prototypes, so
 * deepEqual on them needs `plain()` — assert/strict compares prototypes too.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const scripts = { actions: read('actions.js'), background: read('background.js'),
  popup: read('popup/popup.js') };
const defaults = { protocol: 'https', host: 'old-nas.example', port: 5001,
  username: 'test-user', password: 'test-password', keepaliveEnabled: false };
const apis = { authPath: 'auth.cgi', authVersion: 7, taskPath: 'DownloadStation/task.cgi', taskVersion: 3 };
const response = data => ({ ok: true, status: 200, json: async () => data });
const success = () => response({ success: true });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const plain = value => JSON.parse(JSON.stringify(value));
/** Let pending work run until `ready()` holds. The harness has no real clock to wait on. */
const until = async (ready, turns = 1000) => {
  for (let turn = 0; !ready(); turn++) {
    if (turn === turns) throw new Error('condition never became true');
    await new Promise(resolve => setImmediate(resolve));
  }
};

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => [...listeners].map(fn => fn(...args)) };
}

/**
 * A match pattern as Firefox applies it — including what it cannot express.
 *
 * The host is compared against the hostname, so a pattern carrying a port
 * matches nothing at all (bug 1362809). That is not a shortcut here: it is the
 * trap itself, and a harness that waved filters through let a listener which
 * could never fire look perfectly healthy.
 */
function matchPattern(pattern, url) {
  const parts = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/]+)(\/.*)$/.exec(pattern);
  if (!parts) return false;
  let target;
  try { target = new URL(url); } catch { return false; }
  const [, scheme, host, path] = parts;
  if (scheme !== '*' && `${scheme}:` !== target.protocol) return false;
  if (host !== '*' && host !== target.hostname) return false;
  const escaped = path.split('*').map(bit => bit.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(target.pathname + target.search);
}

function makeBrowser({ local = {}, session = {} } = {}) {
  const changes = event();
  const data = { local: { ...defaults, ...local }, session: { sid: 'old-sid', apiPaths: apis, ...session } };
  const writes = [];
  const area = name => ({
    async get(keys = null) {
      const stored = data[name];
      if (keys === null) return structuredClone(stored);
      if (typeof keys === 'string') return structuredClone({ [keys]: stored[keys] });
      if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.filter(k => k in stored).map(k => [k, stored[k]])));
      return structuredClone({ ...keys, ...Object.fromEntries(Object.keys(keys).filter(k => k in stored).map(k => [k, stored[k]])) });
    },
    async set(values) {
      values = structuredClone(values);
      writes.push({ area: name, values });
      const delta = {};
      for (const [key, value] of Object.entries(values)) {
        if (JSON.stringify(data[name][key]) === JSON.stringify(value)) continue;
        delta[key] = { oldValue: data[name][key], newValue: value };
        data[name][key] = value;
      }
      if (Object.keys(delta).length) queueMicrotask(() => changes.emit(delta, name));
    },
    async remove(keys) {
      const delta = {};
      for (const key of [].concat(keys)) {
        if (!(key in data[name])) continue;
        delta[key] = { oldValue: data[name][key] };
        delete data[name][key];
      }
      if (Object.keys(delta).length) queueMicrotask(() => changes.emit(delta, name));
    },
    async clear() { await this.remove(Object.keys(data[name])); },
  });
  const alarmCalls = [], activeAlarms = new Set(), notifications = [], badges = [];
  // The filter each registration asks for is kept, and applied: what this
  // listener is allowed to see is the point of it, not an implementation
  // detail, and an event that the real filter would never deliver must not
  // reach the handler here either.
  const errorFilters = [], startFilters = [];
  const errorListeners = new Map(), startListeners = new Map();
  const deliver = (listeners, details) => [...listeners]
    .filter(([, filter]) => (filter?.urls ?? []).some(pattern => matchPattern(pattern, details.url)))
    .map(([fn]) => fn(details));
  const listening = (filters, listeners) => ({
    addListener: (fn, filter) => { filters.push(filter); listeners.set(fn, filter); },
    removeListener: fn => listeners.delete(fn),
    emit: details => deliver(listeners, details),
  });
  const webRequest = {
    onErrorOccurred: listening(errorFilters, errorListeners),
    // Nothing is read from this one but the requestId, which is what ties a
    // refusal to the request that met it. Filtered exactly like the other, so
    // a test cannot bind an id through a filter the real one would not deliver.
    onBeforeRequest: listening(startFilters, startListeners),
  };
  const runtime = { onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() };
  runtime.sendMessage = message => new Promise(resolve => runtime.onMessage.emit(message, {}, resolve));
  runtime.connect = port => { port.onDisconnect = event(); runtime.onConnect.emit(port); return port; };
  runtime.getURL = path => `moz-extension://test-extension/${path}`;
  const browser = {
    storage: { local: area('local'), session: area('session'), onChanged: changes }, runtime,
    i18n: { getMessage: (key, subs = []) => key + (subs.length ? ':' + subs.join('|') : ''), getUILanguage: () => 'en' },
    alarms: { onAlarm: event(),
      create: (name, options) => { activeAlarms.add(name); alarmCalls.push({ name, options, created: true }); },
      clear: async name => { activeAlarms.delete(name); alarmCalls.push({ name, created: false }); return true; },
      get: async name => (activeAlarms.has(name) ? { name } : undefined) },
    notifications: { create: async info => { notifications.push(info); return 'notification'; } },
    // What the badge was told, in order: a stale answer overwriting a newer
    // one is invisible unless the writes themselves are on record.
    action: { setBadgeText: info => badges.push(info?.text), setBadgeBackgroundColor() {},
      setBadgeTextColor() {}, async openPopup() {} },
    contextMenus: { onShown: event(), onClicked: event(), removeAll: fn => fn(), create() {}, update() {}, refresh() {} },
    webRequest,
  };
  return { browser, data, writes, alarmCalls, notifications, badges, errorFilters, startFilters, webRequest };
}

/**
 * Just enough document for a page to be mounted against: look an element up by
 * id, set a value, call the listener it registered.
 */
function domStub() {
  const nodes = new Map();
  const node = id => {
    const listeners = {}, classes = new Set();
    return { id, value: '', textContent: '', hidden: false, disabled: false, readOnly: false, checked: false,
      dataset: {}, style: {}, attributes: {}, open: false, listeners,
      classList: { add: x => classes.add(x), remove: x => classes.delete(x),
        toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } },
      addEventListener(type, fn) { listeners[type] = fn; },
      setAttribute(key, value) { this.attributes[key] = value; },
      // No tree is kept here — appendChild and replaceChildren are stubs — so
      // nothing is ever inside anything else. Reflexive and no more, rather
      // than a "yes" that would let a focus test pass without a focus.
      contains(el) { return el === this; },
      querySelectorAll: () => [], querySelector: () => node(''),
      replaceChildren() {}, appendChild() {}, append() {}, focus() {}, select() {},
      // Enough of a <template> for renderTasks to stamp out task cards.
      content: { firstElementChild: { cloneNode: () => node('') } },
    };
  };
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); },
    querySelectorAll: () => [], createElement: () => node(''), createDocumentFragment: () => node(''), documentElement: {} };
  return { nodes, document };
}

async function background(fetchImpl = success, storage = {}) {
  const h = makeBrowser(storage);
  const requests = [];
  let now = 100000;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ browser: h.browser, URL, URLSearchParams, FormData, Blob, Date: Clock,
    AbortSignal: { timeout: ms => ({ timeout: ms }) },
    setTimeout(fn, ms) { now += ms; queueMicrotask(fn); return 1; },
    async fetch(url, options = {}) {
      const body = options.body;
      requests.push({ url, body: body ? Object.fromEntries(body.entries()) : {},
        method: options.method ?? 'GET', redirect: options.redirect });
      return fetchImpl(url, options);
    },
  });
  vm.runInContext(scripts.actions + '\n' + scripts.background, context);
  const evaluate = code => vm.runInContext(code, context);
  await evaluate('stateReady');
  const api = evaluate('({ apiFetch, apiAddTaskBatch, addBatchWithDetail, apiBulkTaskAction, apiRetryTask, apiLogout, recordForPopup, readConnectionVersion, addDownloadTasksBulk })');
  // What the popup would have received with its task list, and sends back with every action on it.
  const connection = evaluate('connectionKey')(h.data.local);
  return { ...h, context, evaluate, api, requests, connection, send: message => h.browser.runtime.sendMessage(message) };
}

function popup(h = makeBrowser()) {
  const { nodes, document } = domStub();
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({ browser: h.browser, document, Date, URL,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
  });
  // Mount the actual event handlers and functions without automatic popup init.
  const source = scripts.popup.slice(0, scripts.popup.indexOf('(async function init() {'));
  vm.runInContext(scripts.actions + '\n' + source, context);
  const evaluate = code => vm.runInContext(code, context);
  const api = evaluate('({ setAddBusy, syncAddControls, loadAddBusy, consumeLastAdd, applyAddOutcome, loadDraft, sortTasks, calcProgress, updateTotalSpeed, commitSettings, addBulkLinks, syncConnectionProblem })');
  return { ...h, context, evaluate, api, nodes, document, timers };
}

test('create requests are sent once for network failures and retain an uncertain outcome', async () => {
  for (const error of [new TypeError('Connection reset after sending'), Object.assign(new Error(), { name: 'TimeoutError' })]) {
    const h = await background(async () => { throw error; });
    await assert.rejects(h.api.apiAddTaskBatch(['https://download.example/a']), e => e.deliveryUnknown === true);
    assert.equal(h.requests.length, 1);
  }
});

test('repeatable reads still retry temporary network failures', async () => {
  let attempts = 0;
  const h = await background(async () => { if (++attempts < 4) throw new TypeError(); return success(); });
  await h.api.apiFetch('https://old-nas.example/read', {});
  assert.equal(attempts, 4);
});

test('HTTP 503 after creating a task is not retried', async () => {
  const h = await background(async () => ({ ok: false, status: 503 }));
  await assert.rejects(h.api.apiAddTaskBatch(['https://download.example/a']), e => e.deliveryUnknown === true);
  assert.equal(h.requests.length, 1);
});

test('broken or timed-out JSON and invalid responses never trigger batch itemisation', async () => {
  for (const result of [
    { ok: true, json: async () => { throw new SyntaxError('Truncated JSON'); } },
    { ok: true, json: async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); } },
    response({ data: {} }),
  ]) {
    const h = await background(async () => result);
    const added = [], failed = [];
    await h.api.addBatchWithDetail(['https://download.example/a', 'https://download.example/b'], '', added, failed, { left: 50 });
    assert.equal(h.requests.length, 1);
    assert.equal(added.length, 0);
    assert.equal(failed.length, 2);
    assert.ok(failed.every(item => item.unknown));
  }
});

test('explicit bad-link refusal can be itemised, retaining only failed links', async () => {
  const h = await background(async (_, options) => response({ success: options.body.get('uri') === 'https://download.example/good', error: { code: 400 } }));
  const added = [], failed = [];
  await h.api.addBatchWithDetail(['https://download.example/good', 'https://download.example/bad'], '', added, failed, { left: 50 });
  assert.equal(h.requests.length, 3);
  assert.deepEqual(added, ['https://download.example/good']);
  assert.equal(failed[0].item, 'https://download.example/bad');
});

test('per-task failures are translated and only successful tasks count as affected', async () => {
  const h = await background(async () => response({ success: true, data: [{ id: 'a', error: 405 }, { id: 'b', error: 0 }] }));
  const result = await h.api.apiBulkTaskAction('pause', ['a', 'b']);
  assert.equal(result.success, false);
  assert.equal(result.affected, 1);
  assert.match(result.error.message, /a: .*errTask405/);
});

test('missing per-task responses are unconfirmed, not failures', async () => {
  const h = await background(async () => response({ success: true, data: [{ id: 'a', error: 0 }] }));
  const result = await h.api.apiBulkTaskAction('delete', ['a', 'b']);
  assert.equal(result.success, false);
  assert.equal(result.affected, 1);
  assert.deepEqual(plain(result.failed), []);
  assert.deepEqual(plain(result.unconfirmed), ['b']);
  assert.match(result.error.message, /taskActionUnconfirmed:1/);
});

test('a reply without any per-task results confirms nothing and blames nothing', async () => {
  const h = await background(async () => response({ success: true }));
  const result = await h.api.apiBulkTaskAction('pause', ['a', 'b']);
  assert.equal(result.success, false);
  assert.equal(result.affected, 0);
  assert.deepEqual(plain(result.failed), []);
  assert.deepEqual(plain(result.unconfirmed), ['a', 'b']);
});

test('one reply can carry all three outcomes, and unreadable entries are unconfirmed', async () => {
  const h = await background(async () => response({ success: true, data: [
    { id: 'a', error: 0 }, { id: 'b', error: 405 }, { id: 'c', error: null },
    null, { id: 'e', error: '0' },
  ] }));
  const result = await h.api.apiBulkTaskAction('delete', ['a', 'b', 'c', 'd', 'e']);
  assert.equal(result.success, false);
  assert.equal(result.affected, 2); // 'e' too: DSM sends numbers as strings
  assert.deepEqual(plain(result.failed).map(item => item.id), ['b']);
  assert.deepEqual(plain(result.unconfirmed), ['c', 'd']);
  assert.match(result.error.message, /b: .*errTask405/);
  assert.match(result.error.message, /taskActionUnconfirmed:2/);
});

test('a refused call blames the call, not the individual tasks', async () => {
  const h = await background(async (_, options) => options.body.get('method') === 'resume'
    ? response({ success: false, error: { code: 405 } }) : success());
  const result = await h.api.apiBulkTaskAction('resume', ['a', 'b']);
  assert.equal(result.success, false);
  assert.equal(result.affected, 0);
  assert.deepEqual(plain(result.unconfirmed), []);
  assert.match(result.error.message, /errTask405/);
});

test('retry does not create a replacement when deletion fails', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'delete'
    ? response({ success: true, data: [{ id: 'a', error: 405 }] }) : success());
  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '');
  assert.equal(result.success, false);
  assert.ok(!h.requests.some(request => request.body.method === 'create'));
});

test('retry does not create a replacement when the deletion is unconfirmed', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'delete'
    ? response({ success: true }) : success());
  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '');
  assert.equal(result.success, false);
  assert.ok(!h.requests.some(request => request.body.method === 'create'));
});

test('an unconfirmed deletion still puts the link back, with the folder it was in', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'delete'
    ? response({ success: true }) : success());
  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '',
    { destination: 'share/films' });
  // The task may be gone, and it held the only copy of this link.
  assert.equal(result.linkKept, true);
  assert.equal(h.data.session.bulkDraft, 'https://download.example/a');
  assert.match(result.error.message, /retryOriginalFolder/);
  assert.ok(!h.requests.some(request => request.body.method === 'create'));
  // And it says so. The wording for a refused replacement claims the task was
  // removed and adding it again failed — neither happened here, and on that
  // reading the obvious move is another Add beside a task that may still stand.
  assert.match(result.error.message, /^retryLinkKeptUnsent/);
});

test('a deletion that goes unanswered still puts the link back', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'delete') throw new TypeError('no answer');
    return success();
  });
  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '',
    { destination: 'share/films' });
  // The task may be gone, and nothing else holds this link.
  assert.equal(result.linkKept, true);
  assert.equal(h.data.session.bulkDraft, 'https://download.example/a');
  assert.match(result.error.message, /retryOriginalFolder/);
  assert.ok(!h.requests.some(request => request.body.method === 'create'));
});

test('a deletion answered with "task not found" rescues the link too', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'delete'
    // The task is gone — possibly taken by an earlier attempt whose answer was
    // lost, since apiFetch repeats a delete.
    ? response({ success: true, data: [{ id: 'a', error: 404 }] })
    : success());
  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '');
  assert.equal(result.linkKept, true);
  assert.equal(h.data.session.bulkDraft, 'https://download.example/a');
  assert.ok(!h.requests.some(request => request.body.method === 'create'));
});

test('a deletion the NAS refuses leaves the task standing, so the link is not put back', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'delete'
    ? response({ success: true, data: [{ id: 'a', error: 405 }] }) : success());
  await h.api.apiRetryTask('a', 'https://download.example/a', '');
  assert.equal(h.data.session.bulkDraft, undefined);
});

test('resuming one task restarts background polling only after success', async () => {
  for (const error of [0, 405]) {
    const h = await background(async (_, options) => options.body.get('method') === 'resume'
      ? response({ success: true, data: [{ id: 'a', error }] })
      : response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } }));
    await h.send({ action: 'resumeTask', id: 'a', connection: h.connection });
    assert.equal(h.alarmCalls.some(call => call.created && call.name === 'download-station-poll'), error === 0);
  }
});

test('an unconfirmed resume keeps watching, alone and in bulk', async () => {
  const listed = { success: true, data: { tasks: [{ id: 'a', status: 'paused' }] } };
  const nothingBack = async (_, options) => options.body.get('method') === 'resume'
    ? response({ success: true }) : response(listed);

  const one = await background(nothingBack);
  await one.send({ action: 'resumeTask', id: 'a', connection: one.connection });
  assert.ok(one.alarmCalls.some(call => call.created && call.name === 'download-station-poll'));

  const all = await background(nothingBack);
  const result = await all.send({ action: 'resumeAll', connection: all.connection });
  assert.equal(result.success, false);
  assert.deepEqual(plain(result.unconfirmed), ['a']);
  assert.ok(all.alarmCalls.some(call => call.created && call.name === 'download-station-poll'));
});

test('a resume still in flight keeps the poll from handing the session back', async () => {
  const answer = deferred();
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'resume') return answer.promise;
    // Nothing is running, so the poll would end the watch and sign out.
    if (method === 'list') return response({ success: true, data: { tasks: [{ id: 'a', status: 'paused' }] } });
    return success();
  });

  const resume = h.send({ action: 'resumeTask', id: 'a', connection: h.connection });
  await until(() => h.requests.some(request => request.body.method === 'resume'));
  await h.evaluate('pollDownloads()');
  // The watch the answer is about to start needs this session.
  assert.ok(!h.requests.some(request => request.body.method === 'logout'), JSON.stringify(h.requests));

  answer.resolve(response({ success: true, data: [{ id: 'a', error: 0 }] }));
  await resume;
  assert.ok(h.alarmCalls.some(call => call.created && call.name === 'download-station-poll'));
});

test('a resume whose answer never arrives still starts the watch', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'resume') throw new TypeError('no answer');
    return response({ success: true, data: { tasks: [{ id: 'a', status: 'paused' }] } });
  });
  await h.send({ action: 'resumeTask', id: 'a', connection: h.connection });
  // The NAS may well have acted on it, and a download running unwatched loses
  // both its badge and the word that it finished.
  assert.ok(h.alarmCalls.some(call => call.created && call.name === 'download-station-poll'));
});

/**
 * A sign-in the extension starts by itself, refused while a code typed by hand
 * succeeds. The refusal arrives last and is about a session nobody is using.
 *
 * The task list finds the cached session gone (119) and signs in again on its
 * own account; that login is the one left hanging.
 */
function overtakenSignIn() {
  const refusal = deferred();
  const counts = { logins: 0, lists: 0 };
  const fetchImpl = async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'login') {
      counts.logins++;
      return counts.logins === 1
        ? refusal.promise
        : response({ success: true, data: { sid: 'fresh-sid' } });
    }
    if (method === 'list') {
      return ++counts.lists === 1
        ? response({ success: false, error: { code: 119 } })
        : response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } });
    }
    return success();
  };
  // 403 is "a code is required" — the answer that used to undo everything.
  const refuse = () => refusal.resolve(response({ success: false, error: { code: 403 } }));
  return { fetchImpl, counts, refuse };
}

test('a poll whose sign-in was refused after a newer one succeeded keeps watching', async () => {
  const { fetchImpl, counts, refuse } = overtakenSignIn();
  const h = await background(fetchImpl);

  const polling = h.evaluate('pollDownloads()');
  await until(() => counts.logins === 1);
  await h.send({ action: 'testConnection', otpCode: '123456' });
  refuse();
  await polling;

  assert.equal(counts.logins, 2);
  // The watch was ended outright, and the tasks it followed thrown away.
  assert.ok(!h.alarmCalls.some(call => !call.created && call.name === 'download-station-poll'),
    JSON.stringify(h.alarmCalls));
  // It asked again with the session it now has.
  assert.ok(counts.lists >= 2, `lists: ${counts.lists}`);
});

test('an overtaken refusal does not ask the popup for a code it no longer needs', async () => {
  const { fetchImpl, counts, refuse } = overtakenSignIn();
  const h = await background(fetchImpl);

  const listing = h.send({ action: 'listTasks' });
  await until(() => counts.logins === 1);
  await h.send({ action: 'testConnection', otpCode: '123456' });
  refuse();

  const result = await listing;
  assert.equal(result.success, true);
  assert.ok(!result.otpRequired, JSON.stringify(result));
});

test('a resume whose answer breaks off mid-body still starts the watch', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'resume') {
      // Headers arrived, so the NAS received it; the body never finishes.
      return { ok: true, status: 200, json: async () => { throw new TypeError('aborted'); } };
    }
    return response({ success: true, data: { tasks: [{ id: 'a', status: 'paused' }] } });
  });
  await h.send({ action: 'resumeTask', id: 'a', connection: h.connection });
  assert.ok(h.alarmCalls.some(call => call.created && call.name === 'download-station-poll'));
});

test('partially successful resume-all starts polling and reports failures', async () => {
  const h = await background(async (_, options) => options.body.get('method') === 'resume'
    ? response({ success: true, data: [{ id: 'a', error: 0 }, { id: 'b', error: 405 }] })
    : response({ success: true, data: { tasks: [{ id: 'a', status: 'paused' }, { id: 'b', status: 'paused' }] } }));
  const result = await h.send({ action: 'resumeAll', connection: h.connection });
  assert.equal(result.success, false);
  assert.equal(result.affected, 1);
  assert.ok(h.alarmCalls.some(call => call.created && call.name === 'download-station-poll'));
});

test('clear-completed reports the number actually removed', async () => {
  const h = await background(async (_, options) => options.body.get('method') === 'delete'
    ? response({ success: true, data: [{ id: 'a', error: 0 }, { id: 'b', error: 405 }] })
    : response({ success: true, data: { tasks: [{ id: 'a', status: 'finished' }, { id: 'b', status: 'finished' }] } }));
  const result = await h.send({ action: 'clearCompleted', connection: h.connection });
  assert.equal(result.success, false);
  assert.equal(result.removed, 1);
});

test('changing NAS logs out the old endpoint and discards the old session and token', async () => {
  const h = await background(success, { local: { deviceToken: 'old-token' } });
  const result = await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  assert.equal(result.ok, true);
  assert.equal(h.requests[0].url, 'https://old-nas.example:5001/webapi/auth.cgi');
  assert.equal(h.requests[0].body._sid, 'old-sid');
  assert.equal(h.data.local.host, 'new-nas.example');
  assert.equal(h.data.local.deviceToken, undefined);
  assert.equal(h.data.session.sid, undefined);
});

test('option saves retain connection and device token', async () => {
  const h = await background(success, { local: { deviceToken: 'old-token' } });
  await h.send({ action: 'settingsUpdated', options: { host: 'wrong.example', deviceToken: 'wrong', notifyOnAdded: false } });
  assert.equal(h.data.local.host, 'old-nas.example');
  assert.equal(h.data.local.deviceToken, 'old-token');
  assert.equal(h.data.local.notifyOnAdded, false);
  assert.equal(h.data.session.sid, 'old-sid');
  assert.equal(h.requests.length, 0);
});

test('late OTP login cannot restore session or token after sign-out, reset or a NAS change', async () => {
  for (const change of [{ signOut: true }, { reset: true }, { connection: { ...defaults, host: 'new-nas.example' } }]) {
    const started = deferred(), pending = deferred();
    const h = await background(async (_, options) => {
      if (options.body?.get('method') === 'login') { started.resolve(); return pending.promise; }
      return success();
    });
    const login = h.send({ action: 'testConnection', otpCode: '123456' });
    await started.promise;
    await h.send({ action: 'settingsUpdated', ...change });
    pending.resolve(response({ success: true, data: { sid: 'late-sid', did: 'late-token' } }));
    const result = await login;
    assert.equal(result.success, false);
    assert.equal(result.connectionChanged, true);
    assert.equal(h.data.session.sid, undefined);
    assert.equal(h.data.local.deviceToken, undefined);
    assert.ok(h.requests.some(request => request.body.method === 'logout' && request.body._sid === 'late-sid'
      && request.url.startsWith('https://old-nas.example:5001/')));
  }
});

test('connection test shares a login already started by a download', async () => {
  const started = deferred(), pending = deferred();
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') { started.resolve(); return pending.promise; }
    return success();
  }, { session: { sid: null } });
  const add = h.api.apiAddTaskBatch(['https://download.example/a']);
  await started.promise;
  const connection = h.send({ action: 'testConnection' });
  pending.resolve(response({ success: true, data: { sid: 'new-sid' } }));
  assert.equal((await add).success, true);
  assert.equal((await connection).success, true);
  assert.equal(h.requests.filter(request => request.body.method === 'login').length, 1);
});

test('late logout completion cannot clear a newer session', async () => {
  const started = deferred(), pending = deferred();
  const h = await background(async () => { started.resolve(); return pending.promise; });
  const logout = h.api.apiLogout();
  await started.promise;
  h.evaluate("sessionEpoch++; cachedSid = 'new-sid';");
  await h.browser.storage.session.set({ sid: 'new-sid' });
  pending.resolve(success());
  await logout;
  assert.equal(h.data.session.sid, 'new-sid');
  assert.equal((await h.send({ action: 'getStatus' })).connected, true);
});

test('active add makes the link field read-only and disables both add and clear controls', () => {
  const h = popup();
  h.document.getElementById('bulkLinks').value = 'https://download.example/a';
  h.api.setAddBusy(true);
  assert.equal(h.nodes.get('bulkLinks').readOnly, true);
  assert.equal(h.nodes.get('bulkLinks').disabled, false);
  for (const id of ['btnAddBulk', 'btnClearList']) assert.equal(h.nodes.get(id).disabled, true);
  assert.equal(h.nodes.get('addBusyHint').hidden, false);
  assert.equal(h.nodes.get('bulkLinks').value, 'https://download.example/a');
  h.api.setAddBusy(false);
  assert.equal(h.nodes.get('bulkLinks').readOnly, false);
  assert.equal(h.nodes.get('btnClearList').disabled, false);
});

test('background commits draft and outcome together before a reopened popup unlocks', async () => {
  for (const success of [true, false]) {
    const h = await background();
    await h.browser.storage.session.set({ bulkDraft: 'https://download.example/a\nhttps://download.example/b' });
    await h.api.recordForPopup({ success, added: success ? 2 : 1,
      failedUrls: success ? [] : ['https://download.example/b'] });
    const committed = h.writes.find(write => write.values.lastAdd);
    assert.equal(committed.values.bulkDraft, success ? '' : 'https://download.example/b');
    // Expired result: show it without initiating a new popup refresh burst.
    h.data.session.lastAdd.at = 1;
    const p = popup(h);
    p.api.setAddBusy(true);
    await p.api.loadDraft();
    await p.api.loadAddBusy();
    assert.equal(p.nodes.get('bulkLinks').value, committed.values.bulkDraft);
    assert.equal(p.nodes.get('bulkLinks').readOnly, false);
    assert.equal(h.data.session.lastAdd, undefined);
  }
});

test('concurrent result consumers share one operation and keep controls locked until applied', async () => {
  const h = popup(makeBrowser({ session: { lastAdd: { success: true, added: 1, at: 1 }, bulkDraft: '' } }));
  const started = deferred(), pending = deferred();
  let applications = 0;
  h.context.applyResult = async () => { applications++; started.resolve(); await pending.promise; };
  h.evaluate('applyAddOutcome = applyResult;');
  h.api.setAddBusy(false);
  const first = h.api.consumeLastAdd(), second = h.api.consumeLastAdd();
  await started.promise;
  assert.equal(applications, 1);
  assert.equal(h.nodes.get('bulkLinks').readOnly, true);
  assert.ok(h.data.session.lastAdd);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(h.nodes.get('bulkLinks').readOnly, false);
  assert.equal(h.data.session.lastAdd, undefined);
});

test('a local file-read or message still pending keeps controls locked after the background unlocks', () => {
  const h = popup();
  h.evaluate('localAddsPending = 1;');
  h.api.setAddBusy(false);
  assert.equal(h.nodes.get('bulkLinks').readOnly, true);
  h.evaluate('localAddsPending = 0;');
  h.api.syncAddControls();
  assert.equal(h.nodes.get('bulkLinks').readOnly, false);
});

test('popup reopened during an add stays locked until the background result is displayed', async () => {
  const started = deferred(), pending = deferred();
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'create') { started.resolve(); return pending.promise; }
    if (options.body?.get('method') === 'list') return response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } });
    return success();
  });
  await h.browser.storage.session.set({ bulkDraft: 'https://download.example/a' });
  const add = h.send({ action: 'addTasksBulk', urls: ['https://download.example/a'] });
  await started.promise;
  const p = popup(h);
  p.evaluate('popupReady = true;');
  await p.api.loadDraft();
  await p.api.loadAddBusy();
  assert.equal(p.nodes.get('bulkLinks').readOnly, true);
  assert.equal(p.nodes.get('btnClearList').disabled, true);
  pending.resolve(success());
  await add;
  await p.api.loadAddBusy();
  assert.equal(p.nodes.get('bulkLinks').value, '');
  assert.equal(p.nodes.get('bulkLinks').readOnly, false);
  assert.equal(p.nodes.get('btnAddBulk').disabled, false);
  assert.equal(h.data.session.bulkDraft, '');
  assert.equal(h.data.session.lastAdd, undefined);
});

test('popup sends its final draft before adding, cancelling a pending draft timer', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'list'
    ? response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } }) : success());
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection }; popupReady = true;');
  p.api.setAddBusy(false);
  p.document.getElementById('bulkLinks').value = 'https://download.example/final';
  p.nodes.get('bulkLinks').listeners.input();
  // Written on the spot rather than after a delay the popup may not live long
  // enough to see out.
  await until(() => h.data.session.bulkDraft === 'https://download.example/final');
  assert.equal(p.timers.size, 0);
  await p.api.addBulkLinks();
  assert.ok(h.writes.some(write => write.values.bulkDraft === 'https://download.example/final'));
  assert.equal(h.data.session.bulkDraft, '');
  assert.equal(p.nodes.get('bulkLinks').readOnly, false);
  assert.equal(h.requests.filter(request => request.body.method === 'create').length, 1);
});

test('popup saves changed connection through the background before testing it', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') return response({ success: true, data: { sid: 'new-sid' } });
    if (options.body?.get('method') === 'list') return response({ success: true, data: { tasks: [] } });
    return success();
  });
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');
  for (const [id, value] of Object.entries({ protocol: 'https', host: 'new-nas.example', port: '5001', username: 'new-user', password: 'new-password' })) {
    p.document.getElementById(id).value = value;
  }
  await p.api.commitSettings({ commitConn: true });
  const logout = h.requests.find(request => request.body.method === 'logout');
  const login = h.requests.find(request => request.body.method === 'login');
  assert.ok(logout.url.startsWith('https://old-nas.example:5001/'));
  assert.ok(login.url.startsWith('https://new-nas.example:5001/'));
  // It carries the session id of the NAS being left, so it must not be talked
  // into travelling anywhere else either.
  assert.equal(logout.redirect, 'error');
  assert.equal(h.data.local.username, 'new-user');
  assert.equal(h.data.session.sid, 'new-sid');
});

test('changing connection between batches cannot send remaining links to the new NAS', async () => {
  const started = deferred(), pending = deferred();
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'create') { started.resolve(); return pending.promise; }
    if (options.body?.get('method') === 'list') return response({ success: true, data: { tasks: [] } });
    return success();
  });
  const urls = Array.from({ length: 51 }, (_, i) => `https://download.example/${i}`);
  const add = h.api.addDownloadTasksBulk(urls, '');
  await started.promise;
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  pending.resolve(success());
  const result = await add;
  assert.equal(result.added, 50);
  assert.equal(result.failed, 1);
  assert.equal(h.requests.filter(request => request.body.method === 'create').length, 1);
  assert.equal(result.failedUrls[0], urls[50]);
});

test('numeric strings sort numerically and invalid or zero sizes never display NaN', () => {
  const h = popup();
  h.evaluate("settings.sortBy = 'size'; settings.sortDir = 'asc';");
  assert.deepEqual(plain(h.api.sortTasks([{ size: '900' }, { size: '1000' }])).map(t => t.size), ['900', '1000']);
  h.evaluate("settings.sortBy = 'added';");
  assert.deepEqual(plain(h.api.sortTasks([{ additional: { detail: { create_time: '10' } } },
    { additional: { detail: { create_time: '9' } } }])).map(t => t.additional.detail.create_time), ['9', '10']);
  for (const size of ['0', 0, null, undefined, 'invalid', -1]) {
    assert.equal(h.api.calcProgress({ status: 'waiting', size, additional: { transfer: { size_downloaded: '0' } } }), 0);
  }
  assert.equal(h.api.calcProgress({ status: 'downloading', size: '1000', additional: { transfer: { size_downloaded: '500' } } }), 50);
  h.api.updateTotalSpeed([{ additional: { transfer: { speed_download: '1024' } } },
    { additional: { transfer: { speed_download: '1024' } } }]);
  assert.match(h.nodes.get('totalSpeed').textContent, /2\.0 KB\/s/);
});

test('the popup treats an unconfirmed outcome as a reason to keep watching', () => {
  const h = popup();
  const may = value => h.evaluate(`mayHaveTakenEffect(${JSON.stringify(value)})`);
  assert.equal(may({ success: false, unconfirmed: ['a'] }), true);
  assert.equal(may({ success: false, deliveryUnknown: true }), true); // a retry
  assert.equal(may({ success: false, unconfirmed: [], failed: [{ id: 'a' }] }), false);
  assert.equal(may(undefined), false);
});

/** A content script mounted on just enough page to click things on. */
async function page() {
  const sent = [];
  let onClick;
  class Element {
    constructor(anchor = null) { this.anchor = anchor; }
    closest() { return this.anchor; }
  }
  const context = vm.createContext({
    Element,
    document: { addEventListener: (type, fn) => { if (type === 'click') onClick = fn; } },
    browser: {
      storage: { local: { get: async () => ({ autoCaptureMagnets: true }) }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async message => { sent.push(message); } },
    },
  });
  vm.runInContext(read('content.js'), context);
  await new Promise(resolve => setImmediate(resolve));
  const click = ({ isTrusted = true, target = new Element(), path = null }) => {
    const e = { isTrusted, target, prevented: false,
      preventDefault() { this.prevented = true; }, stopPropagation() {} };
    if (path) e.composedPath = () => path;
    onClick(e);
    return e;
  };
  return { sent, click, Element };
}

test('magnet capture ignores clicks a page makes itself', async () => {
  const { sent, click, Element } = await page();
  const link = new Element({ href: 'magnet:?xt=urn:btih:abc', protocol: 'magnet:' });
  assert.equal(click({ isTrusted: false, target: link }).prevented, false);
  assert.equal(sent.length, 0);
  assert.equal(click({ target: link }).prevented, true);
  assert.equal(sent.length, 1);
});

test('a magnet link is recognised by its protocol and along the whole click path', async () => {
  const { sent, click, Element } = await page();

  // Inside an open shadow tree: closest() from the target never reaches it.
  const inShadow = new Element({ href: 'magnet:?xt=urn:btih:abc', protocol: 'magnet:' });
  assert.equal(click({ target: new Element(), path: [new Element(), inShadow] }).prevented, true);
  assert.equal(sent.length, 1);

  // "MAGNET:" is the same link; an attribute selector for "magnet:" is not.
  const shouted = new Element({ href: 'MAGNET:?xt=urn:btih:abc', getAttribute: () => 'MAGNET:?xt=urn:btih:abc' });
  assert.equal(click({ target: shouted }).prevented, true);
  assert.equal(sent.length, 2);

  // An ordinary link is still left to the page.
  const plainLink = new Element({ href: 'https://example.test/x', protocol: 'https:' });
  assert.equal(click({ target: plainLink }).prevented, false);
  assert.equal(sent.length, 2);
});

test('HTML and SVG magnet anchors send the same string that was recognised', async () => {
  const { sent, click, Element } = await page();
  const cases = [
    [{ href: 'magnet:?xt=urn:btih:lower', protocol: 'magnet:' }, 'magnet:?xt=urn:btih:lower'],
    [{ href: 'MAGNET:?xt=urn:btih:UPPER', protocol: 'magnet:' }, 'MAGNET:?xt=urn:btih:UPPER'],
    [{ href: { baseVal: 'magnet:?xt=urn:btih:old', animVal: 'magnet:?xt=urn:btih:current' },
      getAttribute: () => 'magnet:?xt=urn:btih:old' }, 'magnet:?xt=urn:btih:current'],
    [{ href: { baseVal: '  MAGNET:?xt=urn:btih:base  ' } }, 'MAGNET:?xt=urn:btih:base'],
    [{ getAttribute: () => ' magnet:?xt=urn:btih:attribute ' }, 'magnet:?xt=urn:btih:attribute'],
  ];
  for (const [anchor, expected] of cases) {
    assert.equal(click({ target: new Element(anchor) }).prevented, true);
    assert.equal(sent.at(-1).url, expected);
    assert.equal(typeof sent.at(-1).url, 'string');
    assert.deepEqual(Object.keys(sent.at(-1)).sort(), ['action', 'url']);
  }
  assert.equal(sent.length, cases.length);
});

test('SVG capture follows the current target and retains the trusted-click guard', async () => {
  const { sent, click, Element } = await page();
  const currentHttp = new Element({
    href: { baseVal: 'magnet:?xt=urn:btih:old', animVal: 'https://example.test/current' },
    getAttribute: () => 'magnet:?xt=urn:btih:old',
  });
  assert.equal(click({ target: currentHttp }).prevented, false);
  const magnet = new Element({ href: {
    baseVal: 'magnet:?xt=urn:btih:base', animVal: 'magnet:?xt=urn:btih:current',
  } });
  assert.equal(click({ isTrusted: false, target: magnet }).prevented, false);
  const unusable = new Element({ href: { baseVal: 42, animVal: {} } });
  assert.equal(click({ target: unusable }).prevented, false);
  assert.equal(sent.length, 0);
});

test('task actions only run against the connection their list came from', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'list'
    ? response({ success: true, data: { tasks: [{ id: 'a', status: 'finished' }] } })
    : response({ success: true, data: [{ id: 'a', error: 0 }] }));
  assert.equal((await h.send({ action: 'listTasks' })).connection, h.connection);
  const stale = h.connection;
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  h.requests.length = 0;
  const actions = [{ action: 'deleteTask', id: 'a' }, { action: 'pauseTask', id: 'a' },
    { action: 'resumeTask', id: 'a' }, { action: 'retryTask', id: 'a', uri: 'https://download.example/a' },
    { action: 'deleteAll' }, { action: 'clearCompleted' }];
  for (const message of actions) {
    for (const connection of [stale, undefined]) {
      const result = await h.send({ ...message, connection });
      assert.equal(result.success, false, message.action);
      assert.equal(result.connectionChanged, true, message.action);
    }
  }
  assert.equal(h.requests.length, 0);
});

test('a link queued behind a running add is not sent to a connection configured meanwhile', async () => {
  const started = deferred(), pending = deferred();
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'create') { started.resolve(); return pending.promise; }
    return success();
  });
  const first = h.evaluate("enqueueAdd(epoch => addDownloadTask('https://download.example/a', { epoch }))");
  const second = h.evaluate("enqueueAdd(epoch => addDownloadTask('https://download.example/b', { epoch }))");
  await started.promise;
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  pending.resolve(success());
  assert.equal((await first).success, true);
  assert.equal((await second).connectionChanged, true);
  assert.equal(h.requests.filter(request => request.body.method === 'create').length, 1);
});

test('overlapping settings saves keep each other\'s changes', async () => {
  const h = await background();
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');
  p.document.getElementById('defaultDestination').value = 'share/new';
  const first = p.api.commitSettings({ commitDest: true });
  p.document.getElementById('keepaliveEnabled').checked = true;
  const second = p.api.commitSettings();
  await Promise.all([first, second]);
  assert.equal(h.data.local.defaultDestination, 'share/new');
  assert.equal(h.data.local.keepaliveEnabled, true);
  assert.equal(p.evaluate('settings.defaultDestination'), 'share/new');
});

test('popup ignores a task list that arrives after the connection was replaced', async () => {
  const pending = deferred();
  let lists = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'list') return success();
    return ++lists === 1 ? response({ success: true, data: { tasks: [] } }) : pending.promise;
  });
  const p = popup(h);
  await p.evaluate('refreshTasks()');
  assert.equal(p.evaluate('tasksConnection'), h.connection);
  const late = p.evaluate('refreshTasks()');
  p.evaluate('forgetTasks()');
  assert.equal(p.evaluate('tasksConnection'), null);
  pending.resolve(response({ success: true, data: { tasks: [] } }));
  await late;
  assert.equal(p.evaluate('tasksConnection'), null);
});

test('an add during a running poll gets a fresh poll instead of the running one\'s verdict', async () => {
  const first = deferred();
  let lists = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'list') return success();
    return ++lists === 1 ? first.promise
      : response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } });
  });
  const running = h.evaluate('pollDownloads()');
  await until(() => lists === 1);
  h.evaluate('startDownloadPolling()');
  first.resolve(response({ success: true, data: { tasks: [] } }));
  await running;
  await until(() => lists === 2 && h.evaluate('pollRunning') === null);
  assert.ok(!h.alarmCalls.some(call => !call.created && call.name === 'download-station-poll'));
  assert.ok(!h.requests.some(request => request.body.method === 'logout'));
});

test('polls do not overlap, so a NAS that never answers still reaches the failure limit', async () => {
  const pending = [];
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'list') return success();
    const answer = deferred();
    pending.push(answer);
    return answer.promise;
  });
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 })");
  const cleared = () => h.alarmCalls.some(call => !call.created && call.name === 'download-station-poll');
  for (let tick = 0; tick < 5; tick++) {
    assert.equal(cleared(), false);
    const poll = h.evaluate('pollDownloads()');
    // The next alarm fires while this poll is still waiting for its answer.
    const overlapping = h.evaluate('pollDownloads()');
    await until(() => pending.length === tick + 1);
    pending[tick].resolve({ ok: false, status: 404 });
    await Promise.all([poll, overlapping]);
  }
  assert.equal(pending.length, 5);
  assert.equal(cleared(), true);
});

test('a newer task list from the popup outranks an older empty poll answer', async () => {
  const first = deferred();
  let lists = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'list') return success();
    return ++lists === 1 ? first.promise
      : response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } });
  });
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 })");
  const poll = h.evaluate('pollDownloads()');
  await until(() => lists === 1);
  assert.equal((await h.send({ action: 'listTasks' })).success, true);
  first.resolve(response({ success: true, data: { tasks: [] } }));
  await poll;
  assert.ok(!h.alarmCalls.some(call => !call.created && call.name === 'download-station-poll'));
  assert.ok(!h.requests.some(request => request.body.method === 'logout'));
});

test('a download started while a logout is on its way signs in afresh and keeps its session', async () => {
  const logoutSent = deferred(), logoutDone = deferred();
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'logout') { logoutSent.resolve(); return logoutDone.promise; }
    if (method === 'login') return response({ success: true, data: { sid: 'new-sid' } });
    return success();
  });
  const logout = h.api.apiLogout();
  await logoutSent.promise;
  assert.equal((await h.api.apiAddTaskBatch(['https://download.example/a'])).success, true);
  logoutDone.resolve(success());
  await logout;
  assert.equal(h.requests.find(request => request.body.method === 'create').body._sid, 'new-sid');
  assert.equal(h.evaluate('cachedSid'), 'new-sid');
  assert.equal(h.data.session.sid, 'new-sid');
});

test('"Delete all" closes on a connection change and only targets the list it was opened for', async () => {
  const h = makeBrowser();
  const seen = [];
  h.browser.runtime.onMessage.addListener((message, _, respond) => { seen.push(message); respond({ success: true }); });
  const p = popup(h);
  p.evaluate("tasksConnection = 'old-list'");
  p.nodes.get('btnDeleteAll').listeners.click();
  assert.equal(p.nodes.get('deleteAllConfirm').hidden, false);
  p.evaluate('forgetTasks()');
  assert.equal(p.nodes.get('deleteAllConfirm').hidden, true);

  p.evaluate("tasksConnection = 'old-list'");
  p.nodes.get('btnDeleteAll').listeners.click();
  p.evaluate("tasksConnection = 'new-list'");
  await p.nodes.get('btnDeleteAllYes').listeners.click();
  assert.equal(seen.find(message => message.action === 'deleteAll').connection, 'old-list');
});

test('a keepalive request without an answer keeps the session', async () => {
  const h = await background(async () => { throw new TypeError('offline'); });
  await h.evaluate('runKeepalive()');
  assert.equal(h.data.session.sid, 'old-sid');
  assert.equal(h.evaluate('cachedSid'), 'old-sid');
});

test('a task list with running downloads restarts a stopped watch, once', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'list'
    ? response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } }) : success());
  const armed = () => h.alarmCalls.filter(call => call.created && call.name === 'download-station-poll').length;
  await h.send({ action: 'listTasks' });
  assert.equal(armed(), 1);
  await h.send({ action: 'listTasks' });
  assert.equal(armed(), 1);
});

test('an unknown session id (119) is answered with a fresh login', async () => {
  let lists = 0;
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'login') return response({ success: true, data: { sid: 'new-sid' } });
    if (method === 'list') {
      return response(++lists === 1 ? { success: false, error: { code: 119 } } : { success: true, data: { tasks: [] } });
    }
    return success();
  });
  assert.equal((await h.send({ action: 'listTasks' })).success, true);
  assert.equal(h.data.session.sid, 'new-sid');
});

test('a retry whose new task is refused puts the link back and names the original folder', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'delete') return response({ success: true, data: [{ id: 'a', error: 0 }] });
    if (method === 'create') return response({ success: false, error: { code: 406 } });
    return success();
  }, { session: { bulkDraft: 'https://download.example/other' } });
  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '', { destination: 'share/original' });
  assert.equal(result.success, false);
  assert.equal(result.linkKept, true);
  assert.equal(h.requests.find(request => request.body.method === 'create').body.destination, 'share/original');
  assert.equal(h.data.session.bulkDraft, 'https://download.example/other\nhttps://download.example/a');
  assert.match(result.error.message, /retryLinkKept:.*errTask406/);
  assert.match(result.error.message, /retryOriginalFolder:share\/original/);
});

test('when the NAS cannot be woken, nothing is deleted and nothing is called uncertain', async () => {
  const offline = async url => {
    if (String(url).includes('query.cgi')) throw new TypeError('offline');
    return success();
  };
  const retry = await background(offline);
  const retried = await retry.api.apiRetryTask('a', 'https://download.example/a', '');
  assert.equal(retried.deliveryUnknown, false);
  assert.ok(!retry.requests.some(request => request.body.method));

  const single = await background(offline);
  const added = await single.evaluate("addDownloadTask('https://download.example/a')");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(added.deliveryUnknown, false);
  assert.ok(single.notifications.some(n => n.message === 'errNasUnreachable'));
  assert.ok(!single.notifications.some(n => n.message === 'notifyUncertain'));
  assert.ok(!single.requests.some(request => request.body.method));
});

test('popup takes over a link the background put back while the list was locked', async () => {
  const h = makeBrowser();
  const p = popup(h);
  p.api.setAddBusy(true);
  await h.browser.storage.session.set({ bulkDraft: 'https://download.example/a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.nodes.get('bulkLinks').value, 'https://download.example/a');
  p.api.setAddBusy(false);
  p.nodes.get('bulkLinks').value = 'typed';
  await h.browser.storage.session.set({ bulkDraft: 'an older echo' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.nodes.get('bulkLinks').value, 'typed');
});

test('a bulk refusal describes each error code once, not once per task', async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
  const h = await background(async () => response({ success: true, data: ids.map(id => ({ id, error: 403 })) }));
  const read = h.browser.storage.local.get;
  let reads = 0;
  h.browser.storage.local.get = function (...args) { reads++; return read.apply(this, args); };
  const result = await h.api.apiBulkTaskAction('resume', ids);
  assert.equal(result.failed.length, 100);
  assert.match(result.error.message, /t99: .*errTask403NoDest/);
  // One for the session's settings, one to phrase the 403 — not one per task.
  assert.ok(reads <= 2, `${reads} settings reads`);
});

test('saving an option that does not affect the task list leaves the cards alone', async () => {
  const h = await background();
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection }; applySettingsToForm();');
  // The harness has no real order list to read back.
  p.evaluate('readStatusOrder = () => [...settings.statusOrder];');
  p.context.renders = 0;
  p.evaluate('const drawTasks = renderTasks; renderTasks = (...args) => { renders++; return drawTasks(...args); };');
  p.document.getElementById('keepaliveEnabled').checked = true;
  await p.api.commitSettings();
  assert.equal(p.context.renders, 0);
  p.document.getElementById('sortDir').value = 'asc';
  await p.api.commitSettings();
  assert.equal(p.context.renders, 1);
});

test('paging through an unchanged list does not filter and sort it again', () => {
  const h = popup();
  h.context.sorts = 0;
  h.evaluate('const sortForReal = sortTasks; sortTasks = list => { sorts++; return sortForReal(list); };');
  h.context.list = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: 'downloading' }));
  h.evaluate('renderTasks(list)');
  assert.equal(h.context.sorts, 1);
  h.evaluate('currentPage = 2; renderTasks(); currentPage = 3; renderTasks();');
  assert.equal(h.context.sorts, 1);
  h.evaluate("setActiveFilter('finished', false); renderTasks();");
  assert.equal(h.context.sorts, 2);
  h.evaluate("setActiveFilter('all', false); settings.sortDir = 'asc'; renderTasks();");
  assert.equal(h.context.sorts, 3);
  h.evaluate('renderTasks([...list])');
  assert.equal(h.context.sorts, 4);
});

test('drafts left in local storage by older versions are cleared once, on update', async () => {
  const h = await background(success, { local: { connDraft: { password: 'typed' }, bulkDraft: 'https://download.example/a' } });
  h.browser.runtime.onInstalled.emit({ reason: 'update' });
  await until(() => h.data.local.connDraft === undefined);
  assert.equal(h.data.local.bulkDraft, undefined);
  assert.equal(h.data.local.host, 'old-nas.example');
});

test('a watch whose new sign-in got no answer keeps trying until the failure limit, across restarts', async () => {
  const signInFails = async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'list') return response({ success: false, error: { code: 119 } });
    if (method === 'login') throw new TypeError('offline');
    return success();
  };
  const armed = "browser.alarms.create('download-station-poll', { periodInMinutes: 1 })";
  const cleared = run => run.alarmCalls.some(call => !call.created && call.name === 'download-station-poll');
  const logins = run => run.requests.filter(request => request.body.method === 'login').length;

  const h = await background(signInFails);
  h.evaluate(armed);
  for (let tick = 1; tick <= 5; tick++) {
    assert.equal(cleared(h), false, `before tick ${tick}`);
    const before = logins(h);
    await h.evaluate('pollDownloads()');
    assert.ok(logins(h) > before, `tick ${tick} signs in again`);
    if (tick < 5) assert.equal(h.data.session.pollFailures, tick);
  }
  assert.equal(cleared(h), true);
  assert.equal(h.data.session.pollFailures, undefined);

  // An event page loaded afresh picks the count up where the unloaded one left it.
  const restarted = await background(signInFails, { session: { sid: null, pollFailures: 4 } });
  restarted.evaluate(armed);
  await restarted.evaluate('pollDownloads()');
  assert.ok(logins(restarted) > 0);
  assert.equal(cleared(restarted), true);
});

test('a refused sign-in ends the watch at once instead of trying the password again', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'list') return response({ success: false, error: { code: 119 } });
    if (method === 'login') return response({ success: false, error: { code: 400 } });
    return success();
  });
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 })");
  await h.evaluate('pollDownloads()');
  assert.ok(h.alarmCalls.some(call => !call.created && call.name === 'download-station-poll'));
  assert.equal(h.requests.filter(request => request.body.method === 'login').length, 1);
});

test('a refresh whose automatic sign-in wants a code asks for it and stops refreshing', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'login'
    ? response({ success: false, error: { code: 403 } }) : success(), { session: { sid: null } });
  const p = popup(h);
  p.nodes.get('otpField').hidden = true;
  p.evaluate("setStatus('connected', 'connected'); startAutoRefresh();");
  await p.evaluate('refreshTasks()');
  assert.equal(p.nodes.get('otpField').hidden, false);
  assert.equal(p.nodes.get('statusText').textContent, 'otpRequired');
  assert.equal(p.evaluate('refreshWanted'), false);
  assert.equal(p.evaluate('refreshFailures'), 0);
});

test('downloads seen running in any current list are counted when the watch ends', async () => {
  const first = deferred();
  let lists = 0;
  const tasks = (...entries) => response({ success: true, data: { tasks: entries.map(([id, status]) => ({ id, status })) } });
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'list') return success();
    lists++;
    if (lists === 1) return first.promise;
    if (lists === 2) return tasks(['a', 'downloading'], ['b', 'downloading'], ['c', 'finished']);
    return tasks(['a', 'finished'], ['b', 'finished'], ['c', 'finished']);
  });
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 }); rememberWatched([{ id: 'a', status: 'downloading' }]);");
  const poll = h.evaluate('pollDownloads()');
  await until(() => lists === 1);
  // The popup's newer list shows b, started meanwhile, and c already done.
  await h.send({ action: 'listTasks' });
  // That makes the poll's own answer out of date, but it saw c running.
  first.resolve(tasks(['a', 'downloading'], ['c', 'downloading']));
  await poll;
  await h.evaluate('pollDownloads()');
  await until(() => h.notifications.length > 0);
  assert.equal(h.notifications[0].message, 'notifyDoneCount:3');
});

test('saving the connection keeps an unsaved destination, and each draft goes with its own save', async () => {
  const h = await background();
  const open = saved => {
    const p = popup(h);
    p.context.savedConnection = saved;
    p.evaluate('settings = { ...settings, ...savedConnection }; applySettingsToForm();');
    // The harness has no real order list to read back.
    p.evaluate('readStatusOrder = () => [...settings.statusOrder];');
    return p;
  };
  const p = open(defaults);
  p.nodes.get('defaultDestination').value = 'share/unsaved';
  p.nodes.get('defaultDestination').listeners.input();
  // The mock keeps one listener per event, and the password field's last one is
  // the required-field check — so its draft is saved directly.
  p.nodes.get('password').value = 'typed-password';
  p.evaluate('saveConnDraft()');
  for (const fire of [...p.timers.values()]) fire();
  await until(() => h.data.session.connDraft && h.data.session.destDraft);
  await p.api.commitSettings({ commitConn: true });
  assert.equal(h.data.session.connDraft, undefined);
  assert.equal(h.data.session.destDraft, 'share/unsaved');

  const reopened = open({ ...defaults, password: 'typed-password' });
  await reopened.evaluate('loadConnDraft()');
  assert.equal(reopened.nodes.get('defaultDestination').value, 'share/unsaved');
  await reopened.api.commitSettings({ commitDest: true });
  assert.equal(h.data.session.destDraft, undefined);
  assert.equal(h.data.local.defaultDestination, 'share/unsaved');
});

test('a sign-in without an answer is a plain failure for every kind of add', async () => {
  const signInOffline = async (_, options) => {
    if (options.body?.get('method') === 'login') throw new TypeError('offline');
    return success();
  };
  const single = await background(signInOffline, { session: { sid: null } });
  const added = await single.evaluate("addDownloadTask('https://download.example/a')");
  await until(() => single.notifications.length > 0);
  assert.equal(added.deliveryUnknown, false);
  assert.equal(single.notifications[0].message, 'errNasUnreachable');

  const links = await background(signInOffline, { session: { sid: null } });
  const bulk = await links.api.addDownloadTasksBulk(['https://download.example/a'], '');
  assert.equal(bulk.deliveryUnknown, false);
  assert.equal(bulk.errorMessage, 'errNasUnreachable');

  for (const h of [single, links]) assert.ok(!h.requests.some(request => request.body.method === 'create'));
});

test('the keepalive skips its request while the session was used within its period', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'list'
    ? response({ success: true, data: { tasks: [] } }) : success());
  const lists = () => h.requests.filter(request => request.body.method === 'list').length;
  await h.send({ action: 'listTasks' });
  await h.evaluate('runKeepalive()');
  assert.equal(lists(), 1);
  // The harness clock only moves with timers.
  h.evaluate('setTimeout(() => {}, 3 * 60 * 1000)');
  await h.evaluate('runKeepalive()');
  assert.equal(lists(), 2);
});

test('while a two-factor code is due, not even the close watch after an add keeps signing in', async () => {
  const h = await background(async (_, options) => options.body?.get('method') === 'login'
    ? response({ success: false, error: { code: 403 } }) : success(), { session: { sid: null } });
  const p = popup(h);
  // Intervals that can be fired, unlike the harness's own.
  const intervals = new Map();
  let next = 0;
  p.context.setInterval = fn => { intervals.set(++next, fn); return next; };
  p.context.clearInterval = id => intervals.delete(id);
  p.nodes.get('otpField').hidden = true;
  p.evaluate("activateTab('tasks', { remember: false }); startBurstRefresh();");
  assert.equal(intervals.size, 1);
  await p.evaluate('refreshTasks()');
  assert.equal(p.nodes.get('otpField').hidden, false);
  // Back on Tasks within the half minute.
  p.evaluate("activateTab('tasks', { remember: false })");
  const logins = () => h.requests.filter(request => request.body.method === 'login').length;
  const before = logins();
  for (let tick = 0; tick < 2; tick++) for (const fire of [...intervals.values()]) await fire();
  assert.equal(intervals.size, 0);
  assert.equal(logins(), before);
  // Once a code has been accepted, the close watch carries on.
  p.evaluate('showOtpPrompt(false); startAutoRefresh();');
  assert.equal(intervals.size, 1);
});

test('the keepalive saving survives the event page being unloaded, for the same session only', async () => {
  const listed = async (_, options) => options.body?.get('method') === 'list'
    ? response({ success: true, data: { tasks: [] } }) : success();
  const lists = run => run.requests.filter(request => request.body.method === 'list').length;
  const first = await background(listed);
  await first.send({ action: 'listTasks' });
  await first.send({ action: 'listTasks' });
  const stored = first.data.session.sessionUsed;
  assert.equal(stored.sid, 'old-sid');
  // Written once: the second list came within the minute.
  assert.equal(first.writes.filter(write => write.values.sessionUsed).length, 1);

  const reloaded = await background(listed, { session: { sessionUsed: stored } });
  await reloaded.evaluate('runKeepalive()');
  assert.equal(lists(reloaded), 0);

  const newer = await background(listed, { session: { sid: 'newer-sid', sessionUsed: stored } });
  await newer.evaluate('runKeepalive()');
  assert.equal(lists(newer), 1);
});

test('a link the NAS took despite an unanswered create counts as added, not as failed', async () => {
  const link = 'https://download.example/a';
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('no answer');
    if (method === 'list') {
      return response({ success: true, data: { tasks: [
        { id: 'a', status: 'downloading', additional: { detail: { uri: link } } },
      ] } });
    }
    return success();
  });
  const result = await h.api.addDownloadTasksBulk([link], '');
  assert.equal(result.success, true);
  assert.equal(result.added, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.deliveryUnknown, false);
  assert.deepEqual(plain(result.failedUrls), []);
  // The one create was never repeated to find that out.
  assert.equal(h.requests.filter(request => request.body.method === 'create').length, 1);
});

test('a link the answering NAS does not list is a plain failure, not an open question', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('no answer');
    if (method === 'list') return response({ success: true, data: { tasks: [] } });
    return success();
  });
  const result = await h.api.addDownloadTasksBulk(['https://download.example/a'], '');
  assert.equal(result.success, false);
  assert.equal(result.deliveryUnknown, false);
  assert.deepEqual(plain(result.failedUrls), ['https://download.example/a']);
  assert.equal(result.errorMessage, 'addNotListed');
  assert.ok(h.notifications.some(n => n.message.includes('addNotListed')), JSON.stringify(h.notifications));
  assert.ok(!h.notifications.some(n => n.message.includes('errNasUnreachable')));
  // It did not settle for the first look.
  assert.ok(h.requests.filter(request => request.body.method === 'list').length > 1);
});

test('a NAS that says nothing at all leaves the outcome open, and says that', async () => {
  const h = await background(async (url, options) => {
    // The wake-up probe gets through; everything with a session behind it does not.
    if (String(url).includes('query.cgi')) return success();
    if (options.body?.get('method') === 'login') return response({ success: true, data: { sid: 'sid' } });
    throw new TypeError('no answer');
  });
  const started = h.evaluate('Date.now()');
  const result = await h.api.addDownloadTasksBulk(['https://download.example/a'], '');
  assert.equal(result.success, false);
  // Nothing was established, so the link stays uncertain rather than being
  // called a failure — which is what invited the second press.
  assert.equal(result.deliveryUnknown, true);
  assert.equal(result.errorMessage, 'notifyUncertain');
  assert.deepEqual(plain(result.failedUrls), ['https://download.example/a']);
  // And it kept to its budget instead of letting one request retry for a
  // minute inside it.
  assert.ok(h.evaluate('Date.now()') - started <= 15000, `took ${h.evaluate('Date.now()') - started}ms`);
});

test('a sign-in the NAS turns down stops the lookup instead of repeating it', async () => {
  let logins = 0;
  const h = await background(async (url, options) => {
    if (String(url).includes('query.cgi')) return success();
    const method = options.body?.get('method');
    if (method === 'login') { logins++; return response({ success: false, error: { code: 400 } }); }
    if (method === 'create') throw new TypeError('no answer');
    // The session is gone, so the lookup has to sign in — and is refused.
    if (method === 'list') return response({ success: false, error: { code: 119 } });
    return success();
  });
  const result = await h.api.addDownloadTasksBulk(['https://download.example/a'], '');
  assert.equal(logins, 1);
  assert.equal(result.deliveryUnknown, true);
  assert.deepEqual(plain(result.failedUrls), ['https://download.example/a']);
  // The reason the lookup could not get in is the one thing to act on; it used
  // to disappear behind "outcome uncertain", or behind nothing at all.
  assert.match(result.errorMessage, /errLoginFailed/);
  assert.equal(result.configError, true);
});

test('an answer from the middle of the budget does not settle the outcome', async () => {
  let lists = 0;
  const h = await background(async (url, options) => {
    if (String(url).includes('query.cgi')) return success();
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('no answer');
    // Answers once, with a list that cannot know yet, then goes quiet. The
    // create may still have been taken after that.
    if (method === 'list') {
      if (++lists === 1) return response({ success: true, data: { tasks: [] } });
      throw new TypeError('no answer');
    }
    return success();
  });
  const result = await h.api.addDownloadTasksBulk(['https://download.example/a'], '');
  assert.equal(result.deliveryUnknown, true);
  assert.equal(result.errorMessage, 'notifyUncertain');
  assert.ok(!h.notifications.some(n => n.message.includes('addNotListed')), JSON.stringify(h.notifications));
});

test('a refused sign-in stops a long list instead of trying it batch by batch', async () => {
  let logins = 0;
  const h = await background(async (url, options) => {
    if (String(url).includes('query.cgi')) return success();
    if (options.body?.get('method') === 'login') {
      logins++;
      return response({ success: false, error: { code: 400 } });
    }
    return success();
  }, { session: { sid: null } });

  const urls = Array.from({ length: 251 }, (_, i) => `https://download.example/${i}`);
  const result = await h.api.addDownloadTasksBulk(urls, '');
  // Six batches meant six refused logins against an account DSM may lock.
  assert.equal(logins, 1);
  assert.equal(result.added, 0);
  assert.equal(result.failed, 251);
  assert.equal(result.failedUrls.length, 251);
  // A sign-in problem is reported even with notifications switched off.
  assert.equal(result.configError, true);
});

test('a refused sign-in stops the one-at-a-time pass as well', async () => {
  let logins = 0;
  const h = await background(async (url, options) => {
    if (String(url).includes('query.cgi')) return success();
    const method = options.body?.get('method');
    if (method === 'login') {
      logins++;
      return response({ success: false, error: { code: 400 } });
    }
    if (method === 'create') {
      // The batch is refused in a way worth itemising; each single link then
      // finds the session gone and has to sign in.
      return response(options.body.get('uri').includes(',')
        ? { success: false, error: { code: 400 } }
        : { success: false, error: { code: 119 } });
    }
    return success();
  });

  const urls = Array.from({ length: 50 }, (_, i) => `https://download.example/${i}`);
  const result = await h.api.addDownloadTasksBulk(urls, '');
  // Fifty links used to mean fifty refused logins.
  assert.equal(logins, 1);
  assert.equal(result.added, 0);
  assert.equal(result.failedUrls.length, 50);
});

test('links from an earlier batch are checked too when more than 50 are added', async () => {
  const urls = Array.from({ length: 51 }, (_, i) => `https://download.example/${i}`);
  const firstBatch = urls.slice(0, 50);
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    // The batch of 50 goes unanswered; the single link after it is taken.
    if (method === 'create') {
      if (options.body.get('uri').includes(',')) throw new TypeError('no answer');
      return success();
    }
    if (method === 'list') {
      return response({ success: true, data: { tasks: firstBatch.map((uri, i) => (
        { id: `t${i}`, status: 'downloading', additional: { detail: { uri } } })) } });
    }
    return success();
  });
  const result = await h.api.addDownloadTasksBulk(urls, '');
  assert.equal(result.success, true);
  assert.equal(result.added, 51);
  assert.equal(result.failed, 0);
  assert.equal(h.requests.filter(request => request.body.method === 'create').length, 2);
});

test('a link the NAS lists only a moment later still counts as added', async () => {
  const link = 'https://download.example/a';
  let lists = 0;
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('no answer');
    if (method === 'list') {
      // Download Station is still working through the create we gave up on.
      return response(++lists < 3 ? { success: true, data: { tasks: [] } } : { success: true, data: { tasks: [
        { id: 'a', status: 'downloading', additional: { detail: { uri: link } } },
      ] } });
    }
    return success();
  });
  const result = await h.api.addDownloadTasksBulk([link], '');
  assert.equal(result.success, true);
  assert.equal(result.added, 1);
  assert.equal(lists, 3);
  assert.equal(h.requests.filter(request => request.body.method === 'create').length, 1);
});

test('a context-menu link the NAS took despite an unanswered create is reported as added', async () => {
  const link = 'https://download.example/a';
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('no answer');
    if (method === 'list') {
      return response({ success: true, data: { tasks: [
        { id: 'a', status: 'downloading', additional: { detail: { uri: link } } },
      ] } });
    }
    return success();
  });
  const result = await h.evaluate(`addDownloadTask('${link}')`);
  assert.equal(result.success, true);
  assert.equal(result.deliveryUnknown, false);
  await until(() => h.notifications.length > 0);
  assert.equal(h.notifications[0].message, 'notifyAdded');
});

test('an action taken while a list is on its way still gets a list of its own', async () => {
  const h = popup();
  const answers = [];
  h.browser.runtime.sendMessage = () => { const pending = deferred(); answers.push(pending); return pending.promise; };

  const running = h.evaluate('refreshTasks()');          // the timer's, asked before the action
  h.evaluate('refreshTasks({ queue: true })');           // the action's own
  assert.equal(answers.length, 1);

  // The older answer knows nothing of the action and shows nothing running.
  answers[0].resolve({ success: true, data: { tasks: [] } });
  await until(() => answers.length === 2);
  answers[1].resolve({ success: true, data: { tasks: [
    { id: 'a', status: 'downloading', additional: {} },
  ] } });
  await running;
  assert.equal(answers.length, 2);
});

test('pressing Enter twice on the verification code signs in once', async () => {
  const h = popup();
  let logins = 0;
  const pending = deferred();
  h.browser.runtime.sendMessage = () => { logins++; return pending.promise; };
  h.nodes.get('otpCode').value = '123456';

  const enter = h.nodes.get('otpCode').listeners.keydown;
  enter({ key: 'Enter', preventDefault() {} });
  enter({ key: 'Enter', preventDefault() {} });
  // The second press used to spend the same code again, and DSM answered the
  // one that arrived second with "wrong code".
  assert.equal(logins, 1);

  pending.resolve({ success: true });
  await until(() => h.nodes.get('btnOtpSubmit').disabled === false);
});

test('"Save and test" cannot spend the verification code a second time', async () => {
  const login = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') { logins++; return login.promise; }
    return success();
  }, { session: { sid: null } });

  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');
  for (const [id, value] of Object.entries({ protocol: 'https', host: 'old-nas.example',
    port: '5001', username: 'test-user', password: 'test-password' })) {
    p.document.getElementById(id).value = value;
  }
  p.nodes.get('otpField').hidden = false;
  p.nodes.get('otpCode').value = '123456';

  const checking = p.evaluate('submitOtp()');
  await until(() => logins === 1);
  // The code field's button is disabled by now, but this one calls straight in.
  await p.api.commitSettings({ forceTest: true, commitConn: true });
  assert.equal(logins, 1);

  login.resolve(response({ success: true, data: { sid: 'new-sid' } }));
  await checking;
});

test('the plain "Test" button cannot sign in while a code is being checked', async () => {
  const login = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') { logins++; return login.promise; }
    return success();
  }, { session: { sid: null } });

  const p = popup(h);
  p.nodes.get('otpField').hidden = false;
  p.nodes.get('otpCode').value = '123456';

  const checking = p.evaluate('submitOtp()');
  await until(() => logins === 1);
  // No code of its own, so this used to walk straight past the gate — and its
  // answer, a fresh demand for a code, landed after the successful one.
  await p.evaluate('testConnection()');
  assert.equal(logins, 1);

  login.resolve(response({ success: true, data: { sid: 'new-sid' } }));
  await checking;
});

test('an older connection test cannot undo a sign-in that already succeeded', async () => {
  const hanging = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') {
      logins++;
      // The plain Test goes first and is the one left waiting.
      return logins === 1 ? hanging.promise : response({ success: true, data: { sid: 'new-sid' } });
    }
    return success();
  }, { session: { sid: null } });

  const p = popup(h);
  p.nodes.get('otpField').hidden = false;
  p.nodes.get('otpCode').value = '123456';

  const testing = p.evaluate('testConnection()');   // no code, so it takes no gate
  await until(() => logins === 1);
  await p.evaluate('submitOtp()');                  // and this one succeeds
  assert.equal(p.nodes.get('otpField').hidden, true);

  // Now the overtaken test answers "code required" — about a session that has
  // one. Acting on it put the prompt back up and stopped the refresh.
  hanging.resolve(response({ success: false, error: { code: 403 } }));
  await testing;
  assert.equal(p.nodes.get('otpField').hidden, true);
});

test('no request to the NAS may follow a redirect', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') return response({ success: true, data: { sid: 'sid' } });
    return response({ success: true, data: { tasks: [] } });
  }, { session: { sid: null } });

  await h.send({ action: 'listTasks' });
  assert.ok(h.requests.length > 1, 'expected a sign-in and a list');
  // Handing the session back was the last call still making a fetch of its own,
  // and the id in its body is exactly what a redirect would carry off.
  await h.api.apiLogout();
  assert.ok(h.requests.some(request => request.body.method === 'logout'), 'expected a logout');
  // 307 and 308 keep the method and the body, so following one would hand the
  // password, the code or the session id to whatever answered.
  for (const request of h.requests) {
    assert.equal(request.redirect, 'error', `${request.url} was allowed to follow redirects`);
  }
});

test('the archive password does not outlive the account it was typed for', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') return response({ success: true, data: { sid: 'new-sid' } });
    return response({ success: true, data: { tasks: [] } });
  });
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');
  p.nodes.get('extractArchives').checked = true;

  p.nodes.get('unzipPassword').value = 'archive-secret';
  await p.evaluate('logoutAccount()');
  assert.equal(p.nodes.get('unzipPassword').value, '');

  // And again when a different account is saved over the old one.
  p.nodes.get('unzipPassword').value = 'archive-secret';
  for (const [id, value] of Object.entries({ protocol: 'https', host: 'other-nas.example',
    port: '5001', username: 'other-user', password: 'other-password' })) {
    p.document.getElementById(id).value = value;
  }
  await p.api.commitSettings({ commitConn: true });
  assert.equal(p.nodes.get('unzipPassword').value, '');
});

test('a verification code does not follow the user to the next connection', async () => {
  let codeSentTo = null;
  const h = await background(async (url, options) => {
    if (options.body?.get('method') === 'login') {
      if (options.body.get('otp_code')) codeSentTo = url;
      return response({ success: true, data: { sid: 'new-sid' } });
    }
    return response({ success: true, data: { tasks: [] } });
  });
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');

  // DSM asked for a code for the NAS that is saved right now, and it was typed.
  p.nodes.get('otpField').hidden = false;
  p.nodes.get('otpCode').value = '123456';

  // Then a different NAS goes into the form, saved with the same button.
  for (const [id, value] of Object.entries({ protocol: 'https', host: 'other-nas.example',
    port: '5001', username: 'other-user', password: 'other-password' })) {
    p.document.getElementById(id).value = value;
  }
  await p.api.commitSettings({ commitConn: true });

  // The sign-in has to have happened, or the check below proves nothing.
  const login = h.requests.find(request => request.body.method === 'login');
  assert.ok(login?.url.startsWith('https://other-nas.example:5001/'), 'expected a sign-in to the new NAS');
  assert.equal(codeSentTo, null, `the code went to ${codeSentTo}`);
  assert.equal(p.nodes.get('otpCode').value, '');
  assert.equal(p.nodes.get('otpField').hidden, true);
});

test('a poll landing after a dropped session keeps a watch that is still running', async () => {
  let logins = 0;
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'login') { logins++; return response({ success: true, data: { sid: 'fresh-sid' } }); }
    if (method === 'list') return response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } });
    return success();
  });
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 }); rememberWatched([{ id: 'a', status: 'downloading' }]);");
  // What the keepalive does with a session the NAS has forgotten: drop it, and
  // leave signing in again to whatever next needs a session. A tick landing in
  // that gap used to read the missing session as "the watch is over".
  await h.evaluate('clearSession()');
  await h.evaluate('pollDownloads()');
  assert.ok(!h.alarmCalls.some(call => !call.created && call.name === 'download-station-poll'),
    'the watch was ended while a download was still being followed');
  assert.equal(logins, 1);
  assert.equal(h.evaluate('watchedIds.size'), 1);
});

test('a retry that did delete the task still says so when the new one is refused', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'delete') return response({ success: true, data: [{ id: 'a', error: 0 }] });
    if (method === 'create') return response({ success: false, error: { code: 406 } });
    return success();
  });
  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '');
  assert.match(result.error.message, /^retryLinkKept:/);
});

test('what a lost answer means depends on what was being attempted', async () => {
  const h = await background(async () => { throw new TypeError('no answer'); });
  // Reading the list sends nothing, so no download can be in doubt. This used
  // to answer "whether the download arrived is unknown" for a plain refresh.
  const list = await h.send({ action: 'listTasks' });
  assert.equal(list.error.message, 'errNasUnreachable');
  // A pause did go out. What is unknown is its result, not a download.
  const paused = await h.send({ action: 'pauseTask', id: 'a', connection: h.connection });
  assert.equal(paused.error.message, 'actionResultUnknown');
});

test('a folder error names the folder that was actually sent', async () => {
  const h = await background();
  // Nothing of our own was sent, so the broken path is the NAS's own default.
  assert.match(await h.evaluate('describeTaskError(403)'), /errTask403NoDest/);
  // A retry sends the folder the original task was in. Reading the setting here
  // blamed the NAS's default for a folder the user had asked for by name.
  assert.match(await h.evaluate('describeTaskError(403, "share/films")'), /errTask403\|/);
});

test('the header follows the connection, not only the task list', async () => {
  let answering = false;
  const h = await background(async () => (answering
    ? response({ success: true, data: { tasks: [] } })
    : Promise.reject(new TypeError('no answer'))));
  const p = popup(h);
  await p.evaluate('refreshTasks()');
  // The header shares its row with the extension's name, so it carries a label
  // and the reason goes to the tooltip — there it used to be cut off mid-word.
  assert.equal(p.nodes.get('statusText').textContent, 'connectionFailed');
  assert.equal(p.nodes.get('statusText').title, 'errNasUnreachable');
  // Downloads visibly running again while the header still said unreachable.
  answering = true;
  await p.evaluate('refreshTasks()');
  assert.equal(p.nodes.get('statusText').textContent, 'connected');
});

test('a sign-in that failed is kept for a popup that was not there to hear it', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? response({ success: false, error: { code: 400 } })
    : success()), { session: { sid: null } });
  assert.equal((await h.send({ action: 'testConnection' })).success, false);
  // Closing the popup used to lose this answer outright: the next open found no
  // session, signed in again, and said nothing about the refusal before it.
  assert.equal(h.data.session.lastConnect.success, false);
  // A refused sign-in stops every download, so it is never silenced.
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, 'notifyError');
});

test('being asked for a code is kept but not announced', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? response({ success: false, error: { code: 403 } })
    : success()), { session: { sid: null } });
  assert.equal((await h.send({ action: 'testConnection' })).otpRequired, true);
  assert.equal(h.data.session.lastConnect.otpRequired, true);
  // DSM asks a correct password for a code too, so this is not a refusal.
  assert.equal(h.notifications.length, 0);
});

test('a sign-in that works clears a refusal kept from before', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? response({ success: true, data: { sid: 'new-sid' } })
    : success()), { session: { sid: null, lastConnect: { success: false, error: { message: 'stale' } } } });
  assert.equal((await h.send({ action: 'testConnection' })).success, true);
  assert.equal(h.data.session.lastConnect, undefined);
});

test('a connection changed underneath is not kept as a reason', async () => {
  const started = deferred(), pending = deferred();
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') { started.resolve(); return pending.promise; }
    return success();
  }, { session: { sid: null } });
  const login = h.send({ action: 'testConnection', otpCode: '123456' });
  await started.promise;
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  pending.resolve(response({ success: true, data: { sid: 'late-sid' } }));
  assert.equal((await login).connectionChanged, true);
  // The details it failed against are gone; kept, the reason would be read
  // against the connection that replaced them.
  assert.equal(h.data.session.lastConnect, undefined);
});

test('a kept sign-in failure survives being shown, and shows again on the next open', async () => {
  const h = makeBrowser({ session: { lastConnect: { success: false, error: { message: 'errLoginFailed' } } } });
  const first = popup(h);
  assert.equal(await first.evaluate('showKeptConnectFailure()'), true);
  assert.equal(first.nodes.get('statusText').textContent, 'connectionFailed');
  assert.equal(first.nodes.get('statusText').title, 'errLoginFailed');
  // A wrong password is a state, not news: clearing it on first display made the
  // second open sign in again and spend another of DSM's attempts.
  assert.deepEqual(h.data.session.lastConnect.error, { message: 'errLoginFailed' });
  // Once per popup, though — this one has said it already.
  assert.equal(await first.evaluate('showKeptConnectFailure()'), false);

  const second = popup(h);
  assert.equal(await second.evaluate('showKeptConnectFailure()'), true);
  assert.equal(second.nodes.get('statusText').title, 'errLoginFailed');
});

test('a refusal that arrives after the NAS was changed is neither kept nor announced', async () => {
  const started = deferred(), pending = deferred();
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') { started.resolve(); return pending.promise; }
    return success();
  }, { session: { sid: null } });
  const testing = h.send({ action: 'testConnection' });
  await started.promise;
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  // The old NAS finally turns it down — about credentials nobody is using now.
  pending.resolve(response({ success: false, error: { code: 400 } }));
  await testing;
  assert.equal(h.data.session.lastConnect, undefined);
  // It used to be reported against the NAS that had replaced its target.
  assert.equal(h.notifications.length, 0);
});

test('an overtaken answer cannot wipe the failure a newer attempt left', async () => {
  const started = deferred(), pending = deferred();
  let slow = true;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'login') return success();
    if (slow) { started.resolve(); return pending.promise; }
    return response({ success: false, error: { code: 400 } });
  }, { session: { sid: null } });

  const stale = h.send({ action: 'testConnection' });
  await started.promise;
  // A different NAS, so the attempt still out there belongs to nobody.
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  slow = false;
  await h.send({ action: 'testConnection' });
  assert.equal(h.data.session.lastConnect.success, false);

  // The old one comes back as "connection changed" — and used to clear this.
  pending.resolve(response({ success: true, data: { sid: 'late-sid' } }));
  await stale;
  assert.equal(h.data.session.lastConnect.success, false);
});

test('an explicit sign-in retires a kept failure', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? response({ success: true, data: { sid: 'fresh-sid' } })
    : response({ success: true, data: { tasks: [] } })),
  { session: { sid: null, lastConnect: { success: false, error: { message: 'errLoginFailed' } } } });
  // An explicit retry may sign in despite the kept failure.
  assert.equal((await h.send({ action: 'testConnection' })).success, true);
  // Left standing, it reappeared in the popup as soon as the session lapsed.
  assert.equal(h.data.session.lastConnect, undefined);
});

test('changing the connection takes a kept failure with it', async () => {
  const h = await background(success,
    { session: { lastConnect: { success: false, error: { message: 'errLoginFailed' } } } });
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  assert.equal(h.data.session.lastConnect, undefined);
});

test('a kept failure bars the refresh a stored add would otherwise start', async () => {
  const h = await background(success, { session: {
    sid: null,
    lastConnect: { success: false, error: { message: 'errLoginFailed' } },
  } });
  const p = popup(h);
  // The order init uses: the kept failure is read first, because applying an
  // add result starts the task refresh and the close watch behind it.
  await p.evaluate('loadKeptConnectFailure()');
  await p.api.applyAddOutcome({ success: true, added: 2, at: Date.now() });
  await p.evaluate('refreshTasks()');
  // Each of those signed in against a password already refused — one login on
  // opening, then another every three seconds for the length of the watch.
  assert.ok(!h.requests.some(request => request.body.method === 'login'),
    JSON.stringify(h.requests.map(request => request.body.method)));
});

test('a refusal stays overtaken even once the session it lost to has ended', async () => {
  const hanging = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'login') return success();
    logins++;
    return logins === 1 ? hanging.promise : response({ success: true, data: { sid: 'new-sid' } });
  }, { session: { sid: null } });

  const stale = h.send({ action: 'testConnection' });
  await until(() => logins === 1);
  assert.equal((await h.send({ action: 'testConnection', otpCode: '123456' })).success, true);
  // The session lapses the ordinary way before the old answer turns up.
  await h.evaluate('cachedSid = null');
  hanging.resolve(response({ success: false, error: { code: 403 } }));
  await stale;
  // Asking whether a session is open confused "is this answer still true?" with
  // "should I try again now?": the stale code request was stored all over again.
  assert.equal(h.data.session.lastConnect, undefined);
});

test('an older refusal cannot overwrite a newer one', async () => {
  const first = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'login') return success();
    logins++;
    return logins === 1 ? first.promise : response({ success: false, error: { code: 404 } });
  }, { session: { sid: null } });

  const older = h.send({ action: 'testConnection' });
  await until(() => logins === 1);
  await h.send({ action: 'testConnection', otpCode: '123456' });
  assert.equal(h.data.session.lastConnect.otpWrong, true);

  first.resolve(response({ success: false, error: { code: 403 } }));
  await older;
  // Same connection, same count of accepted sign-ins: nothing but the order
  // separates two refusals, and this one answered last having started first.
  assert.equal(h.data.session.lastConnect.otpWrong, true);
  assert.notEqual(h.data.session.lastConnect.otpRequired, true);
});

test('an overtaken answer is marked for whoever asked, not merely dropped', async () => {
  const hanging = deferred();
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? hanging.promise : success()), { session: { sid: null } });

  const stale = h.send({ action: 'testConnection' });
  await until(() => h.requests.some(request => request.body.method === 'login'));
  await h.send({ action: 'settingsUpdated', signOut: true });
  hanging.resolve(response({ success: false, error: { code: 403 } }));
  const result = await stale;
  // Handed back unchanged, it put the code prompt up in the open popup over an
  // account name that had just been emptied.
  assert.equal(result.outdated, true);
  assert.equal(h.notifications.length, 0);
});

test('an explicit sign-in lifts the bar in a popup that is already open', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? response({ success: true, data: { sid: 'fresh-sid' } })
    : response({ success: true, data: { tasks: [] } })),
  { session: { sid: null, lastConnect: { success: false, error: { message: 'errLoginFailed' } } } });

  const p = popup(h);
  await p.evaluate('popupReady = true; loadKeptConnectFailure()');
  assert.equal(p.evaluate('connectBlocked'), true);
  const listsBefore = h.requests.filter(request => request.body.method === 'list').length;

  // A successful explicit retry retires the failure, and the open popup
  // resumes its task list when that stored failure is removed.
  assert.equal((await h.send({ action: 'testConnection' })).success, true);
  await until(() => p.evaluate('connectBlocked') === false);
  assert.equal(p.nodes.get('statusText').textContent, 'connected');
  await until(() => h.requests.filter(request => request.body.method === 'list').length > listsBefore);
});

test('a refused test bars automatic login after an old session expires during popup init', async () => {
  let logins = 0, retryAllowed = false;
  const h = await background(async (_, options) => {
    const body = options.body;
    if (body?.get('method') === 'login') {
      logins++;
      return response(retryAllowed
        ? { success: true, data: { sid: 'new-sid' } }
        : { success: false, error: { code: 400 } });
    }
    if (body?.get('method') === 'list') {
      return response(body.get('_sid') === 'old-sid'
        ? { success: false, error: { code: 105 } }
        : { success: true, data: { tasks: [] } });
    }
    return success();
  }, { local: { startTab: 'tasks', refreshInterval: 5 } });

  assert.equal((await h.send({ action: 'testConnection' })).success, false);
  assert.equal(h.data.session.sid, 'old-sid');
  const reason = h.data.session.lastConnect.error.message;
  h.browser.runtime.getManifest = () => ({ version: '1.1.3' });
  const p = popup(h);
  p.nodes.get('otpField').hidden = true;
  const intervals = new Set(), callbacks = [];
  p.context.setInterval = fn => {
    callbacks.push(fn);
    intervals.add(fn);
    return fn;
  };
  p.context.clearInterval = fn => intervals.delete(fn);

  // Run the real startup, including its optimistic reuse of the old session.
  await p.evaluate(scripts.popup.slice(scripts.popup.indexOf('(async function init() {')));
  await until(() => h.requests.some(r => r.body.method === 'list') && !p.evaluate('refreshInFlight'));
  assert.equal(logins, 1);
  assert.equal(p.evaluate('connectBlocked'), true);
  assert.equal(p.nodes.get('statusText').textContent, 'connectionFailed');
  assert.equal(p.nodes.get('statusText').title, reason);
  assert.ok(callbacks.length > 0);
  assert.equal(intervals.size, 0);

  // Even callbacks already queued before cancellation must stay quiet.
  const requestsBefore = h.requests.length;
  for (let tick = 0; tick < 5; tick++) {
    for (const callback of callbacks) await callback();
  }
  assert.equal(h.requests.length, requestsBefore);
  assert.equal(logins, 1);

  retryAllowed = true;
  await p.nodes.get('btnTest').listeners.click();
  await until(() => !p.evaluate('refreshInFlight'));
  assert.equal(logins, 2);
  assert.equal(h.data.session.sid, 'new-sid');
  assert.equal(h.data.session.lastConnect, undefined);
  assert.equal(p.evaluate('connectBlocked'), false);
  assert.match(p.nodes.get('statusText').textContent, /^connected/);
  assert.ok(h.requests.some(r => r.body.method === 'list' && r.body._sid === 'new-sid'));
});

test('a live session lets down the bar an older failure had raised', async () => {
  const h = await background(success,
    { session: { lastConnect: { success: false, error: { message: 'errLoginFailed' } } } });
  const p = popup(h);
  await p.evaluate('loadKeptConnectFailure()');
  await p.evaluate('refreshTasks()');
  assert.equal(h.requests.length, 0);

  // What init does when the background reports a session: it answers a failure
  // kept from before it. Left standing, the bar barred the very list that branch
  // asks for, and the header read "Connected" over a list that never loaded.
  assert.equal(p.evaluate('releaseConnectBar()'), true);
  await p.evaluate('refreshTasks()');
  assert.ok(h.requests.some(request => request.body.method === 'list'));
});

test('a code check for one NAS does not swallow the test of another', async () => {
  const first = deferred(), second = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'login') return success();
    logins++;
    return logins === 1 ? first.promise : second.promise;
  }, { session: { sid: null } });

  const p = popup(h);
  p.evaluate("settings.host = 'nas-a.example'");
  const forA = p.evaluate("attemptConnect('123456')");
  await until(() => logins === 1);

  // Another NAS is saved and tested while the first code is still in flight. As
  // a plain flag the gate turned this away: A's answer was correctly discarded
  // and B was simply never asked, leaving the header on "Connecting…".
  p.evaluate("settings.host = 'nas-b.example'");
  const forB = p.evaluate("attemptConnect('654321')");
  await until(() => logins === 2);

  // A answers last, and its own release must not open the gate B is holding —
  // that would let a second code go out against B while one is still running.
  first.resolve(response({ success: false, error: { code: 403 } }));
  await forA;
  assert.notEqual(p.evaluate('otpPendingFor'), null);
  second.resolve(response({ success: true, data: { sid: 'b-sid' } }));
  await forB;
  assert.equal(p.evaluate('otpPendingFor'), null);
});

test('a corrected password is tested while an older code check is still running', async () => {
  const oldReply = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'login') return response({ success: true, data: { tasks: [] } });
    return ++logins === 1 ? oldReply.promise : response({ success: true, data: { sid: 'new-sid' } });
  }, { session: { sid: null } });
  const p = popup(h);
  await p.evaluate('loadSettings()');
  p.evaluate('readStatusOrder = () => [...settings.statusOrder]; showOtpPrompt(true)');
  p.nodes.get('otpCode').value = '123456';
  const checking = p.nodes.get('btnOtpSubmit').listeners.click();
  await until(() => logins === 1);

  p.nodes.get('password').value = 'corrected-password';
  await p.api.commitSettings({ commitConn: true, forceTest: true });
  const attempts = h.requests.filter(request => request.body.method === 'login');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].body.passwd, 'corrected-password');
  assert.equal(attempts[1].body.otp_code, undefined);

  oldReply.resolve(response({ success: false, error: { code: 403 } }));
  await checking;
  assert.equal(h.data.session.sid, 'new-sid');
  assert.equal(p.evaluate('otpPendingFor'), null);
  assert.equal(p.nodes.get('otpField').hidden, true);
  assert.match(p.nodes.get('statusText').textContent, /^connected/);
});

test('returning to a NAS gives its new code check an owner the old check cannot release', async () => {
  const oldA = deferred(), pendingB = deferred(), newA = deferred();
  let aCodes = 0, bCodes = 0;
  const h = await background(async (url, options) => {
    if (options.body?.get('method') !== 'login') return response({ success: true, data: { tasks: [] } });
    if (!options.body.get('otp_code')) return response({ success: false, error: { code: 403 } });
    if (url.includes(defaults.host)) return ++aCodes === 1 ? oldA.promise : newA.promise;
    bCodes++;
    return pendingB.promise;
  }, { session: { sid: null } });
  const p = popup(h);
  await p.evaluate('loadSettings()');
  p.evaluate('readStatusOrder = () => [...settings.statusOrder]; showOtpPrompt(true)');
  const enter = code => {
    p.nodes.get('otpCode').value = code;
    p.nodes.get('otpCode').listeners.keydown({ key: 'Enter', preventDefault() {} });
  };
  const switchTo = async host => {
    p.nodes.get('host').value = host;
    await p.api.commitSettings({ commitConn: true, forceTest: true });
  };

  enter('123456');
  await until(() => aCodes === 1);
  await switchTo('nas-b.example');
  enter('654321');
  await until(() => bCodes === 1);
  await switchTo(defaults.host);
  enter('987654');
  await until(() => aCodes === 2);
  const owner = p.evaluate('otpPendingFor');
  assert.ok(owner);

  oldA.resolve(response({ success: false, error: { code: 403 } }));
  await until(() => !p.nodes.get('btnOtpSubmit').disabled);
  assert.equal(p.evaluate('otpPendingFor'), owner);
  enter('987654');
  await until(() => !p.nodes.get('btnOtpSubmit').disabled || aCodes > 2);
  assert.equal(aCodes, 2);
  assert.equal(bCodes, 1);
  assert.equal(p.evaluate('otpPendingFor'), owner);

  pendingB.resolve(response({ success: false, error: { code: 403 } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.evaluate('otpPendingFor'), owner);
  newA.resolve(response({ success: true, data: { sid: 'current-a' } }));
  await until(() => p.evaluate('otpPendingFor') === null);
  assert.equal(h.data.session.sid, 'current-a');
  assert.equal(p.nodes.get('otpField').hidden, true);
  assert.match(p.nodes.get('statusText').textContent, /^connected/);
});

test('a success a newer test has overtaken is not the connection state now', async () => {
  const hanging = deferred();
  let logins = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'login') return success();
    logins++;
    return logins === 1 ? hanging.promise : response({ success: false, error: { code: 400 } });
  }, { session: { sid: null } });

  const stale = h.send({ action: 'testConnection' });
  await until(() => logins === 1);
  // A newer test answers first, and is refused.
  await h.send({ action: 'testConnection', otpCode: '123456' });
  assert.equal(h.data.session.lastConnect.success, false);

  // The older one finally gets through. It did succeed, but it describes a
  // state that has been asked about again since — and because only the ground
  // was checked for a success, this came back as the current one.
  hanging.resolve(response({ success: true, data: { sid: 'late-sid' } }));
  assert.equal((await stale).outdated, true);
});

test('the second look knows its own record from a newer test', async () => {
  const h = await background();
  // The window is one await on the store, which the message path cannot be made
  // to land inside on purpose. The arithmetic is the whole of the fix.
  h.evaluate('signInsAccepted = 0; newestConnectTestAnswered = 4;');
  const asked = (seq, options) => h.evaluate(
    `outdatedAttempt({ epoch: sessionEpoch, startedAt: 0, seq: ${seq} }, ${JSON.stringify(options)})`);

  // Before this attempt is recorded, an equal number can only be somebody else's.
  assert.equal(asked(4, {}), true);
  assert.equal(asked(5, {}), false);
  // After it, that number is its own. Asking the first question again here made
  // every attempt declare itself overtaken and swallow its own report.
  assert.equal(asked(4, { recorded: true }), false);
  // A genuinely newer one still counts, which the ground-only second look missed.
  h.evaluate('newestConnectTestAnswered = 6;');
  assert.equal(asked(4, { recorded: true }), true);
});

test('a sign-in carrying a code is never repeated after a lost answer', async () => {
  const attempts = async (otpCode) => {
    let logins = 0;
    const h = await background(async (_, options) => {
      if (options.body?.get('method') !== 'login') return success();
      logins++;
      throw new TypeError('Connection reset');
    }, { session: { sid: null } });
    await h.send({ action: 'testConnection', otpCode });
    return logins;
  };
  // A code is good for one use. The NAS may well have taken the first attempt
  // and only the reply went missing — asking again spends it a second time, and
  // DSM answers that one with "wrong code", which is what got kept as the reason.
  assert.equal(await attempts('123456'), 1);
  // Without one there is nothing to spend, and a sleeping NAS relies on the
  // sign-in being repeated until it answers.
  assert.ok(await attempts(undefined) > 1);
});

test('a batch names what is uncertain, not only what was refused', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    // The create goes unanswered, and so does the lookup that would settle it.
    if (method === 'create' || method === 'list') throw new TypeError('Connection reset');
    return success();
  });

  const result = await h.api.addDownloadTasksBulk(
    ['https://download.example/a,b.zip', 'https://download.example/ok.zip'], '');
  assert.equal(result.failed, 2);

  // Counted as one, this read "0 added, 2 failed" and named only the comma —
  // over a download that may well have been running by then.
  const note = h.notifications.at(-1).message;
  assert.match(note, /notifyBulkPartial:0\|1\|/, note);
  assert.match(note, /notifyBulkUncertainCount:1/, note);
});

test('an answered lookup replaces the certificate reason of the unanswered create', async () => {
  let h;
  h = await background(async (url, options) => {
    const method = options.body?.get('method');
    if (method === 'create') {
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
      throw new TypeError('NetworkError');
    }
    return method === 'list' ? response({ success: true, data: { tasks: [] } }) : success();
  });
  const result = await h.send({ action: 'addTasksBulk', urls: ['https://download.example/a'] });
  await until(() => h.notifications.length > 0);
  assert.equal(result.deliveryUnknown, false);
  assert.equal(result.errorMessage, 'addNotListed');
  assert.equal(result.certificateReason, false);
  assert.equal(h.data.session.connectionProblem, undefined);
  assert.equal(h.notifications.at(-1).message, 'notifyBulkPartial:0|1|addNotListed');
});

test('a permanent lookup permission refusal is named once even with notifications off', async () => {
  for (const enabled of [true, false]) for (const route of ['bulk', 'single']) {
    let lists = 0, logins = 0;
    const h = await background(async (_, options) => {
      const method = options.body?.get('method');
      if (method === 'create') throw new TypeError('lost create response');
      if (method === 'list') { lists++; return response({ success: false, error: { code: 105 } }); }
      if (method === 'login') { logins++; return response({ success: true, data: { sid: 'lookup-sid' } }); }
      return success();
    }, { local: { notificationsEnabled: enabled } });
    const result = route === 'bulk'
      ? await h.send({ action: 'addTasksBulk', urls: ['https://download.example/a'] })
      : await h.evaluate("addDownloadTask('https://download.example/a')");
    await until(() => h.notifications.length > 0);
    assert.equal(logins, 1);
    assert.equal(lists, 2);
    assert.equal(result.deliveryUnknown, true);
    assert.match(route === 'bulk' ? result.errorMessage : result.error.message, /err105/);
    assert.match(h.notifications.at(-1).message, /err105/);
    assert.equal(h.notifications.length, 1);
    if (route === 'bulk') {
      assert.equal(result.uncertain, 1);
      assert.equal(result.namedReason, true);
      assert.equal(result.blockConnection, false);
      assert.equal(result.configError, true);
      assert.match(h.notifications.at(-1).message, /notifyBulkUncertainCount:1/);
      assert.deepEqual(plain(result.failedUrls), ['https://download.example/a']);
    }
  }
});

test('single-link notifications retain uncertainty when the confirmation lookup is refused', async () => {
  for (const route of ['magnet', 'contextMenu']) for (const refusal of ['permission', 'api', 'login', 'certificate']) {
    let h;
    h = await background(async (url, options) => {
      const method = options.body?.get('method');
      if (method === 'create') throw new TypeError('Create response lost');
      if (method === 'list') {
        if (refusal === 'certificate') {
          h.webRequest.onErrorOccurred.emit({ error: 'SSL_ERROR_BAD_CERT_DOMAIN',
            type: 'xmlhttprequest', tabId: -1, url,
            originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
          throw new TypeError('NetworkError');
        }
        return response({ success: false, error: {
          code: refusal === 'permission' ? 105 : refusal === 'login' ? 119 : 101,
        } });
      }
      if (method === 'login') return refusal === 'login'
        ? response({ success: false, error: { code: 400 } })
        : response({ success: true, data: { sid: 'lookup-sid' } });
      return success();
    });
    const url = 'magnet:?xt=urn:btih:example';
    if (route === 'magnet') {
      const result = await h.send({ action: 'magnetClicked', url });
      assert.equal(result.deliveryUnknown, true);
    } else {
      h.browser.contextMenus.onClicked.emit({ linkUrl: url });
    }
    await until(() => h.notifications.length > 0 && h.evaluate('addsPending') === 0);
    const note = h.notifications.at(-1);
    assert.equal(note.title, 'notifyAddUnconfirmed', `${route}: ${refusal}`);
    assert.match(note.message, refusal === 'certificate' ? /^notifyCertificate$/
      : refusal === 'login' ? /errLoginFailed/ : refusal === 'permission' ? /err105/ : /err101/);
    assert.equal(h.requests.filter(request => request.body.method === 'create').length, 1);
  }
});

test('a general lookup API refusal shows its reason without blocking the popup or overriding notification settings', async () => {
  for (const route of ['bulk', 'single']) {
    let lists = 0;
    const h = await background(async (_, options) => {
      const method = options.body?.get('method');
      if (method === 'create') throw new TypeError('lost create response');
      if (method === 'list') { lists++; return response({ success: false, error: { code: 101 } }); }
      return success();
    }, { local: { notificationsEnabled: false } });
    const result = route === 'bulk'
      ? await h.api.addDownloadTasksBulk(['https://download.example/a'], '')
      : await h.evaluate("addDownloadTask('https://download.example/a')");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lists, 1);
    assert.equal(result.deliveryUnknown, true);
    assert.match(route === 'bulk' ? result.errorMessage : result.error.message, /err101/);
    assert.equal(h.notifications.length, 0);
    if (route === 'bulk') {
      assert.equal(result.namedReason, true);
      assert.equal(result.blockConnection, false);
      assert.equal(result.configError, false);
      await h.api.recordForPopup(result, h.connection, await h.api.readConnectionVersion());
      const p = popup(h);
      p.context.savedConnection = defaults;
      p.evaluate('settings = { ...settings, ...savedConnection };');
      await p.api.consumeLastAdd();
      assert.match(p.evaluate('linksMessageEl.textContent'), /err101/);
      assert.match(p.evaluate('linksMessageEl.textContent'), /linksUncertain:1/);
      assert.equal(p.evaluate('connectBlocked'), false);
    }
  }
});

test('a refused sign-in during the lookup is still named when nothing was refused', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('Connection reset');
    // The lookup that would settle it finds the session gone and is turned down.
    if (method === 'list')  return response({ success: false, error: { code: 105 } });
    if (method === 'login') return response({ success: false, error: { code: 400 } });
    return success();
  });

  await h.api.addDownloadTasksBulk(['https://download.example/a'], '');
  const note = h.notifications.at(-1).message;
  // Nothing was turned down outright, so the reason had no refusal to travel
  // with: this announced itself as "0 added, 1 uncertain" and left the wrong
  // password — the one thing anyone could act on — out altogether.
  assert.match(note, /notifyBulkUncertainCount:1/, note);
  assert.match(note, /errLoginFailed/, note);
});

test('a sign-in refused during the lookup reaches the open popup as well', async () => {
  let logins = 0;
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('Connection reset');
    if (method === 'list')  return response({ success: false, error: { code: 105 } });
    if (method === 'login') { logins++; return response({ success: false, error: { code: 400 } }); }
    return success();
  });

  // The whole chain, not a hand-built result: the add records itself for the
  // popup, and the popup takes it the way it would on its own. The connection
  // and its version travel with it, as the message handler sends them — this
  // outcome is about the NAS still configured and the password still in use, so
  // it is this one's to act on.
  await h.api.recordForPopup(
    await h.api.addDownloadTasksBulk(['https://download.example/a'], ''),
    h.connection, await h.api.readConnectionVersion());

  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');
  const callbacks = [];
  p.context.setInterval = (fn) => { callbacks.push(fn); return fn; };
  p.context.clearInterval = () => {};
  // A download was already running, so the list is on its own timer.
  p.evaluate("activateTab('tasks'); startAutoRefresh();");
  await p.api.consumeLastAdd();

  // The system notification names the wrong password; the popup showed only
  // "outcome unclear" and its header went on reading "Connected".
  const text = p.evaluate('linksMessageEl.textContent');
  assert.match(text, /linksUncertain:1/, text);
  assert.match(text, /errLoginFailed/, text);
  assert.equal(p.nodes.get('statusText').textContent, 'connectionFailed');
  assert.match(p.nodes.get('statusText').title, /errLoginFailed/);

  // And the NAS is left alone. Without the bar, switching to Tasks put the
  // timer back and spent five more attempts on the refused password before the
  // failure count caught up.
  assert.equal(p.evaluate('connectBlocked'), true);
  const spent = logins;
  for (let tick = 0; tick < 5; tick++) {
    for (const callback of callbacks) await callback();
  }
  assert.equal(logins, spent, 'the refused password was tried again');
});

test('the popup tells a refused link from one that may be running', async () => {
  const h = await background(success);
  const p = popup(h);
  await p.api.applyAddOutcome({
    success: false, added: 0, at: Date.now(),
    failedUrls: ['https://download.example/a,b.zip', 'https://download.example/ok.zip'],
    errorMessage: 'linkHasComma', deliveryUnknown: true, uncertain: 1,
  });

  // Both are back in the box, but only one of them has an explanation. Counted
  // as one, the popup called both uncertain and never mentioned the comma.
  const text = p.evaluate('linksMessageEl.textContent');
  assert.match(text, /linksFailedReason:1\|linkHasComma/, text);
  assert.match(text, /linksUncertain:1/, text);
});

test('a retry whose new task got no answer does not call it a failure', async () => {
  let creates = 0;
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    // Confirmed per task, which is what makes this a delete that went through —
    // a bare success leaves it unconfirmed, and then nothing is added at all.
    if (method === 'delete') return response({ success: true, data: [{ id: 'a', error: 0 }] });
    if (method === 'create') { creates++; throw new TypeError('Connection reset'); }
    return success();
  });

  const result = await h.api.apiRetryTask('a', 'https://download.example/a', '');
  assert.equal(creates, 1);
  assert.equal(result.deliveryUnknown, true);
  assert.equal(result.linkKept, true);
  // The delete did go through and the new task may be standing. Saying "adding
  // it again did not work" sent people to press Add beside it.
  assert.match(result.error.message, /^retryLinkKeptUnknown/, result.error.message);
});

test('every way in refuses a comma, and a retry refuses before it deletes', async () => {
  // A right-click, and a magnet picked up from a page: neither goes through the
  // link list, so neither met the check that used to live only there.
  const single = await background(success);
  const answer = await single.evaluate(
    "addDownloadTask('https://download.example/a,b.zip', { announce: true })");
  assert.equal(answer.success, false);
  assert.equal(answer.error.message, 'linkHasComma');
  assert.deepEqual(single.requests.map(request => request.url), []);

  // The retry deleted the original first and only then discovered it could not
  // put anything back — the task was gone and the link with it.
  const retry = await background(success);
  const outcome = await retry.api.apiRetryTask('t1', 'https://download.example/a,b.zip', '');
  assert.equal(outcome.success, false);
  assert.equal(outcome.error.message, 'linkHasComma');
  assert.ok(!retry.requests.some(request => request.body.method === 'delete'),
    JSON.stringify(retry.requests.map(request => request.body.method)));
});

test('a refused sign-in is named ahead of a link that was never sent', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? response({ success: false, error: { code: 400 } })
    : success()), { session: { sid: null } });

  const result = await h.api.addDownloadTasksBulk(
    ['https://download.example/a,b.zip', 'https://download.example/ok.zip'], '');
  // Both fail, but only one of them is something the user can do anything
  // about. Reported by position, the comma spoke for the batch and the wrong
  // password vanished from the result and from the notification alike.
  assert.match(result.errorMessage, /errLoginFailed/);
  assert.equal(result.configError, true);
  assert.equal(h.notifications.at(-1).title, 'notifyPartial');
  assert.match(h.notifications.at(-1).message, /errLoginFailed/);
});

test('a link containing a comma is turned down instead of becoming two', async () => {
  const alone = await background(success);
  await alone.api.addDownloadTasksBulk(['https://download.example/a,b.zip'], '');
  // Nothing goes out at all, not even the wake-up: there is nothing to send.
  assert.deepEqual(alone.requests.map(request => request.url), []);

  const h = await background(success);
  const result = await h.api.addDownloadTasksBulk(
    ['https://download.example/a,b.zip', 'https://download.example/ok.zip'], '');
  // Rebuilt out here: the answer was made inside the vm, so its array carries
  // that realm's prototype and a strict comparison rejects it on that alone.
  assert.deepEqual([...result.failedUrls], ['https://download.example/a,b.zip']);
  assert.equal(result.errorMessage, 'linkHasComma');
  // The API separates links with commas, so sent together these two arrived as
  // three. Only the one that can be said unambiguously travels.
  const create = h.requests.find(request => request.body.method === 'create');
  assert.equal(create.body.uri, 'https://download.example/ok.zip');
});

test('a draft typed while a save was waiting is not dropped with it', async () => {
  const saved = { protocol: 'https', host: 'old.example', port: '5001', username: 'me', password: 'pw' };
  // The fields are what the comparison reads, so they are what a case has to
  // set up. Arranged in storage alone, every case passed for the wrong reason:
  // untouched fields are empty, and empty differs from any snapshot.
  const mount = (session) => {
    const h = makeBrowser({ session });
    const p = popup(h);
    for (const [id, value] of Object.entries(saved)) p.nodes.get(id).value = value;
    return { h, p };
  };

  // Nothing typed since the save began: the draft has done its job and goes.
  const settled = mount({ connDraft: { ...saved } });
  await settled.p.evaluate(`clearConnDraft(${JSON.stringify(saved)})`);
  assert.equal(settled.h.data.session.connDraft, undefined);

  // "Save and test connection" waits on the NAS with the fields still editable,
  // and whatever was typed in the meantime is in them. Dropped anyway, it was
  // gone, and the next open came back without it.
  const typing = mount({ connDraft: { ...saved, host: 'typed-later.example' } });
  typing.p.nodes.get('host').value = 'typed-later.example';
  await typing.p.evaluate(`clearConnDraft(${JSON.stringify(saved)})`);
  assert.equal(typing.h.data.session.connDraft.host, 'typed-later.example');

  // The destination keeps a draft of its own and answers the same question the
  // same way, from its own field — both ways round.
  const dest = makeBrowser({ session: { destDraft: 'movies' } });
  const d = popup(dest);
  d.nodes.get('defaultDestination').value = 'series';
  await d.evaluate("clearDestDraft('movies')");
  assert.equal(dest.data.session.destDraft, 'movies');

  d.nodes.get('defaultDestination').value = 'movies';
  await d.evaluate("clearDestDraft('movies')");
  assert.equal(dest.data.session.destDraft, undefined);
});

test('pause and resume cover the same statuses in the popup and in bulk', async () => {
  const h = await background(success);
  const p = popup(h);
  for (const status of ['downloading', 'waiting', 'filehosting_waiting']) {
    // The popup kept a list of its own, and it was short one: a task waiting on
    // a file host was swept up by "Pause all" but never offered its own button.
    assert.equal(p.evaluate(`canPauseTask('${status}')`), true, status);
    assert.equal(h.evaluate(`canPauseTask('${status}')`), true, status);
  }
  assert.equal(p.evaluate("canPauseTask('FILEHOSTING_WAITING')"), true);
  assert.equal(p.evaluate("canPauseTask('finished')"), false);
  for (const status of ['paused', 'stopped']) {
    assert.equal(p.evaluate(`canResumeTask('${status}')`), true, status);
  }
});

test('a reset takes the old complaints with it', async () => {
  const h = await background(success);
  const p = popup(h);
  p.evaluate("showLinksFailed(2, 'errTask403', { uncertain: 0 })");
  p.evaluate("reportActionResult({ success: false, error: { message: 'nope' } })");
  assert.equal(p.evaluate('linksMessageEl.hidden'), false);
  assert.equal(p.evaluate('taskStatusEl.hidden'), false);

  await p.evaluate('resetAllSettings()');
  // Both outlived everything they were about: the links were gone from the box
  // and the tasks from the list, with the red marking still standing over them.
  assert.equal(p.evaluate('linksMessageEl.hidden'), true);
  assert.equal(p.evaluate('taskStatusEl.hidden'), true);
});

test('a stored connection failure does not end the download watch', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'login'
    ? response({ success: false, error: { code: 400 } })
    : response({ success: true, data: { tasks: [{ id: 'a', status: 'downloading' }] } })),
  { session: {
    sid: null,
    // No stored paths, as after a browser restart — or after a discovery that
    // failed, since a failed one keeps nothing and runs again next time.
    apiPaths: null,
    // Not a refusal at all: the popup's test found the NAS unreachable, which is
    // what a sleeping or briefly unplugged NAS answers.
    lastConnect: { success: false, nasUnreachable: true, error: { message: 'errNasUnreachable' } },
  } });
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 }); rememberWatched([{ id: 'a', status: 'downloading' }]);");
  for (let tick = 0; tick < 6; tick++) await h.evaluate('pollDownloads()');

  // Nothing goes out at all. The sign-in was always stopped, but API discovery
  // ran ahead of the block and asked query.cgi on every single tick, for a
  // sign-in that was never going to be made.
  assert.deepEqual(h.requests.map(request => request.url), []);
  // And the watch survives: a block is a state the user lifts from the popup,
  // not the NAS refusing us. Ended here, the downloads it was following would
  // finish with no notification and the badge would go with them.
  assert.ok(await h.browser.alarms.get('download-station-poll'), 'the watch alarm was cleared');
  assert.ok(h.data.session.watchedIds?.length, 'the watched downloads were dropped');
});

test('a watch that ends in failures is not announced as all downloads finished', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'list'
    ? response({ success: true, data: { tasks: [{ id: 'a', status: 'error' }] } })
    : success()));
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 }); rememberWatched([{ id: 'a', status: 'downloading' }]);");
  await h.evaluate('pollDownloads()');
  await until(() => h.notifications.length > 0);
  // The heading used to say "all downloads finished" over "0 completed · 1 failed".
  assert.equal(h.notifications[0].title, 'notifyFailed');
  assert.equal(h.notifications[0].message, 'notifyDoneCount:0 · notifyFailedCount:1');
});

test('a task list answering after a newer sign-in began leaves the header alone', async () => {
  const pending = deferred();
  let lists = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'list') return success();
    return ++lists === 1 ? pending.promise : response({ success: true, data: { tasks: [] } });
  });
  const p = popup(h);
  p.evaluate("setStatus('error', 'otpRequired')");
  const late = p.evaluate('refreshTasks()');
  await until(() => lists === 1);
  // A connection test starts while the list is away, and asks for a code.
  p.evaluate('connectSeq++');
  pending.resolve(response({ success: true, data: { tasks: [] } }));
  await late;
  // The list is older than that demand and has no say over the header.
  assert.equal(p.nodes.get('statusText').textContent, 'otpRequired');
});

test('a sign-in that gets no answer is not reported as an unconfirmed action', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') throw new TypeError('no answer');
    return success();
  }, { session: { sid: null } });
  const paused = await h.send({ action: 'pauseTask', id: 'a', connection: h.connection });
  // Nothing was sent that could have a result.
  assert.equal(paused.error.message, 'errNasUnreachable');
  assert.ok(!h.requests.some(request => request.body.method === 'pause'));
});

test('a delete-all whose task list never arrives blames the connection, not the action', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'list') throw new TypeError('no answer');
    return success();
  });
  const result = await h.send({ action: 'deleteAll', connection: h.connection });
  assert.equal(result.error.message, 'errNasUnreachable');
  assert.ok(!h.requests.some(request => request.body.method === 'delete'));
});

test('a watch ending with something paused is not announced as all downloads finished', async () => {
  const h = await background(async (_, options) => (options.body?.get('method') === 'list'
    ? response({ success: true, data: { tasks: [{ id: 'a', status: 'finished' }, { id: 'b', status: 'paused' }] } })
    : success()));
  h.evaluate("browser.alarms.create('download-station-poll', { periodInMinutes: 1 }); rememberWatched([{ id: 'a', status: 'downloading' }, { id: 'b', status: 'downloading' }]);");
  await h.evaluate('pollDownloads()');
  await until(() => h.notifications.length > 0);
  // "All downloads finished" over "1 completed · 1 paused" contradicted itself.
  assert.equal(h.notifications[0].title, 'notifyWatchResult');
  assert.equal(h.notifications[0].message, 'notifyDoneCount:1 · notifyPausedCount:1');
});

test('an empty folder means none was sent, a missing one falls back to the setting', async () => {
  const h = await background();
  h.data.local.defaultDestination = 'share/default';
  // '' is an answer, not a gap: this create named no folder of its own, so the
  // broken path is the NAS's own default. Reading the setting here sent the user
  // to check a folder the request had never mentioned.
  assert.match(await h.evaluate("describeTaskError(403, '')"), /errTask403NoDest/);
  // Only a caller that cannot know — a task action, a list — reads the setting.
  assert.match(await h.evaluate('describeTaskError(403)'), /errTask403\|/);
});

test('a bulk folder error names the folder sent, not one set while it was away', async () => {
  const create = deferred();
  const h = await background(async (_, options) => (options.body?.get('method') === 'create'
    ? create.promise : success()));
  h.data.local.defaultDestination = 'downloads/configured';
  const adding = h.api.addDownloadTasksBulk(
    ['https://download.example/a', 'https://download.example/b'], '');
  await until(() => h.requests.some(request => request.body.method === 'create'));
  // Emptied while the create is still on its way. Reading the setting once the
  // answer lands reports "no folder was sent" for a create that sent one.
  h.data.local.defaultDestination = '';
  create.resolve(response({ success: false, error: { code: 403 } }));
  const result = await adding;
  assert.match(result.errorMessage, /errTask403\|/);
  assert.doesNotMatch(result.errorMessage, /NoDest/);
});

test('a sign-in already running when a task list is asked for keeps the header', async () => {
  const pending = deferred();
  let lists = 0;
  const h = await background(async (_, options) => {
    if (options.body?.get('method') !== 'list') return success();
    return ++lists === 1 ? pending.promise : response({ success: true, data: { tasks: [] } });
  });
  const p = popup(h);
  p.evaluate("setStatus('error', 'otpRequired')");
  // Already on its way: it has taken a number and has yet to answer. The list
  // that follows carries the same number, so only "is one running" tells them
  // apart — the counter alone said the list was entitled to the header.
  p.evaluate('connectSeq++');
  const late = p.evaluate('refreshTasks()');
  await until(() => lists === 1);
  pending.resolve(response({ success: true, data: { tasks: [] } }));
  await late;
  assert.equal(p.nodes.get('statusText').textContent, 'otpRequired');
});

test('a retry whose sign-in never answers reports that, not an unconfirmed delete', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') throw new TypeError('no answer');
    return success();
  }, { session: { sid: null } });
  await assert.rejects(
    h.api.apiRetryTask('a', 'https://download.example/a', '', { destination: 'share/films' }),
    err => err.deliveryUnknown !== true);
  // Nothing went out, so there was nothing to rescue and nothing to report as
  // unconfirmed. The link stays with its task.
  assert.equal(h.data.session.bulkDraft, undefined);
  assert.ok(!h.requests.some(request => request.body.method === 'delete'));
});

test('a folder error is not rewritten by a setting changed while the request is away', async () => {
  const create = deferred();
  const h = await background(async (_, options) => (options.body?.get('method') === 'create'
    ? create.promise : success()));
  h.data.local.defaultDestination = 'downloads/configured';
  const adding = h.api.apiAddTaskBatch(['https://download.example/a']);
  await until(() => h.requests.some(request => request.body.method === 'create'));
  // Emptied while the create is still on its way.
  h.data.local.defaultDestination = '';
  create.resolve(response({ success: false, error: { code: 403 } }));
  const result = await adding;
  assert.equal(result.destinationUsed, 'downloads/configured');
  // So 403 is about that folder, not about the default set on the NAS itself.
  assert.match(await h.evaluate(`describeTaskError(403, ${JSON.stringify(result.destinationUsed)})`),
    /errTask403\|/);
});

test('choosing HTTP says what it costs, and HTTPS takes the warning away', () => {
  const p = popup();
  p.nodes.get('protocol').value = 'http';
  p.evaluate('syncProtocolWarning()');
  assert.equal(p.nodes.get('protocolWarning').hidden, false);

  p.nodes.get('protocol').value = 'https';
  p.evaluate('syncProtocolWarning()');
  assert.equal(p.nodes.get('protocolWarning').hidden, true);
});

test('HTTPS to a bare IP says so before anything is sent', () => {
  const p = popup();
  const warn = (protocol, host) => {
    p.nodes.get('protocol').value = protocol;
    p.nodes.get('host').value = host;
    p.evaluate('syncProtocolWarning()');
    return !p.nodes.get('certWarning').hidden;
  };

  // A NAS certificate usually covers a name only. Over HTTPS the browser then
  // turns this down before the NAS is asked, and the refusal used to read as
  // "not reachable" after four sign-in attempts and thirty seconds.
  assert.equal(warn('https', '192.168.1.2'), true);
  assert.equal(warn('https', '[fd00::1]'), true, 'IPv6 is the same case');
  // A name takes it away again.
  assert.equal(warn('https', 'nas.example.com'), false);
  // And it is about HTTPS alone: without TLS no certificate is involved.
  assert.equal(warn('http', '192.168.1.2'), false);
  // The two warnings answer different questions and do not stand in for each
  // other — HTTP is what the second one is about.
  assert.equal(p.nodes.get('protocolWarning').hidden, false);
});

test('an unsaved HTTP choice still carries its warning after reopening', async () => {
  const h = makeBrowser();
  // Chosen, not saved, popup closed — the draft is all that is left of it.
  await h.browser.storage.session.set({ connDraft: { protocol: 'http' } });

  const p = popup(h);
  await p.evaluate('loadConnDraft()');
  assert.equal(p.nodes.get('protocol').value, 'http');
  assert.equal(p.nodes.get('protocolWarning').hidden, false);
});

test('a restored address decides the certificate hint, not the one it replaced', async () => {
  // The form as applySettingsToForm leaves it — the *saved* connection — and
  // then the draft on top of it. Both warnings read protocol and address
  // together, so asking while only half the draft has landed answers about a
  // connection that exists nowhere.
  const restore = async (saved, connDraft) => {
    const h = makeBrowser();
    await h.browser.storage.session.set({ connDraft });
    const p = popup(h);
    for (const [id, value] of Object.entries(saved)) p.nodes.get(id).value = value;
    p.evaluate('syncProtocolWarning()');
    await p.evaluate('loadConnDraft()');
    return !p.nodes.get('certWarning').hidden;
  };

  // Saved under a name, half-typed into an IP: the hint belongs to the IP.
  assert.equal(await restore({ protocol: 'https', host: 'nas.example.com' },
    { protocol: 'https', host: '192.168.1.2' }), true);
  // And the other way round it has to go again.
  assert.equal(await restore({ protocol: 'https', host: '192.168.1.2' },
    { protocol: 'https', host: 'nas.example.com' }), false);
});

test('the browser reason for a refused request is recorded, and only for this NAS', async () => {
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/auth.cgi`;
  let h, afterForeign;
  // Raised while the request is genuinely in flight — afterwards there is
  // nothing for a refusal to belong to, and it is dropped on purpose.
  h = await background(async () => {
    // Another service on the same machine: through the filter, which cannot
    // express a port, but not ours.
    h.webRequest.onErrorOccurred.emit({ error: 'SEC_ERROR_UNKNOWN_ISSUER', type: 'xmlhttprequest', tabId: -1,
      url: `https://${defaults.host}:9999/something-else` });
    // Nor the NAS's own web interface, open in a tab and failing against the
    // very same certificate. Adopting that would put a message on screen about
    // a request nobody here made.
    h.webRequest.onErrorOccurred.emit({ error: 'SEC_ERROR_UNKNOWN_ISSUER', type: 'xmlhttprequest', tabId: 7,
      url: `https://${defaults.host}:${defaults.port}/webman/index.cgi` });
    afterForeign = h.data.session.lastTransportError;

    h.webRequest.onErrorOccurred.emit({ error: 'SEC_ERROR_EXPIRED_CERTIFICATE', type: 'xmlhttprequest', tabId: -1,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html'),
      url: `${endpoint}?_sid=secret-session-id` });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });
  await h.api.apiFetch(endpoint, {}, { repeatable: false }).catch(() => {});

  // Scoped to the host being talked to. Watching every address would hand the
  // extension other sites' failures, which is none of its business.
  //
  // Without the port: Firefox match patterns cannot express one, and a pattern
  // carrying it is accepted and then matches nothing — a listener that can
  // never fire, which is exactly what it looks like when nothing is wrong.
  assert.deepEqual(plain(h.errorFilters), [{ urls: [`https://${defaults.host}/*`] }]);
  assert.deepEqual(plain(h.data.session.transportWatch.patterns), [`https://${defaults.host}/*`]);
  assert.equal(afterForeign, undefined, 'neither of those is ours');

  const seen = h.data.session.lastTransportError;
  assert.equal(seen.error, 'SEC_ERROR_EXPIRED_CERTIFICATE');
  assert.equal(seen.type, 'xmlhttprequest');
  // Filed under the endpoint alone: a query string is not part of the address
  // the in-flight bookkeeping is keyed on.
  assert.equal(seen.url, endpoint);
});

// Measured against Firefox 156: the security layer answers in prose, already
// translated, where an ordinary network failure gives a symbolic name. Matching
// SSL_ERROR_BAD_CERT_DOMAIN — the obvious thing to write — would have matched
// nothing at all, and every test of it would still have passed.
const CERT_PROSE = 'Sichere Kommunikation mit der Gegenstelle ist nicht möglich: '
  + 'Angeforderter Domainname stimmt nicht mit dem Zertifikat des Servers überein.';

/** A NAS that fails at the handshake, with the browser raising `error` as it does. */
function refusing(error, { tabId = -1 } = {}) {
  let h;
  const made = async (url) => {
    h.webRequest.onErrorOccurred.emit({ error, type: 'xmlhttprequest', tabId, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  };
  return background(made).then(ready => (h = ready));
}

test('a refused certificate is said in the browser\'s own words, once', async () => {
  const h = await refusing(CERT_PROSE);
  const err = await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);

  // Quoted, not restated: Mozilla promises nothing about this wording, so the
  // extension frames it rather than claiming it as its own diagnosis.
  assert.equal(err.message, `errCertificate:${CERT_PROSE}`);
  assert.equal(err.certificateError, true);
  // No repeating: this connection was answered and turned down, so waiting for
  // a NAS to wake is no remedy. That is what `nasUnreachable` would have
  // earned it.
  assert.equal(err.nasUnreachable, undefined);
  // But saying what was refused and saying nothing was sent are two different
  // claims. A handshake failing before any application data goes out sends
  // nothing — the security layer also speaks after a request has gone, and the
  // two cannot be told apart from here. So the delivery stays uncertain, and
  // an add that may have landed is still reconciled against the task list.
  assert.equal(err.deliveryUnknown, true);
  assert.equal(h.requests.length, 1, 'thirty seconds of retries against a wall');
});

test('two requests to one endpoint never take each other\'s verdict', async () => {
  // create and list share an endpoint and are regularly in flight together. An
  // address and a time cannot say which refusal belongs to which, and guessing
  // would hand one request's verdict — and its certainty — to the other.
  //
  // Nothing identifies these two: the browser reports no start for either, so
  // neither learns a requestId. That is the case this pins. Where ids do
  // arrive, both are answered by name — see the test below.
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/DownloadStation/task.cgi`;
  const held = deferred();
  let h;
  // Only one of the two fails at the certificate; the other simply gets no
  // answer. So a claim made here is demonstrably the wrong request's.
  h = await background(async (url, options) => {
    if (options?.body?.get?.('method') === 'create') await held.promise;
    else {
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    }
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const creating = h.api.apiFetch(endpoint, { method: 'POST', body: new URLSearchParams({ method: 'create' }) },
    { repeatable: false }).then(() => null, caught => caught);
  const listing = h.api.apiFetch(endpoint, {}, { repeatable: false }).then(() => null, caught => caught);
  await until(() => h.requests.length === 2);
  held.resolve();

  // Neither may claim the verdict while the other stood beside it — taking the
  // refusal out of the list stops it serving twice, but does not make the one
  // use correct. The general answer is the honest one here.
  for (const err of [await creating, await listing]) {
    assert.equal(err.certificateError, undefined, 'a verdict that cannot be attributed is not claimed');
    assert.equal(err.deliveryUnknown, true, 'an add that may have landed stays uncertain');
  }
});

test('two identified requests to one endpoint each get their own answer', async () => {
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/DownloadStation/task.cgi`;
  const held = deferred();
  let h, calls = 0;
  // The same pair as above, and this time Firefox says which is which. One meets
  // the certificate, the other simply gets no answer — so a verdict handed to
  // the wrong one would be plain to see.
  h = await background(async (url, options) => {
    const about = { type: 'xmlhttprequest', tabId: -1, url, requestId: `req-${++calls}`,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
    h.webRequest.onBeforeRequest.emit(about);
    if (options?.body?.get?.('method') === 'create') {
      await held.promise;
      h.webRequest.onErrorOccurred.emit({ ...about, error: 'NS_ERROR_NET_TIMEOUT' });
    } else {
      h.webRequest.onErrorOccurred.emit({ ...about, error: CERT_PROSE });
    }
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const creating = h.api.apiFetch(endpoint, { method: 'POST', body: new URLSearchParams({ method: 'create' }) },
    { repeatable: false }).then(() => null, caught => caught);
  const listing = h.api.apiFetch(endpoint, {}, { repeatable: false }).then(() => null, caught => caught);
  await until(() => h.requests.length === 2);
  held.resolve();

  // Neither has to give up its reason for the other's sake any more.
  assert.equal((await listing).certificateError, true);
  assert.equal((await creating).certificateError, undefined);
  assert.equal((await creating).nasUnreachable, true);
});

/**
 * The browser's reason arriving *after* the request it belongs to has failed.
 *
 * Firefox raises the two independently, and this is the order actually
 * measured against it. Every certificate test above hands the reason over
 * before the fetch rejects, so none of them reproduced it — and a build that
 * waited a single turn for it, and then reported an unreachable NAS on every
 * attempt after the first, passed all of them.
 *
 * `turns` is counted in microtasks, so the harness has an order rather than a
 * clock to go by. Eight is well past the one yield the old build allowed and
 * well inside the budget the new one keeps.
 */
function refusingLate(error, { turns = 8, requestId = 'req-1' } = {}) {
  let h;
  const made = async (url) => {
    const about = { type: 'xmlhttprequest', tabId: -1, url, requestId,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
    h.webRequest.onBeforeRequest.emit(about);
    let left = turns;
    const later = () => {
      if (--left > 0) { queueMicrotask(later); return; }
      h.webRequest.onErrorOccurred.emit({ ...about, error });
    };
    queueMicrotask(later);
    throw new TypeError('NetworkError when attempting to fetch resource.');
  };
  return background(made).then(ready => (h = ready));
}

test('a refusal that arrives after its request has failed is still named', async () => {
  const h = await refusingLate(CERT_PROSE);

  const err = await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);

  assert.equal(err.message, `errCertificate:${CERT_PROSE}`);
  assert.equal(err.certificateError, true);
  // Both events go through the same filter as the other: an id learnt through
  // a filter the real one would never deliver would be worth nothing.
  assert.deepEqual(plain(h.startFilters), [{ urls: [`https://${defaults.host}/*`] }]);
  assert.equal(h.requests.length, 1, 'answered and turned down — repeating changes nothing');
});

test('a refusal arriving after its request is not pinned on the next one', async () => {
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/auth.cgi`;
  const retried = deferred();
  let h, calls = 0;
  h = await background(async (url) => {
    const about = { type: 'xmlhttprequest', tabId: -1, url, requestId: `req-${++calls}`,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
    h.webRequest.onBeforeRequest.emit(about);
    // The first request's reason, held back until the retry is out. By then the
    // retry is the only thing at this address and the time is its own, so
    // nothing but the id says whose reason this is.
    if (calls === 1) retried.promise.then(() => h.webRequest.onErrorOccurred.emit({ ...about, error: CERT_PROSE }));
    else retried.resolve();
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const err = await h.api.apiFetch(endpoint, {}).then(() => null, caught => caught);

  // Losing a message is an inconvenience; pinning one on the wrong request is a
  // wrong answer. The retry says what it can stand behind.
  assert.equal(err.message, 'errNasUnreachable');
  assert.equal(err.certificateError, undefined);
  assert.equal(h.requests.length, 4, 'a NAS that never answered is still worth waiting for');
  // Seen and written down all the same — dropped by nobody, claimed by nobody.
  assert.equal(h.data.session.lastTransportError.error, CERT_PROSE);
});

test('a start the browser does not identify leaves the old route open', async () => {
  let h;
  // The start carries no id; the refusal does. Treating the missing one as an
  // identity would mark the attempt identified — and so deaf to the address as
  // well — while the reason it is waiting for is filed under an id it never
  // learnt. Worse than never having been identified at all.
  h = await background(async (url) => {
    const about = { type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
    h.webRequest.onBeforeRequest.emit(about);
    h.webRequest.onErrorOccurred.emit({ ...about, requestId: 'req-1', error: CERT_PROSE });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const err = await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);

  assert.equal(err.message, `errCertificate:${CERT_PROSE}`);
});

test('a request that is over does not stand in the way of the next one', async () => {
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/auth.cgi`;
  let h, calls = 0;
  h = await background(async (url) => {
    // The first request fails with the browser saying nothing at all, so it
    // never learns an id of its own and is given up on unexplained.
    if (++calls === 1) throw new TypeError('NetworkError when attempting to fetch resource.');
    const about = { type: 'xmlhttprequest', tabId: -1, url, requestId: 'req-2',
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
    h.webRequest.onBeforeRequest.emit(about);
    h.webRequest.onErrorOccurred.emit({ ...about, error: CERT_PROSE });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  await h.api.apiFetch(endpoint, {}, { repeatable: false }).catch(() => {});
  const err = await h.api.apiFetch(endpoint, {}, { repeatable: false })
    .then(() => null, caught => caught);

  // The second request's id has to reach the second request. Left on the
  // books, the first would still be the oldest thing waiting for an id at this
  // address and would take it — and with it the reason, which would then be
  // delivered to a request nobody is listening for any more.
  assert.equal(err.message, `errCertificate:${CERT_PROSE}`);
});

test('the reason for a refusal outlives the attempts that follow it', async () => {
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/auth.cgi`;
  const origin = `https://${defaults.host}:${defaults.port}`;
  let h, mode = 'refused';
  h = await background(async (url) => {
    if (mode === 'answers') return success();
    if (mode === 'refused') {
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    }
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  await h.api.apiFetch(endpoint, {}, { repeatable: false }).catch(() => {});
  const refused = plain(h.data.session.connectionProblem);
  assert.equal(refused.origin, origin);
  assert.equal(refused.certificate, true);
  assert.equal(refused.reason, CERT_PROSE);

  // What the user actually meets next: the attempts after a refused
  // certificate come back as a NAS that simply did not answer. The reason has
  // to survive that, or the one thing to act on is gone by the time anyone
  // looks — but it is no longer this attempt's verdict, and is not filed as one.
  mode = 'silent';
  await h.api.apiFetch(endpoint, {}, { repeatable: false }).catch(() => {});
  const kept = plain(h.data.session.connectionProblem);
  assert.equal(kept.certificate, false);
  assert.equal(kept.reason, CERT_PROSE);

  // Something answered, so the handshake is good now — whatever the answer was.
  mode = 'answers';
  await h.api.apiFetch(endpoint, {});
  assert.equal(h.data.session.connectionProblem, undefined);
});

test('a NAS that simply does not answer leaves no panel behind', async () => {
  const h = await background(async () => { throw new TypeError('NetworkError when attempting to fetch resource.'); });
  await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {}, { repeatable: false })
    .catch(() => {});
  // The general message already says this much. A panel repeating it would be
  // noise, and would put a red box in front of every sleeping NAS.
  assert.equal(h.data.session.connectionProblem, undefined);
});

test('a reason from a finished request is not taken by the one still waiting', async () => {
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/auth.cgi`;
  const retried = deferred();
  let h, calls = 0;
  h = await background(async (url) => {
    const about = { type: 'xmlhttprequest', tabId: -1, url, requestId: 'req-1',
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
    if (++calls === 1) {
      // Identified, then given up on without a word — and only afterwards does
      // its reason arrive.
      h.webRequest.onBeforeRequest.emit(about);
      retried.promise.then(() => h.webRequest.onErrorOccurred.emit({ ...about, error: CERT_PROSE }));
    } else {
      // The retry, whose own start Firefox has not reported yet: it still goes
      // by address, and the address is the same one.
      retried.resolve();
    }
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const err = await h.api.apiFetch(endpoint, {}).then(() => null, caught => caught);

  // An id known to be finished with keeps its reason out of the shared list
  // altogether. Left there, the retry would have adopted it — and with it a
  // verdict that costs it the very repeats a sleeping NAS needs.
  assert.equal(err.certificateError, undefined);
  assert.equal(err.message, 'errNasUnreachable');
  assert.equal(h.requests.length, 4);
  assert.equal(h.data.session.connectionProblem, undefined, 'and nothing is filed about it');
});

test('a request that learns its id late still recognises its own reason', async () => {
  let h;
  h = await background(async (url) => {
    const about = { type: 'xmlhttprequest', tabId: -1, url, requestId: 'req-1',
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
    // The refusal arrives while nothing here knows the id yet, so it goes to
    // the shared list; the start follows. The order of the two deliveries is
    // the browser's, not ours, and an attempt that is handed its id afterwards
    // must still be able to name its own reason.
    h.webRequest.onErrorOccurred.emit({ ...about, error: CERT_PROSE });
    queueMicrotask(() => h.webRequest.onBeforeRequest.emit(about));
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const err = await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);

  assert.equal(err.message, `errCertificate:${CERT_PROSE}`);
});

test('a reason from the NAS switched away from does not displace the current one', async () => {
  const held = deferred();
  let h;
  h = await background(async (url) => {
    // The NAS being left is still out, and answers last — with a refusal of
    // its own.
    if (url.startsWith(`https://${defaults.host}`)) await held.promise;
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const leaving = h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {},
    { repeatable: false }).catch(() => {});
  await until(() => h.requests.length === 1);
  await h.browser.storage.local.set({ host: 'new-nas.example' });
  await h.api.apiFetch('https://new-nas.example:5001/webapi/auth.cgi', {}, { repeatable: false })
    .catch(() => {});
  const current = plain(h.data.session.connectionProblem);
  held.resolve();
  await leaving;

  // One record, and it belongs to the address in use. The other NAS's reason is
  // about an address nobody is looking at any more: written there, the popup
  // would have shown nothing at all.
  assert.equal(current.origin, 'https://new-nas.example:5001');
  assert.deepEqual(plain(h.data.session.connectionProblem), current);
});

test('a connection switch during the first diagnosis read preserves the new NAS record and cache', async () => {
  const held = deferred();
  let h, reading = false, answers = false;
  h = await background(async url => {
    if (answers) return success();
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  }, { session: { sid: null, apiPaths: null } });

  const session = h.browser.storage.session;
  const read = session.get.bind(session);
  session.get = async keys => {
    const snapshot = await read(keys);
    if (!reading && keys && 'connectionProblem' in keys) {
      reading = true;
      await held.promise;
    }
    return snapshot;
  };

  // A has passed its address check and is still loading an empty diagnosis.
  const leaving = h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {},
    { repeatable: false }).catch(() => {});
  await until(() => reading);
  await h.evaluate('updateSettings({ connection: { host: "new-nas.example" } })');
  const endpoint = 'https://new-nas.example:5001/webapi/auth.cgi';
  await h.api.apiFetch(endpoint, {}, { repeatable: false }).catch(() => {});
  const current = plain(h.data.session.connectionProblem);
  assert.equal(current.origin, 'https://new-nas.example:5001');

  held.resolve();
  await leaving;
  assert.deepEqual(plain(h.data.session.connectionProblem), current);

  // A stale initial read must not silently replace B's in-memory record either:
  // the next successful response needs that record to clear the visible panel.
  answers = true;
  await (await h.api.apiFetch(endpoint, {})).json();
  assert.equal(h.data.session.connectionProblem, undefined);
});

test('a delayed diagnosis cannot restore a certificate panel after a newer connection test succeeds', async () => {
  const held = deferred();
  let h, failedFetch = false, holding = false;
  h = await background(async (url, options) => {
    if (options.body?.get('method') === 'list') {
      failedFetch = true;
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
      throw new TypeError('NetworkError');
    }
    return response({ success: true, data: { sid: 'working-new-sid' } });
  });
  const read = h.browser.storage.local.get.bind(h.browser.storage.local);
  h.browser.storage.local.get = async keys => {
    const snapshot = await read(keys);
    if (failedFetch && !holding) {
      holding = true;
      await held.promise;
    }
    return snapshot;
  };
  const listing = h.send({ action: 'listTasks' });
  await until(() => holding);
  assert.equal((await h.send({ action: 'testConnection' })).success, true);
  assert.equal(h.data.session.connectionProblem, undefined);
  held.resolve();
  assert.equal((await listing).success, false);
  assert.equal(h.data.session.sid, 'working-new-sid');
  assert.equal(h.data.session.connectionProblem, undefined);

  // A genuinely later failure must still be shown for this same address.
  assert.equal((await h.send({ action: 'listTasks' })).success, false);
  assert.equal(h.data.session.connectionProblem.reason, CERT_PROSE);
});

test('an older successful response cannot clear a newer diagnosis after a delayed storage read', async () => {
  const held = deferred();
  let h, holding = false, refuse = false;
  const origin = `https://${defaults.host}:${defaults.port}`;
  const endpoint = `${origin}/webapi/auth.cgi`;
  h = await background(async url => {
    if (!refuse) return success();
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError');
  }, { session: { connectionProblem: { origin, certificate: true, reason: 'older reason', at: 1 } } });
  const read = h.browser.storage.session.get.bind(h.browser.storage.session);
  h.browser.storage.session.get = async keys => {
    const snapshot = await read(keys);
    if (!holding && keys && 'connectionProblem' in keys) {
      holding = true;
      await held.promise;
    }
    return snapshot;
  };
  const answering = h.api.apiFetch(endpoint, {}).then(resp => resp.json());
  await until(() => holding);
  refuse = true;
  await assert.rejects(h.api.apiFetch(`${origin}/webapi/query.cgi`, {}, { repeatable: false }),
    err => err.certificateError === true);
  const latest = plain(h.data.session.connectionProblem);
  held.resolve();
  await answering;
  assert.equal(latest.reason, CERT_PROSE);
  assert.deepEqual(plain(h.data.session.connectionProblem), latest);
});

test('diagnosis writes cannot finish after a newer clear', async () => {
  const base = `https://${defaults.host}:${defaults.port}/webapi/`;
  const held = deferred();
  let h, writing = false;
  h = await background(async url => {
    if (!url.endsWith('refused.cgi')) return success();
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError');
  });
  const set = h.browser.storage.session.set.bind(h.browser.storage.session);
  h.browser.storage.session.set = async values => {
    if (!writing && values.connectionProblem) { writing = true; await held.promise; }
    return set(values);
  };
  const older = h.api.apiFetch(`${base}refused.cgi`, {}, { repeatable: false }).catch(err => err);
  await until(() => writing);
  const newer = h.api.apiFetch(`${base}answered.cgi`, {}).then(resp => resp.json());
  await until(() => h.evaluate('connectionProblem === null'));
  held.resolve();
  await Promise.all([older, newer]);
  assert.equal(h.data.session.connectionProblem, undefined);
  assert.equal(h.evaluate('connectionProblem'), null);
});

test('a later result that leaves the diagnosis unchanged cannot cancel a queued clear', async () => {
  for (const following of ['answered-again.cgi', 'unreachable.cgi']) {
    const base = `https://${defaults.host}:${defaults.port}/webapi/`;
    const held = deferred();
    let h, writing = false;
    h = await background(async url => {
      if (url.endsWith('refused.cgi')) {
        h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
          originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
        throw new TypeError('NetworkError');
      }
      if (url.endsWith('unreachable.cgi')) throw new TypeError('NetworkError');
      return success();
    });
    const set = h.browser.storage.session.set.bind(h.browser.storage.session);
    h.browser.storage.session.set = async values => {
      if (!writing && values.connectionProblem) { writing = true; await held.promise; }
      return set(values);
    };
    const older = h.api.apiFetch(`${base}refused.cgi`, {}, { repeatable: false }).catch(err => err);
    await until(() => writing);
    const cleared = h.api.apiFetch(`${base}answered.cgi`, {}).then(resp => resp.json());
    await until(() => h.evaluate('connectionProblem === null'));
    // This result changes no panel state, but used to invalidate the queued
    // removal that still had to make the persisted state match the cache.
    await h.api.apiFetch(`${base}${following}`, {}, { repeatable: false })
      .then(resp => resp.json(), err => err);
    held.resolve();
    await Promise.all([older, cleared]);
    assert.equal(h.evaluate('connectionProblem'), null);
    assert.equal(h.data.session.connectionProblem, undefined, following);
  }
});

test('a pending old removal finishes before the newer diagnosis is stored', async () => {
  const base = `https://${defaults.host}:${defaults.port}/webapi/`;
  const held = deferred();
  let h, removing = false, second = false;
  h = await background(async url => {
    if (!url.endsWith('refused.cgi')) return success();
    h.webRequest.onErrorOccurred.emit({ error: second ? 'SEC_ERROR_UNKNOWN_ISSUER' : CERT_PROSE,
      type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError');
  });
  await h.api.apiFetch(`${base}refused.cgi`, {}, { repeatable: false }).catch(() => {});
  const remove = h.browser.storage.session.remove.bind(h.browser.storage.session);
  h.browser.storage.session.remove = async keys => {
    if (!removing && [].concat(keys).includes('connectionProblem')) {
      removing = true;
      await held.promise;
    }
    return remove(keys);
  };
  const older = h.api.apiFetch(`${base}answered.cgi`, {}).then(resp => resp.json());
  await until(() => removing);
  second = true;
  const newer = h.api.apiFetch(`${base}refused.cgi`, {}, { repeatable: false }).catch(err => err);
  await until(() => h.evaluate('connectionProblem?.reason') === 'SEC_ERROR_UNKNOWN_ISSUER');
  held.resolve();
  await Promise.all([older, newer]);
  assert.equal(h.data.session.connectionProblem.reason, 'SEC_ERROR_UNKNOWN_ISSUER');
  assert.equal(h.evaluate('connectionProblem.reason'), 'SEC_ERROR_UNKNOWN_ISSUER');
});

test('a late browser reason cannot outlive a newer answer on the same origin', async () => {
  const base = `https://${defaults.host}:${defaults.port}/webapi/`;
  let h, wake;
  const about = { url: `${base}refused.cgi`, type: 'xmlhttprequest', tabId: -1,
    requestId: 'old-request', originUrl: 'moz-extension://test-extension/_generated_background_page.html' };
  h = await background(async url => {
    if (url.endsWith('refused.cgi')) {
      h.webRequest.onBeforeRequest.emit(about);
      throw new TypeError('NetworkError');
    }
    return success();
  });
  const timer = h.context.setTimeout;
  h.context.setTimeout = (fn, ms) => {
    if (!wake) { wake = fn; return 1; }
    return timer(fn, ms);
  };
  const older = h.api.apiFetch(about.url, {}, { repeatable: false }).catch(err => err);
  await until(() => wake);
  await (await h.api.apiFetch(`${base}answered.cgi`, {})).json();
  h.webRequest.onErrorOccurred.emit({ ...about, error: CERT_PROSE });
  wake();
  assert.equal((await older).certificateError, true, 'the old caller still receives its own reason');
  assert.equal(h.data.session.connectionProblem, undefined, 'the panel reflects the newer response');
});

test('a refused certificate is announced short and handed over in full', async () => {
  const h = await refusing(CERT_PROSE);

  const answer = await h.send({ action: 'testConnection' });

  // A notification shows one line and cuts off the rest — and what disappeared
  // was the browser's own reason, the part worth reading.
  assert.equal(h.notifications.at(-1).message, 'notifyCertificate');
  // The popup has room for all of it, so nothing is shortened on the way there.
  assert.equal(answer.error.message, `errCertificate:${CERT_PROSE}`);
});

test('the add path announces a refused certificate short as well', async () => {
  const h = await refusing(CERT_PROSE);

  const answer = await h.send({ action: 'addTasksBulk', urls: ['https://download.example/a'] });

  // A NAS that cannot be woken ends the add before anything is sent, and this
  // was the one route on which the browser's wording still went into a
  // notification whole — and was cut off there exactly as before.
  assert.equal(h.notifications.at(-1).message, 'notifyBulkPartial:0|1|notifyCertificate');
  assert.equal(answer.errorMessage, `errCertificate:${CERT_PROSE}`);
});

test('add preparation retains the certificate reason after a successful wake', async () => {
  for (const stage of ['login', 'discovery']) for (const route of ['bulk', 'single']) {
    let h, queries = 0;
    h = await background(async (url, options) => {
      const isQuery = new URL(url).pathname.endsWith('/query.cgi');
      if (isQuery) queries++;
      if ((stage === 'discovery' && isQuery && queries === 2)
        || options.body?.get('method') === 'login') {
        h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
          originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
        throw new TypeError('NetworkError');
      }
      return success();
    }, { session: { sid: null, apiPaths: stage === 'discovery' ? null : apis } });
    const urls = ['https://download.example/a,b',
      ...Array.from({ length: 51 }, (_, i) => `https://download.example/${i}`)];
    const result = route === 'bulk'
      ? await h.send({ action: 'addTasksBulk', urls })
      : await h.evaluate("addDownloadTask('https://download.example/a')");
    await until(() => h.notifications.length > 0);
    assert.equal(h.requests.length, 2, `${stage} ${route}`);
    assert.equal(result.deliveryUnknown, false);
    assert.equal(route === 'bulk' ? result.certificateReason : result.certificateError, true);
    assert.equal(route === 'bulk' ? result.errorMessage : result.error.message, `errCertificate:${CERT_PROSE}`);
    assert.equal(h.notifications.at(-1).message, route === 'bulk'
      ? 'notifyBulkPartial:0|52|notifyCertificate' : 'notifyCertificate');
    assert.equal(h.data.session.connectionProblem.reason, CERT_PROSE);
  }
});

test('blocked adds retain their certificate panel without another wake request', async () => {
  for (const route of ['bulk', 'single']) {
    let h, refuse = true;
    h = await background(async url => {
      if (refuse) {
        h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
          originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
        throw new TypeError('NetworkError');
      }
      return success();
    }, { local: { notificationsEnabled: false }, session: { sid: null } });
    const login = await h.send({ action: 'testConnection' });
    assert.equal(login.certificateError, true);
    const panel = plain(h.data.session.connectionProblem);
    const requests = h.requests.length;
    h.notifications.length = 0;
    refuse = false;
    const result = route === 'bulk'
      ? await h.send({ action: 'addTasksBulk', urls: ['https://download.example/a'] })
      : await h.evaluate("addDownloadTask('https://download.example/a')");
    await until(() => h.notifications.length > 0);
    assert.equal(h.requests.length, requests, 'blocked login must not clear its panel with a wake');
    assert.deepEqual(plain(h.data.session.connectionProblem), panel);
    assert.equal(result.deliveryUnknown, false);
    assert.equal(h.notifications.at(-1).message, route === 'bulk'
      ? 'notifyBulkPartial:0|1|notifyCertificate' : 'notifyCertificate');
  }
});

test('a blocked retry retains the certificate panel without waking or changing tasks', async () => {
  let h, refuse = true;
  h = await background(async url => {
    if (refuse) {
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
      throw new TypeError('NetworkError');
    }
    return success();
  }, { session: { sid: null } });
  assert.equal((await h.send({ action: 'testConnection' })).certificateError, true);
  const panel = plain(h.data.session.connectionProblem);
  const before = h.requests.length;
  refuse = false;
  const result = await h.send({ action: 'retryTask', id: 'dbid_1',
    uri: 'https://download.example/a', connection: h.connection });
  assert.equal(result.success, false);
  assert.equal(result.deliveryUnknown, false);
  assert.equal(result.certificateError, true);
  assert.equal(result.error.message, `errCertificate:${CERT_PROSE}`);
  assert.equal(h.requests.length, before, 'no wake, delete or create while sign-in is blocked');
  assert.deepEqual(plain(h.data.session.connectionProblem), panel);
  assert.equal(h.data.session.bulkDraft, undefined);
});

test('an itemised batch stops when a replacement login meets a certificate refusal', async () => {
  let h, creates = 0;
  h = await background(async (url, options) => {
    const method = options.body?.get('method');
    if (method === 'create') return response({ success: false, error: { code: ++creates === 1 ? 400 : 107 } });
    if (method === 'login') {
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
      throw new TypeError('NetworkError');
    }
    return success();
  });
  const result = await h.send({ action: 'addTasksBulk',
    urls: ['https://download.example/a', 'https://download.example/b'] });
  await until(() => h.notifications.length > 0);
  assert.equal(creates, 2);
  assert.equal(h.requests.filter(r => r.body.method === 'login').length, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.deliveryUnknown, false);
  assert.equal(result.certificateReason, true);
  assert.equal(result.errorMessage, `errCertificate:${CERT_PROSE}`);
  assert.equal(h.notifications.at(-1).message, 'notifyBulkPartial:0|2|notifyCertificate');
});

test('a test overtaken while it reads the panel does not put the bar back up', async () => {
  let refuse = true;
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'login') {
      return refuse ? response({ success: false, error: { code: 400 } })
        : response({ success: true, data: { sid: 'new-sid' } });
    }
    if (method === 'list') return response({ success: true, data: { tasks: [] } });
    return success();
  });
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection }; popupReady = true;');

  // One refused test first, so that every later read of the panel record is the
  // popup's own: the background reads it once per page life and remembers the
  // answer, and hooking that read would suspend a request the test below waits
  // on.
  await p.evaluate('attemptConnect(undefined, { deliberate: true })');

  const session = h.browser.storage.session;
  const read = session.get.bind(session);
  let overtaken = false;
  session.get = async (keys) => {
    const value = await read(keys);
    // The window the older test sits in: told "failed", and now reading the
    // panel in order to show it. A newer test goes through inside that read.
    if (!overtaken && keys && 'connectionProblem' in keys) {
      overtaken = true;
      refuse = false;
      await p.evaluate('attemptConnect(undefined, { deliberate: true })');
    }
    return value;
  };

  await p.evaluate('attemptConnect(undefined, { deliberate: true })');
  assert.equal(overtaken, true, 'the panel read is where the older test waits');

  // The older answer is about a connection that has since been made. Pronounced
  // after the wait, it barred the working session and wrote "connection
  // failed" over the word Connected.
  assert.equal(p.evaluate('connectBlocked'), false);
  assert.match(p.nodes.get('statusText').textContent, /^connected/);
});

test('an overtaken test cannot restore its certificate panel or change tabs', async () => {
  for (const ready of [false, true]) {
    let refuse = true, h;
    h = await background(async (url, options) => {
      if (refuse) {
        h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
          originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
        throw new TypeError('NetworkError');
      }
      const method = options.body?.get('method');
      if (method === 'login') return response({ success: true, data: { sid: 'new-sid' } });
      if (method === 'list') return response({ success: true, data: { tasks: [] } });
      return success();
    });
    const p = popup(h);
    p.context.savedConnection = defaults;
    p.evaluate('settings = { ...settings, ...savedConnection };');
    await p.evaluate('attemptConnect(undefined, { deliberate: true })');
    p.evaluate("activateTab('tasks'); document.getElementById('connectionSection').open = false;");
    p.nodes.get('connectionProblem').hidden = true;
    p.context.ready = ready;
    p.evaluate('popupReady = ready;');
    const read = h.browser.storage.session.get.bind(h.browser.storage.session);
    let overtaken = false;
    h.browser.storage.session.get = async keys => {
      const value = await read(keys);
      if (!overtaken && keys && 'connectionProblem' in keys && p.evaluate('connectSeq === newestConnectAnswered')) {
        overtaken = true;
        refuse = false;
        await p.evaluate('attemptConnect(undefined, { deliberate: true })');
      }
      return value;
    };
    await p.evaluate('attemptConnect(undefined, { deliberate: true })');
    await until(() => !p.evaluate('refreshInFlight'));
    assert.equal(overtaken, true);
    assert.equal(h.data.session.connectionProblem, undefined);
    assert.equal(p.evaluate('connectBlocked'), false);
    assert.match(p.nodes.get('statusText').textContent, /^connected/);
    assert.equal(p.nodes.get('connectionProblem').hidden, true);
    assert.equal(p.evaluate('activeTab'), 'tasks');
    assert.equal(p.nodes.get('connectionSection').open, false);
  }
});

test('a slower panel read cannot overwrite a newer reason or a cleared panel', async () => {
  for (const cleared of [false, true]) {
    const oldProblem = { origin: `https://${defaults.host}:${defaults.port}`,
      certificate: true, reason: 'older reason', reasonAt: 1, at: 1 };
    const h = makeBrowser({ session: { connectionProblem: oldProblem } });
    const p = popup(h);
    p.context.savedConnection = defaults;
    p.evaluate('settings = { ...settings, ...savedConnection };');
    const read = h.browser.storage.session.get.bind(h.browser.storage.session);
    const slowRead = deferred();
    let held = false;
    h.browser.storage.session.get = async keys => {
      const value = await read(keys);
      if (!held && keys && 'connectionProblem' in keys) {
        held = true;
        await slowRead.promise;
      }
      return value;
    };
    const older = p.api.syncConnectionProblem();
    await until(() => held);
    if (cleared) await h.browser.storage.session.remove('connectionProblem');
    else await h.browser.storage.session.set({ connectionProblem: { ...oldProblem, reason: 'newer reason', at: 2 } });
    await p.api.syncConnectionProblem();
    slowRead.resolve();
    await older;
    assert.equal(p.nodes.get('connectionProblem').hidden, cleared);
    if (!cleared) assert.equal(p.nodes.get('connProblemReason').textContent, 'connProblemReason:newer reason');
  }
});

test('a storage refresh does not suppress the current test opening its panel', async () => {
  const h = makeBrowser({ session: { connectionProblem: {
    origin: `https://${defaults.host}:${defaults.port}`,
    certificate: true, reason: CERT_PROSE, reasonAt: 1, at: 1,
  } } });
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate("settings = { ...settings, ...savedConnection }; newestConnectAnswered = 1; activateTab('tasks');");
  const held = deferred();
  const read = h.browser.storage.session.get.bind(h.browser.storage.session);
  let reading = false;
  h.browser.storage.session.get = async keys => {
    const value = await read(keys);
    if (!reading && keys && 'connectionProblem' in keys) {
      reading = true;
      await held.promise;
    }
    return value;
  };

  const opening = p.evaluate('revealConnectionProblem(1)');
  await until(() => reading);
  // A storage event refreshes the panel, but no newer test has superseded the
  // user's request to open it. The navigation must still take place.
  await p.api.syncConnectionProblem();
  held.resolve();
  await opening;
  assert.equal(p.nodes.get('connectionProblem').hidden, false);
  assert.equal(p.nodes.get('connProblemReason').textContent, `connProblemReason:${CERT_PROSE}`);
  assert.equal(p.evaluate('activeTab'), 'settings');
  assert.equal(p.nodes.get('connectionSection').open, true);
});

test('the connection panel shows the whole reason, and only for this address', async () => {
  const origin = `https://${defaults.host}:${defaults.port}`;
  const h = makeBrowser({ session: { connectionProblem: {
    origin, certificate: true, reason: CERT_PROSE, reasonAt: 1, at: 1 } } });
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');

  await p.api.syncConnectionProblem();
  assert.equal(p.nodes.get('connectionProblem').hidden, false);
  assert.equal(p.nodes.get('connProblemTitle').textContent, 'connProblemSecure');
  assert.equal(p.nodes.get('connProblemAddress').textContent, `connProblemAddress:${origin}`);
  assert.equal(p.nodes.get('connProblemReason').textContent, `connProblemReason:${CERT_PROSE}`);
  assert.equal(p.nodes.get('connProblemAdvice').textContent, 'connProblemAdvice');
  assert.equal(p.nodes.get('connProblemLast').textContent, '',
    'the last attempt is the one being explained — no need to say so');

  // The same reason, after an attempt that only timed out. Still the one thing
  // to act on, but named as the last precise word rather than as a cause just
  // confirmed again.
  await h.browser.storage.session.set({ connectionProblem: {
    origin, certificate: false, reason: CERT_PROSE, reasonAt: 1, at: 2 } });
  await p.api.syncConnectionProblem();
  assert.equal(p.nodes.get('connProblemTitle').textContent, 'connectionFailed');
  assert.equal(p.nodes.get('connProblemLast').textContent, 'connProblemLastAttempt');
  assert.equal(p.nodes.get('connProblemReason').textContent, `connProblemEarlier:${CERT_PROSE}`);

  // A failure at an address this popup is no longer configured for explains
  // nothing about the one it is.
  await h.browser.storage.session.set({ connectionProblem: {
    origin: 'https://other-nas.example:5001', certificate: true, reason: CERT_PROSE, reasonAt: 1, at: 3 } });
  await p.api.syncConnectionProblem();
  assert.equal(p.nodes.get('connectionProblem').hidden, true);
});

test('a connection test somebody pressed puts the whole reason in front of them', async () => {
  const h = await refusing(CERT_PROSE);
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');

  // The popup signing in by itself, as it does on opening. That failure says
  // its short piece in a notification; unfolding a section under someone's
  // hands would be the extension rearranging the furniture.
  await p.evaluate('attemptConnect()');
  assert.equal(p.document.getElementById('connectionSection').open, false);

  // The Test button. This one was asked for, so the reason goes on screen where
  // the address it is about is set up.
  await p.nodes.get('btnTest').listeners.click();
  assert.equal(p.document.getElementById('connectionSection').open, true);
  assert.equal(p.nodes.get('connectionProblem').hidden, false);
  assert.equal(p.nodes.get('connProblemReason').textContent, `connProblemReason:${CERT_PROSE}`);
});

test('an ordinary network failure keeps its retries and its wording', async () => {
  // Symbolic, not prose — Firefox names these rather than describing them.
  const h = await refusing('NS_ERROR_NET_TIMEOUT');
  const err = await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);

  assert.equal(err.message, 'errNasUnreachable');
  assert.equal(err.nasUnreachable, true);
  assert.equal(err.deliveryUnknown, true);
  assert.equal(h.requests.length, 4, 'a sleeping NAS is still worth waiting for');
});

test('a failure belonging to a tab is never adopted as ours', async () => {
  // The NAS's own web interface, open in a window, fails against the same
  // certificate. Its refusal is not an answer to anything asked here.
  const h = await refusing(CERT_PROSE, { tabId: 7 });
  const err = await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);

  assert.equal(err.message, 'errNasUnreachable');
  assert.equal(err.certificateError, undefined);
});

test('prose over plain http is not called a certificate problem', async () => {
  const h = await refusing(CERT_PROSE);
  const err = await h.api.apiFetch(`http://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);

  // Without TLS there is no certificate to be wrong, whatever arrived.
  assert.equal(err.message, 'errNasUnreachable');
  assert.equal(err.certificateError, undefined);
});

test('a NAS moved to another port is still heard', async () => {
  const h = await refusing(CERT_PROSE);
  await h.api.apiFetch(`https://${defaults.host}:${defaults.port}/webapi/auth.cgi`, {}).catch(() => {});

  // Same scheme and host, so the filter pattern does not change — and a pattern
  // cannot carry a port at all. What decides is the address actually in flight.
  const err = await h.api.apiFetch(`https://${defaults.host}:5000/webapi/auth.cgi`, {})
    .then(() => null, caught => caught);
  assert.equal(err.certificateError, true);
});

test('a farewell to the old NAS does not deafen the new one', async () => {
  // Switching NAS: the sign-in at the new address is under way when a logout
  // leaves for the old one. Both are watched, or the later registration
  // silently unwatches the earlier host and its refusals vanish.
  const held = deferred();
  let h;
  h = await background(async (url) => {
    // The sign-in is still out when the logout registers its own host. Its
    // refusal arrives only afterwards — which is the whole point: a listener
    // re-registered for the newer host alone has stopped watching this one.
    if (url.includes('new-nas')) {
      await held.promise;
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    }
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const signIn = h.api.apiFetch(`https://new-nas.example:5001/webapi/auth.cgi`, {}, { repeatable: false })
    .then(() => null, caught => caught);
  await until(() => h.requests.length === 1);
  await h.api.apiFetch(`https://old-nas.example:5001/webapi/auth.cgi`, {}, { repeatable: false })
    .catch(() => {});
  held.resolve();

  assert.equal((await signIn).certificateError, true, 'the new NAS is still heard');
  assert.deepEqual(plain(h.data.session.transportWatch.patterns).sort(),
    ['https://new-nas.example/*', 'https://old-nas.example/*']);
});

test('IPv6 hosts with and without brackets work for discovery, login and waking', async () => {
  for (const host of ['fd00::1', '[fd00::1]']) {
    const h = await background(async (url, options) => {
      const target = new URL(url);
      assert.equal(target.hostname, '[fd00::1]');
      assert.equal(target.port, '5001');
      if (target.pathname.endsWith('/query.cgi')) return response({ success: true, data: {
        'SYNO.API.Auth': { path: 'auth.cgi', minVersion: 1, maxVersion: 7 },
        'SYNO.DownloadStation.Task': { path: 'DownloadStation/task.cgi', minVersion: 1, maxVersion: 3 },
      } });
      assert.equal(options.body.get('method'), 'login');
      return response({ success: true, data: { sid: 'ipv6-sid' } });
    }, { local: { host }, session: { sid: null, apiPaths: null } });
    assert.equal((await h.send({ action: 'testConnection' })).success, true);
    await h.evaluate('wakeNas()');
    assert.deepEqual(h.requests.map(r => new URL(r.url).pathname),
      ['/webapi/query.cgi', '/webapi/auth.cgi', '/webapi/query.cgi']);
  }
});

test('IPv6 certificate errors reach the matching connection panel', async () => {
  for (const host of ['fd00::1', '[fd00::1]']) for (const port of [443, 5001]) {
    let h;
    h = await background(async url => {
      const about = { url, tabId: -1, type: 'xmlhttprequest', requestId: 'ipv6-request',
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') };
      h.webRequest.onBeforeRequest.emit(about);
      h.webRequest.onErrorOccurred.emit({ ...about, error: CERT_PROSE });
      throw new TypeError('NetworkError');
    }, { local: { host, port } });
    assert.equal((await h.send({ action: 'testConnection' })).certificateError, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, `https://[fd00::1]:${port}/webapi/auth.cgi`);
    assert.deepEqual(plain(h.errorFilters), [{ urls: ['https://[fd00::1]/*'] }]);
    const origin = new URL(`https://[fd00::1]:${port}`).origin;
    assert.equal(h.data.session.connectionProblem.origin, origin);
    const p = popup(h);
    p.context.savedConnection = { ...defaults, host, port };
    p.evaluate('settings = { ...settings, ...savedConnection };');
    await p.api.syncConnectionProblem();
    assert.equal(p.nodes.get('connectionProblem').hidden, false);
    assert.equal(p.nodes.get('connProblemAddress').textContent, `connProblemAddress:${origin}`);
  }
});

test('a NAS on the scheme\'s default port is still recognised', async () => {
  let h;
  h = await background(async (url) => {
    // The settings always name a port; the browser reports the address with the
    // default one dropped, as the URL standard says it must. Compared as raw
    // text those are two addresses, and the refusal belonged to neither.
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1,
      url: String(url).replace(':443', ''),
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });
  const err = await h.api.apiFetch(`https://${defaults.host}:443/webapi/auth.cgi`, {}, { repeatable: false })
    .then(() => null, caught => caught);
  assert.equal(err.certificateError, true);
});

test('a refusal during a response body is not handed to the next request', async () => {
  const endpoint = `https://${defaults.host}:${defaults.port}/webapi/query.cgi`;
  const bodyDone = deferred(), nextFails = deferred();
  let h, calls = 0;
  h = await background(async (url) => {
    calls += 1;
    // The first answer has its headers in and its body still coming.
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => {
        await bodyDone.promise;
        h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
          originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
        throw new TypeError('NetworkError when attempting to fetch resource.');
      } };
    }
    await nextFails.promise;
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const first = await h.api.apiFetch(endpoint, {}, { repeatable: false });
  const second = h.api.apiFetch(endpoint, {}, { repeatable: false }).then(() => null, caught => caught);
  await until(() => h.requests.length === 2);
  const reading = first.json().then(() => null, caught => caught);
  bodyDone.resolve();
  await reading;
  nextFails.resolve();

  // The two overlapped, so the later one cannot know the refusal was not its
  // own - and must not lose its retries to a verdict it did not earn.
  const err = await second;
  assert.equal(err.certificateError, undefined);
  assert.equal(err.nasUnreachable, true);
});

/**
 * An answer whose body nobody reads still has to hold its address.
 *
 * `first` decides how that answer arrives: the wake probe asks for one it never
 * reads, and a refused status is thrown away before anyone could. Both used to
 * free the address at the headers, so the next request to the same endpoint
 * started uncontended and inherited a refusal raised by the earlier body.
 */
for (const [name, first] of [
  ['an answer nobody reads', { ok: true, status: 200 }],
  ['an answer refused on its status', { ok: false, status: 404 }],
]) {
  test(`${name} holds its address until the body is done`, async () => {
    const endpoint = `https://${defaults.host}:${defaults.port}/webapi/query.cgi`;
    const bodyDone = deferred(), nextFails = deferred();
    let h, calls = 0;
    h = await background(async (url) => {
      calls += 1;
      if (calls === 1) {
        return { ...first, text: async () => {
          await bodyDone.promise;
          h.webRequest.onErrorOccurred.emit({ error: 'SSL_ERROR_BAD_MAC_READ',
            type: 'xmlhttprequest', tabId: -1, url,
            originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
          throw new TypeError('NetworkError when attempting to fetch resource.');
        } };
      }
      await nextFails.promise;
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });

    await h.evaluate(`fetchOnce(${JSON.stringify(endpoint)}, {}, 8000, { holdBody: false })`)
      .catch(() => {});
    // Discovery starts on the same endpoint while that body is still coming.
    const second = h.api.apiFetch(endpoint, {}, { repeatable: false })
      .then(() => null, caught => caught);
    await until(() => h.requests.length === 2);
    bodyDone.resolve();
    await until(() => h.data.session.lastTransportError);
    nextFails.resolve();

    const err = await second;
    assert.equal(err.certificateError, undefined, 'the earlier body\'s refusal is not this one\'s');
    assert.equal(err.nasUnreachable, true, 'and its own retries stay available');
  });
}

test('a watch that has been overtaken does not sign the new session out', async () => {
  let listAsked = false;
  const h = await background(async () => {
    listAsked = true;
    return response({ success: true, data: { tasks: [] } });
  });
  h.data.local.keepaliveEnabled = false;

  // Hold the settings read that sits between the empty list and the sign-out.
  // Nothing is being watched, so notifyWatchFinished returns without reading
  // anything and this is the next read the poll makes.
  const held = deferred();
  const read = h.browser.storage.local.get;
  let holding = false;
  h.browser.storage.local.get = async (keys) => {
    if (listAsked && !holding) { holding = true; await held.promise; }
    return read(keys);
  };

  const polling = h.evaluate('pollDownloads()');
  await until(() => holding);
  // The NAS is switched and signed into while that read is out, and the popup
  // is closed again — exactly the window the sign-out used to fall into.
  h.evaluate('sessionEpoch += 1; signInsAccepted += 1; cachedSid = "new-sid";');
  held.resolve();
  await polling;

  assert.equal(h.evaluate('cachedSid'), 'new-sid', 'the new session is left alone');
  assert.ok(!h.requests.some(request => request.body.method === 'logout'),
    'and is never handed back to the NAS');
});

test('a task action keeps its uncertainty and still names the refused certificate', async () => {
  let h;
  h = await background(async (url) => {
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const answer = await h.send({ action: 'pauseTask', id: 'dbid_1', connection: h.connection });

  assert.equal(answer.success, false);
  // Both: what is unknown, and what the browser actually refused. The reason
  // used to be replaced by the uncertainty and lost.
  assert.equal(answer.deliveryUnknown, true);
  assert.match(answer.error.message, /^actionResultUnknown /);
  assert.ok(answer.error.message.includes(CERT_PROSE), 'the browser reason is carried along');
});

test('a late keepalive list does not wipe a newer badge', async () => {
  const h = await background(async () => response({ success: true, data: { tasks: [] } }));
  // A newer list — the popup's, typically — has already answered.
  h.evaluate('newestListAnswered = 999; sessionUsed = { sid: null, at: 0 };');
  const before = h.badges.length;

  await h.evaluate('runKeepalive()');

  assert.ok(h.requests.length > 0, 'the keepalive really asked');
  assert.equal(h.badges.length, before, 'but its stale, empty list is not taken');
});

/**
 * Send the delete, switch the NAS while its answer is still on the way, and let
 * the answer arrive. What that answer says about this one task is the whole
 * question: `success: true` is the envelope, and an accepted call can still
 * carry a refusal for the task inside it, or say nothing about it at all.
 */
async function switchedAwayFromDelete(answer) {
  const uri = 'https://download.example/a';
  const removing = deferred();
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'delete') return removing.promise;
    return success();
  });
  const retrying = h.api.apiRetryTask('dbid_1', uri, '').then(r => r, caught => caught);
  await until(() => h.requests.some(request => request.body.method === 'delete'));
  h.evaluate('sessionEpoch += 1;');
  removing.resolve(response(answer));
  return { uri, h, out: await retrying };
}

test('a NAS switched after the delete went through still keeps the link', async () => {
  const { uri, h, out } = await switchedAwayFromDelete(
    { success: true, data: [{ id: 'dbid_1', error: 0 }] });

  // The task is gone and it held the only copy of this link. Treating the
  // switch as "nothing happened" let both go.
  assert.equal(out.linkKept, true);
  assert.match(out.error.message, /retryLinkKeptSwitched/);
  assert.equal(h.data.session.bulkDraft, uri, 'the link is back in the list');
});

test('a NAS switched away from does not report a delete it refused', async () => {
  // Accepted call, refused task: the one reply shape that looks like a success
  // from the outside. It counted as a confirmed deletion, and the retry
  // announced the removal of a task still sitting there with its link in it.
  const { h, out } = await switchedAwayFromDelete(
    { success: true, data: [{ id: 'dbid_1', error: 405 }] });

  assert.equal(out.linkKept, undefined);
  assert.equal(out.connectionChanged, true);
  // Nothing was lost, so nothing is rescued — the same as a refusal outside a
  // connection change, which is handed on exactly as it came.
  assert.equal(h.data.session.bulkDraft, undefined, 'the task still holds this link');
});

test('a NAS switched away from keeps a delete it said nothing about unconfirmed', async () => {
  const { uri, h, out } = await switchedAwayFromDelete({ success: true });

  // No task results at all: the delete may well have run, so the link is
  // rescued — but "the task was removed" is a claim the NAS never made.
  assert.equal(out.linkKept, true);
  assert.match(out.error.message, /^retryLinkKeptUnsent/, out.error.message);
  assert.equal(h.data.session.bulkDraft, uri, 'the link is back in the list');
});

test('a retry that is refused by the certificate says so as well', async () => {
  const uri = 'https://download.example/a';
  let h;
  h = await background(async (url, options) => {
    // The delete goes through; the replacement meets the certificate.
    if (options.body?.get('method') === 'delete') {
      return response({ success: true, data: [{ id: 'dbid_1', error: 0 }] });
    }
    if (options.body?.get('method') === 'create') {
      h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
        originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }
    return success();
  });

  const out = await h.api.apiRetryTask('dbid_1', uri, '').then(r => r, caught => caught);

  // Both: the link is kept and its outcome open, and the reason the user can
  // act on. The reason used to be dropped for the kept-link wording entirely.
  assert.equal(out.linkKept, true);
  assert.match(out.error.message, /retryLinkKeptUnknown/);
  assert.ok(out.error.message.includes(CERT_PROSE), 'the browser reason is carried along');
});

test('seeding torrents can be paused', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'list') {
      return response({ success: true, data: { tasks: [{ id: 'dbid_1', status: 'seeding' }] } });
    }
    return response({ success: true, data: [{ id: 'dbid_1', error: 0 }] });
  });

  // Deliberately not in WORKING_STATUSES — seeding never ends by itself, so the
  // watch must not wait for it. That is a different question from whether the
  // NAS can be told to stop, and it can.
  assert.equal(h.evaluate('canPauseTask("seeding")'), true);

  const result = await h.send({ action: 'pauseAll', connection: h.connection });
  assert.equal(result.success, true);
  // It used to answer "done, 0 affected" while the upload carried on.
  assert.equal(result.affected, 1);
  assert.match(h.requests.find(request => request.body.method === 'pause').body.id, /dbid_1/);
});

test('an outcome from the NAS left behind does not block the new one', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('Connection reset');
    if (method === 'list')  return response({ success: false, error: { code: 105 } });
    if (method === 'login') return response({ success: false, error: { code: 400 } });
    return success();
  });
  // Recorded against the NAS that was configured when the add began. The
  // version is the one still current, so the key is what has to do the work.
  await h.api.recordForPopup(
    await h.api.addDownloadTasksBulk(['https://download.example/a'], ''),
    h.connection, await h.api.readConnectionVersion());

  const p = popup(h);
  // By the time it is read, the user is on another NAS and signed in there.
  p.context.savedConnection = { ...defaults, host: 'new-nas.example' };
  p.evaluate('settings = { ...settings, ...savedConnection };');
  p.evaluate("activateTab('tasks');");
  await p.api.consumeLastAdd();

  // The links still say what happened to them — that outcome is theirs.
  assert.match(p.evaluate('linksMessageEl.textContent'), /errLoginFailed/);
  // But the new connection is not shut out over a refusal from the old one.
  assert.equal(p.evaluate('connectBlocked'), false);
  assert.notEqual(p.nodes.get('statusText').textContent, 'connectionFailed');
});

test('a changed password retires an outcome about the old one', async () => {
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('Connection reset');
    if (method === 'list')  return response({ success: false, error: { code: 105 } });
    if (method === 'login') return response({ success: false, error: { code: 400 } });
    return success();
  });
  // Taken when the add is asked for, as the message handler takes it.
  const version = await h.api.readConnectionVersion();
  const outcome = await h.api.addDownloadTasksBulk(['https://download.example/a'], '');
  // The password is corrected while the refusal is still being written up, and
  // the new one signs in perfectly well.
  await h.evaluate('updateSettings({ connection: { password: "new-password" } })');
  await h.api.recordForPopup(outcome, h.connection, version);

  const p = popup(h);
  p.context.savedConnection = { ...defaults, password: 'new-password' };
  p.evaluate('settings = { ...settings, ...savedConnection };');
  p.evaluate("activateTab('tasks');");
  await p.api.consumeLastAdd();

  // Same NAS, same account: the key cannot tell these two apart, and it must
  // not try — it is what task ids are read against.
  assert.equal(p.evaluate('connectionKey(settings)'), h.connection);
  // The links still say what happened to them...
  assert.match(p.evaluate('linksMessageEl.textContent'), /errLoginFailed/);
  // ...but a password nobody uses any more does not bar the one that works.
  assert.equal(p.evaluate('connectBlocked'), false);
  assert.notEqual(p.nodes.get('statusText').textContent, 'connectionFailed');
});

test('a late keepalive refusal does not clear a newer session', async () => {
  const listing = deferred();
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'list')  return listing.promise;
    if (method === 'login') return response({ success: true, data: { sid: 'new-sid' } });
    return success();
  });
  // Due a keepalive: nothing of this session's own has been seen recently.
  h.evaluate('sessionUsed = { sid: null, at: 0 };');
  const keeping = h.evaluate('runKeepalive()');
  await until(() => h.requests.some(request => request.body.method === 'list'));

  // "Test connection" goes through while that list is still away.
  assert.equal((await h.send({ action: 'testConnection' })).success, true);
  assert.equal(h.data.session.sid, 'new-sid');

  // Only now does the old session's list come back, refused for being unknown.
  listing.resolve(response({ success: false, error: { code: 119 } }));
  await keeping;

  // That answer is about a session nobody is using. Taken for the current one,
  // it threw away a working sign-in and getStatus reported "not connected".
  assert.equal(h.evaluate('cachedSid'), 'new-sid');
  assert.equal(h.data.session.sid, 'new-sid');
});

test('a failed response body from the old NAS does not count against the new watch', async () => {
  const body = deferred();
  let reading = false, currentFails = false;
  const h = await background(async (url, options) => {
    const method = options.body?.get('method');
    if (method === 'list' && new URL(url).hostname === defaults.host) {
      return { ok: true, status: 200, json: async () => {
        reading = true;
        await body.promise;
        throw new SyntaxError('Old NAS body was truncated');
      } };
    }
    if (method === 'login') return response({ success: true, data: { sid: 'new-sid' } });
    if (method === 'list') {
      if (currentFails) throw new TypeError('New NAS temporarily unavailable');
      return response({ success: true, data: { tasks: [{ id: 'new-task', status: 'downloading' }] } });
    }
    return success();
  });
  const polling = h.evaluate('pollDownloads()');
  await until(() => reading);
  await h.evaluate('updateSettings({ connection: { host: "new-nas.example" } })');
  assert.equal((await h.send({ action: 'testConnection' })).success, true);
  assert.equal((await h.send({ action: 'listTasks' })).success, true);
  assert.equal(h.evaluate('pollFailures'), 0);
  body.resolve();
  await polling;
  assert.equal(h.evaluate('pollFailures'), 0);
  assert.deepEqual(plain(h.evaluate('[...watchedIds]')), ['new-task']);
  assert.ok(h.alarmCalls.at(-1).created, 'the new watch remains armed');
  assert.equal(h.data.session.sid, 'new-sid');

  // Failures of the current NAS must still count towards its own limit.
  currentFails = true;
  await h.evaluate('pollDownloads()');
  assert.equal(h.evaluate('pollFailures'), 1);
});

test('a NAS that answers 503 is waited for, and the wait is announced', async () => {
  let probes = 0;
  const h = await background(async () => {
    // Services still starting: 502/503 until they are up — see fetchOnce.
    if (++probes < 3) return { ok: false, status: 503 };
    return success();
  });

  await h.evaluate('wakeNas({ announce: true })');

  assert.equal(probes, 3, 'the probe was repeated rather than given up on');
  assert.ok(h.notifications.some(note => note.message === 'notifyWaking'),
    'and the wait was said out loud');
});

test('a rebuilt list keeps the keyboard on the same control', () => {
  const p = popup();
  // Hand-built controls: the stub document has no tree to rebuild, and what is
  // under test is which control the keyboard is given back, not the rendering.
  const outcome = p.evaluate(`
    const button = (dataset) => ({ dataset, disabled: false, hidden: false,
      focus(options) { this.given = options ?? {}; } });
    const rebuild = (held, fresh) => {
      document.activeElement = held;
      keepingFocus({ contains: el => el === held, querySelectorAll: () => fresh }, () => {});
      return fresh.map(control => control.given !== undefined);
    };

    const held  = button({ field: 'pauseBtn', taskId: 'dbid_1' });
    // The same action on another task, the same task with another action, and
    // then the one that means what the keyboard was on.
    const fresh = [button({ field: 'pauseBtn', taskId: 'dbid_9' }),
                   button({ field: 'removeBtn', taskId: 'dbid_1' }),
                   button({ field: 'pauseBtn', taskId: 'dbid_1' })];
    const taken = rebuild(held, fresh);
    // Not a scroll the user asked for: focus() would otherwise pull the list
    // back up to this button at every refresh.
    const kept = fresh[2].given.preventScroll === true;

    // A control that is gone takes the focus with it rather than handing it to
    // whatever happens to sit in its place.
    const orphaned = [button({ field: 'pauseBtn', taskId: 'dbid_9' })];
    const stolen = rebuild(held, orphaned)[0];

    // The arrows carry the page they would turn to, so "next" on page 1 and the
    // button labelled "2" read alike. The keyboard moved onto the number, and
    // Enter then re-selected page 2 instead of going on to page 3.
    const onNext = button({ nav: 'next', page: '2' });
    const pager  = [button({ nav: 'prev', page: '0' }), button({ page: '2' }),
                    button({ nav: 'next', page: '3' })];
    const paging = rebuild(onNext, pager);

    ({ taken, kept, stolen, paging });
  `);

  assert.deepEqual(plain(outcome), {
    taken: [false, false, true], kept: true, stolen: false,
    paging: [false, false, true],
  });
});

test('a test that goes through takes down a bar raised behind its back', async () => {
  const h = await background(async (_, options) => {
    if (options.body?.get('method') === 'login') {
      return response({ success: true, data: { sid: 'new-sid' } });
    }
    return success();
  });
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');

  const testing = p.nodes.get('btnTest').listeners.click();
  // Parked on its answer. An older add's refusal now comes in through the one
  // door that raises the bar — the door applyAddOutcome uses.
  p.evaluate("showConnectFailure({ error: { message: 'errLoginFailed' } });");
  assert.equal(p.evaluate('connectBlocked'), true);
  await testing;
  await until(() => !p.evaluate('refreshInFlight'));

  // The test answered after that refusal, and it answered "connected". The bar
  // used to stay up behind the word: Refresh sent nothing at all.
  assert.equal(p.evaluate('connectBlocked'), false);
  assert.match(p.nodes.get('statusText').textContent, /^connected/);
  assert.ok(h.requests.some(request => request.body.method === 'list'), 'the list is asked for');
});

test('a delayed add-result snapshot cannot block a connection that changed while it was read', async () => {
  for (const changedBy of ['popup login', 'popup login before version event', 'background login', 'password change']) {
    const held = deferred();
    const h = await background(async (_, options) => {
      if (options.body?.get('method') === 'login') {
        return response({ success: true, data: { sid: 'new-sid' } });
      }
      return response({ success: true, data: { tasks: [] } });
    });
    const uri = 'https://download.example/a';
    await h.api.recordForPopup({ success: false, added: 0, failed: 1, uncertain: 1,
      namedReason: true, blockConnection: true, errorMessage: 'old login failure',
      failedUrls: [uri] }, h.connection, await h.api.readConnectionVersion());
    const p = popup(h);
    p.context.savedConnection = defaults;
    p.evaluate('settings = { ...settings, ...savedConnection }; popupReady = true;');
    const read = h.browser.storage.session.get.bind(h.browser.storage.session);
    let reading = false;
    h.browser.storage.session.get = async keys => {
      const snapshot = await read(keys);
      if (!reading && keys && 'lastAdd' in keys) {
        reading = true;
        await held.promise;
      }
      return snapshot;
    };
    const consuming = p.api.consumeLastAdd();
    await until(() => reading);
    const versionEvents = [];
    const emit = h.browser.storage.onChanged.emit.bind(h.browser.storage.onChanged);
    if (changedBy === 'popup login before version event') {
      h.browser.storage.onChanged.emit = (changes, area) => {
        if (area === 'session' && 'connectionVersion' in changes) {
          versionEvents.push([changes, area]);
          return [];
        }
        return emit(changes, area);
      };
    }
    if (changedBy.startsWith('popup login')) {
      assert.equal(await p.evaluate('attemptConnect()'), true);
      await until(() => !p.evaluate('refreshInFlight'));
    } else if (changedBy === 'background login') {
      assert.equal((await h.send({ action: 'testConnection' })).success, true);
    } else {
      await h.evaluate('updateSettings({ connection: { password: "corrected-password" } })');
    }
    assert.ok(await h.api.readConnectionVersion() > 0);
    assert.equal(p.evaluate('connectBlocked'), false);
    held.resolve();
    await consuming;
    assert.equal(p.evaluate('connectBlocked'), false, changedBy);
    if (changedBy.startsWith('popup login')) {
      assert.match(p.nodes.get('statusText').textContent, /^connected/);
      assert.equal(h.data.session.sid, 'new-sid');
    }
    assert.equal(p.nodes.get('bulkLinks').value, uri, 'the failed link is still displayed');
    assert.match(p.evaluate('linksMessageEl.textContent'), /old login failure/);
    assert.equal(h.data.session.lastAdd, undefined);
    if (changedBy === 'popup login before version event') {
      assert.equal(versionEvents.length, 1);
      versionEvents.forEach(args => emit(...args));
    }
  }
});

test('current add failures still block when version events lag behind storage', async () => {
  for (const storedVersion of [3, 4]) {
    const h = await background();
    await h.api.recordForPopup({ success: false, added: 0, failed: 1,
      failedUrls: ['https://download.example/a'], blockConnection: true,
      namedReason: true, errorMessage: 'current login failure' }, h.connection, storedVersion);
    h.data.session.connectionVersion = storedVersion;
    const p = popup(h);
    p.context.savedConnection = defaults;
    p.evaluate('settings = { ...settings, ...savedConnection };');
    // A reader can already see version 4 while the latest delivered event
    // still describes version 3. Neither that case nor equal versions is stale.
    h.browser.storage.onChanged.emit({ connectionVersion: { newValue: 3 } }, 'session');
    await p.api.consumeLastAdd();
    assert.equal(p.evaluate('connectBlocked'), true, String(storedVersion));
    assert.equal(p.nodes.get('statusText').textContent, 'connectionFailed');
    assert.match(p.evaluate('linksMessageEl.textContent'), /current login failure/);
  }
});

test('a sign-in that succeeds later overtakes the older refusal', async () => {
  let refusing = true;
  const h = await background(async (_, options) => {
    const method = options.body?.get('method');
    if (method === 'create') throw new TypeError('Connection reset');
    if (method === 'list')  return response({ success: false, error: { code: 105 } });
    if (method === 'login') {
      return refusing ? response({ success: false, error: { code: 400 } })
        : response({ success: true, data: { sid: 'new-sid' } });
    }
    return success();
  });
  const version = await h.api.readConnectionVersion();
  const outcome = await h.api.addDownloadTasksBulk(['https://download.example/a'], '');
  // Whatever was wrong is put right — a code typed, a locked account released,
  // the NAS woken — and Test goes through. Nothing in the settings changes, so
  // the connection is the same one from beginning to end.
  refusing = false;
  assert.equal((await h.send({ action: 'testConnection' })).success, true);
  // Only now does the add's refusal reach a popup.
  await h.api.recordForPopup(outcome, h.connection, version);

  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');
  p.evaluate("activateTab('tasks');");
  await p.api.consumeLastAdd();

  // The account has signed in since. A refusal from before that says nothing
  // about the session now standing, and it used to bar it all the same.
  assert.equal(p.evaluate('connectionKey(settings)'), h.connection);
  assert.match(p.evaluate('linksMessageEl.textContent'), /errLoginFailed/);
  assert.equal(p.evaluate('connectBlocked'), false);
  assert.notEqual(p.nodes.get('statusText').textContent, 'connectionFailed');
});

test('a certificate refusal during discovery is not an action that may have happened', async () => {
  let h;
  h = await background(async (url) => {
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  }, { session: { apiPaths: null } });

  const err = await h.api.apiBulkTaskAction('pause', ['dbid_1']).then(() => null, caught => caught);

  // Discovery is preparation, like the sign-in: only query.cgi went out, and no
  // pause was ever sent to be uncertain about.
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /query\.cgi/);
  assert.equal(err.deliveryUnknown, false);
  assert.equal(err.certificateError, true);
  assert.match(err.message, /^errCertificate:/);
});

test('the lookup stops at a refused certificate instead of asking out its budget', async () => {
  let h;
  h = await background(async (url) => {
    h.webRequest.onErrorOccurred.emit({ error: CERT_PROSE, type: 'xmlhttprequest', tabId: -1, url,
      originUrl: h.browser.runtime.getURL('_generated_background_page.html') });
    throw new TypeError('NetworkError when attempting to fetch resource.');
  });

  const out = await h.evaluate(
    "onNas(['https://download.example/a'], sessionEpoch, LINK_MATCH.taskKeys)");

  // The same wall as a refused sign-in: asking again cannot get past it. It
  // used to ask for the whole budget and then report the NAS as unreachable.
  assert.equal(out.refusal?.certificateError, true);
  assert.equal(h.requests.length, 1);
});

test('discovery passes a refused certificate on instead of guessing paths', async () => {
  const h = await refusing(CERT_PROSE);
  h.evaluate('cachedApiPaths = null;');

  // discoverApiPaths itself, not a request that merely resembles its own. Its
  // whole business is to swallow failures and carry on with the well-known
  // paths, and a refused certificate is the one failure that cannot be carried
  // on from — the next request goes to the same address and is refused again.
  const err = await h.evaluate(`discoverApiPaths('https', ${JSON.stringify(defaults.host)}, ${defaults.port})`)
    .then(() => null, caught => caught);
  assert.equal(err?.certificateError, true, 'discovery swallowed it');
  assert.equal(h.requests.length, 1);
});

test('a port that is not a port cannot replace the stored one', async () => {
  const h = await background();
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection };');

  for (const bad of ['70000', '-1', '1e3', '0', '', '5001.5']) {
    p.nodes.get('port').value = bad;
    assert.equal(p.evaluate('readPort()'), null, `accepted ${bad}`);
  }
  p.nodes.get('port').value = '5001';
  assert.equal(p.evaluate('readPort()'), 5001);

  // Saving with one of those in the field leaves the working port alone.
  for (const [id, value] of Object.entries({ protocol: 'https', host: 'old-nas.example',
    port: '70000', username: 'test-user', password: 'test-password' })) {
    p.document.getElementById(id).value = value;
  }
  await p.api.commitSettings({ commitConn: true });
  assert.equal(h.data.local.port, 5001);
});

test('a destination cleared on purpose stays cleared, and no draft leaves it alone', async () => {
  const h = await background();

  const cleared = popup(h);
  cleared.context.savedConnection = { ...defaults, defaultDestination: 'share/films' };
  cleared.evaluate('settings = { ...settings, ...savedConnection };');
  cleared.nodes.get('defaultDestination').value = 'share/films';
  await h.browser.storage.session.set({ destDraft: '' });
  await cleared.evaluate('loadConnDraft()');
  assert.equal(cleared.nodes.get('defaultDestination').value, '');

  await h.browser.storage.session.remove('destDraft');
  const untouched = popup(h);
  untouched.context.savedConnection = { ...defaults, defaultDestination: 'share/films' };
  untouched.evaluate('settings = { ...settings, ...savedConnection };');
  untouched.nodes.get('defaultDestination').value = 'share/films';
  await untouched.evaluate('loadConnDraft()');
  assert.equal(untouched.nodes.get('defaultDestination').value, 'share/films');
});

test('clearing finished downloads gets a list of its own', async () => {
  const h = popup();
  const answers = [];
  h.browser.runtime.sendMessage = () => { const pending = deferred(); answers.push(pending); return pending.promise; };

  const running = h.evaluate('refreshTasks()');   // asked before anything was cleared
  assert.equal(answers.length, 1);

  const clearing = h.nodes.get('btnClear').listeners.click();
  await until(() => answers.length === 2);        // the clear-completed message
  answers[1].resolve({ success: true, affected: 1 });
  // That older list still has the finished task on it, so it cannot be the last word.
  answers[0].resolve({ success: true, data: { tasks: [] } });

  await until(() => answers.length === 3);
  answers[2].resolve({ success: true, data: { tasks: [] } });
  await running;
  await clearing;
});

test('the Settings tab shows the version from the manifest', () => {
  const h = popup();
  h.browser.runtime.getManifest = () => ({ version: '9.8.7' });
  h.evaluate('applyStaticLocalization()');
  assert.equal(h.nodes.get('appVersion').textContent, 'appVersion:9.8.7');
});

test('release files parse, manifest assets exist and locale keys stay in sync', () => {
  for (const file of ['actions.js', 'background.js', 'content.js', 'popup/popup.js']) new vm.Script(read(file));
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '1.1.4');
  for (const file of [...manifest.background.scripts, ...manifest.content_scripts.flatMap(s => s.js),
    manifest.action.default_popup, ...Object.values(manifest.icons)]) assert.ok(fs.existsSync(path.join(root, file)), file);
  // The default policy for Manifest V3 rewrites http requests to https, which
  // is why a NAS on plain http could not be reached from here at all. Ours is
  // as strict as the default about scripts and leaves that rewrite out.
  // Pinned as a set, so a permission cannot be added or dropped unnoticed —
  // every one of these is something the review and the install prompt answer
  // for. webRequest is here for the browser's own reason a request failed,
  // which fetch is required by its standard never to disclose.
  assert.deepEqual([...manifest.permissions].sort(),
    ['alarms', 'contextMenus', 'notifications', 'storage', 'webRequest']);
  // Without this the content script reaches the top document only, and a magnet
  // link clicked inside an ordinary iframe never gets to the listener at all.
  assert.equal(manifest.content_scripts[0].all_frames, true);

  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'self'/);
  assert.ok(!csp.includes('upgrade-insecure-requests'), csp);

  const keys = Object.keys(JSON.parse(read('_locales/en/messages.json'))).sort();
  for (const locale of fs.readdirSync(path.join(root, '_locales'))) {
    assert.deepEqual(Object.keys(JSON.parse(read(`_locales/${locale}/messages.json`))).sort(), keys, locale);
  }
  const html = read('popup/popup.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of scripts.popup.matchAll(/(?:\$\(|getElementById\()'([^']+)'/g)) assert.ok(ids.includes(match[1]), match[1]);
  for (const match of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) assert.ok(keys.includes(match[1]), match[1]);

  // No file upload anywhere: no picker page, no message for it, no button.
  assert.ok(!fs.existsSync(path.join(root, 'popup/picker.html')));
  assert.ok(!scripts.background.includes('addTaskFiles'));
  assert.ok(!html.includes('type="file"'));
});
