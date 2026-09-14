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
const scripts = { actions: read('actions.js'), background: read('background.js'), popup: read('popup/popup.js') };
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
      requests.push({ url, body: body ? Object.fromEntries(body.entries()) : {}, method: options.method ?? 'GET' });
      return fetchImpl(url, options);
    },
  });
  vm.runInContext(scripts.actions + '\n' + scripts.background, context);
  const evaluate = code => vm.runInContext(code, context);
  await evaluate('stateReady');
  const api = evaluate('({ apiFetch, apiAddTaskBatch, addBatchWithDetail, apiAddTaskFile, apiBulkTaskAction, apiRetryTask, apiLogout, recordForPopup, addDownloadTasksBulk })');
  // What the popup would have received with its task list, and sends back with every action on it.
  const connection = evaluate('connectionKey')(h.data.local);
  return { ...h, context, evaluate, api, requests, connection, send: message => h.browser.runtime.sendMessage(message) };
}

function popup(h = makeBrowser()) {
  const nodes = new Map(), timers = new Map();
  let timerId = 0;
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

test('file upload response errors remain uncertain and are sent once', async () => {
  const h = await background(async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }));
  await assert.rejects(h.api.apiAddTaskFile('sample.torrent', new Uint8Array([1, 2]).buffer, ''), e => e.deliveryUnknown === true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.file.name, 'sample.torrent');
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
  for (const id of ['btnAddBulk', 'btnAddTorrent', 'btnClearList']) assert.equal(h.nodes.get(id).disabled, true);
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
  assert.equal(p.timers.size, 1);
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

test('magnet capture ignores clicks a page makes itself', async () => {
  const sent = [];
  let onClick;
  class Element { closest() { return { href: 'magnet:?xt=urn:btih:abc' }; } }
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
  const click = isTrusted => {
    const e = { isTrusted, target: new Element(), prevented: false,
      preventDefault() { this.prevented = true; }, stopPropagation() {} };
    onClick(e);
    return e;
  };
  assert.equal(click(false).prevented, false);
  assert.equal(sent.length, 0);
  assert.equal(click(true).prevented, true);
  assert.equal(sent.length, 1);
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

test('a file read while another connection is saved is not uploaded to it', async () => {
  const h = await background();
  const p = popup(h);
  p.context.savedConnection = defaults;
  p.evaluate('settings = { ...settings, ...savedConnection }; popupReady = true;');
  p.api.setAddBusy(false);
  const read = deferred();
  p.nodes.get('torrentInput').files = [{ name: 'sample.torrent', arrayBuffer: () => read.promise }];
  const upload = p.nodes.get('torrentInput').listeners.change();
  await h.send({ action: 'settingsUpdated', connection: { ...defaults, host: 'new-nas.example' } });
  read.resolve(new Uint8Array([1, 2]).buffer);
  await upload;
  assert.ok(!h.requests.some(request => request.body.method === 'create'));
  assert.match(p.nodes.get('bulkStatus').textContent, /addConnectionChanged/);
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

  const files = await background(signInOffline, { session: { sid: null } });
  const upload = await files.evaluate("addTaskFiles([{ name: 'sample.torrent', buffer: new ArrayBuffer(2) }], '')");
  assert.equal(upload.deliveryUnknown, false);

  for (const h of [single, links, files]) assert.ok(!h.requests.some(request => request.body.method === 'create'));
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

test('release files parse, manifest assets exist and locale keys stay in sync', () => {
  for (const file of ['actions.js', 'background.js', 'content.js', 'popup/popup.js']) new vm.Script(read(file));
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '1.1.2');
  for (const file of [...manifest.background.scripts, ...manifest.content_scripts.flatMap(s => s.js),
    manifest.action.default_popup, ...Object.values(manifest.icons)]) assert.ok(fs.existsSync(path.join(root, file)), file);
  const keys = Object.keys(JSON.parse(read('_locales/en/messages.json'))).sort();
  for (const locale of fs.readdirSync(path.join(root, '_locales'))) {
    assert.deepEqual(Object.keys(JSON.parse(read(`_locales/${locale}/messages.json`))).sort(), keys, locale);
  }
  const html = read('popup/popup.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of scripts.popup.matchAll(/(?:\$\(|getElementById\()'([^']+)'/g)) assert.ok(ids.includes(match[1]), match[1]);
  for (const match of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) assert.ok(keys.includes(match[1]), match[1]);
});
