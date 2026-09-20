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
  const alarmCalls = [], activeAlarms = new Set(), notifications = [];
  const runtime = { onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() };
  runtime.sendMessage = message => new Promise(resolve => runtime.onMessage.emit(message, {}, resolve));
  runtime.connect = port => { port.onDisconnect = event(); runtime.onConnect.emit(port); return port; };
  const browser = {
    storage: { local: area('local'), session: area('session'), onChanged: changes }, runtime,
    i18n: { getMessage: (key, subs = []) => key + (subs.length ? ':' + subs.join('|') : ''), getUILanguage: () => 'en' },
    alarms: { onAlarm: event(),
      create: (name, options) => { activeAlarms.add(name); alarmCalls.push({ name, options, created: true }); },
      clear: async name => { activeAlarms.delete(name); alarmCalls.push({ name, created: false }); return true; },
      get: async name => (activeAlarms.has(name) ? { name } : undefined) },
    notifications: { create: async info => { notifications.push(info); return 'notification'; } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {}, async openPopup() {} },
    contextMenus: { onShown: event(), onClicked: event(), removeAll: fn => fn(), create() {}, update() {}, refresh() {} },
  };
  return { browser, data, writes, alarmCalls, notifications };
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
  const context = vm.createContext({ browser: h.browser, URLSearchParams, FormData, Blob, Date: Clock,
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
  const api = evaluate('({ apiFetch, apiAddTaskBatch, addBatchWithDetail, apiBulkTaskAction, apiRetryTask, apiLogout, recordForPopup, addDownloadTasksBulk })');
  // What the popup would have received with its task list, and sends back with every action on it.
  const connection = evaluate('connectionKey')(h.data.local);
  return { ...h, context, evaluate, api, requests, connection, send: message => h.browser.runtime.sendMessage(message) };
}

function popup(h = makeBrowser()) {
  const { nodes, document } = domStub();
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({ browser: h.browser, document, Date,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
  });
  // Mount the actual event handlers and functions without automatic popup init.
  const source = scripts.popup.slice(0, scripts.popup.indexOf('(async function init() {'));
  vm.runInContext(scripts.actions + '\n' + source, context);
  const evaluate = code => vm.runInContext(code, context);
  const api = evaluate('({ setAddBusy, syncAddControls, loadAddBusy, consumeLastAdd, applyAddOutcome, loadDraft, sortTasks, calcProgress, updateTotalSpeed, commitSettings, addBulkLinks })');
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
  // popup, and the popup takes it the way it would on its own.
  await h.api.recordForPopup(
    await h.api.addDownloadTasksBulk(['https://download.example/a'], ''));

  const p = popup(h);
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

test('an unsaved HTTP choice still carries its warning after reopening', async () => {
  const h = makeBrowser();
  // Chosen, not saved, popup closed — the draft is all that is left of it.
  await h.browser.storage.session.set({ connDraft: { protocol: 'http' } });

  const p = popup(h);
  await p.evaluate('loadConnDraft()');
  assert.equal(p.nodes.get('protocol').value, 'http');
  assert.equal(p.nodes.get('protocolWarning').hidden, false);
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
  assert.equal(manifest.version, '1.1.3');
  for (const file of [...manifest.background.scripts, ...manifest.content_scripts.flatMap(s => s.js),
    manifest.action.default_popup, ...Object.values(manifest.icons)]) assert.ok(fs.existsSync(path.join(root, file)), file);
  // The default policy for Manifest V3 rewrites http requests to https, which
  // is why a NAS on plain http could not be reached from here at all. Ours is
  // as strict as the default about scripts and leaves that rewrite out.
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
