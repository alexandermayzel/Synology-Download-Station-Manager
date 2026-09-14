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
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', msg(el.dataset.i18nAriaLabel));
  }
}

function applyStaticLocalization() {
  // The markup ships as lang="en", but the text that goes into it is whatever
  // the browser asked for. Left unchanged, a screen reader reads German and
  // Russian with English pronunciation rules.
  document.documentElement.lang = browser.i18n.getUILanguage();

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
const notifyEl        = $('notificationsEnabled');
const notifyAddedEl   = $('notifyOnAdded');
const notifyFailedEl  = $('notifyOnFailed');
const notifyDoneEl    = $('notifyOnFinished');
const notifySubOpts   = $('notifySubOptions');
const extractEl    = $('extractArchives');
const unzipPassEl  = $('unzipPassword');
const archivePwField = $('archivePasswordField');
const btnSaveConn    = $('btnSaveConnection');
const connMessageEl  = $('connMessage');
const credentialsEl  = $('credentialsSection');
const btnSaveDest    = $('btnSaveDest');
const btnLogout      = $('btnLogout');
const btnResetAll    = $('btnResetAll');
const resetAllBar    = $('resetAllConfirm');
const btnResetYes    = $('btnResetAllYes');
const btnResetNo     = $('btnResetAllNo');
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
const otpField       = $('otpField');
const otpCodeEl      = $('otpCode');
const btnOtpSubmit   = $('btnOtpSubmit');
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
const taskStatusEl   = $('taskStatus');
const linksMessageEl = $('linksMessage');

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

/** Bucket for a task; anything unrecognised counts as waiting. */
const bucketOf = (task) => BUCKET_OF.get(task.status?.toLowerCase()) ?? 'waiting';

// Failed sits right behind active on purpose: it is the bucket that needs a
// decision, so it should not be buried behind everything that is merely idle.
const DEFAULT_STATUS_ORDER = ['active', 'failed', 'waiting', 'paused', 'finished'];
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

// The connection and notification defaults are shared with the background and
// live in actions.js; everything below them is the popup's own.
const DEFAULTS = {
  ...SETTINGS_DEFAULTS,
  extractArchives: false,
  refreshInterval: 10,
  sortBy: 'status',
  sortDir: 'desc',
  statusOrder: DEFAULT_STATUS_ORDER,
  // Only a couple of cards are visible at once, so a long page means scrolling
  // past what you came for. Ten keeps the pager useful instead of decorative.
  tasksPerPage: 10,
  // Which tab the popup opens on. Adding is the default: it is the one thing
  // you cannot do from anywhere else in the browser except the context menu.
  startTab: 'add',
};

/** Live copy of the settings that affect rendering, so redraws stay cheap. */
let settings = { ...DEFAULTS };

/**
 * Settings saves run one after another, each starting from what the one before
 * it left in `settings`.
 *
 * They used to overlap. Saving the destination and flipping a switch straight
 * after started two saves from the same starting point; the second still held
 * the old destination, and because it landed last, wrote it back.
 */
let settingsSaves = Promise.resolve();

function queueSettingsSave(fn) {
  const run = settingsSaves.then(fn);
  settingsSaves = run.catch(() => {});
  return run;
}

async function persistSettingsUpdate(changes) {
  const result = await browser.runtime.sendMessage({ action: ACTIONS.SETTINGS_UPDATED, ...changes });
  if (!result?.ok) throw new Error(errText(result?.error, 'extensionError'));
}

/**
 * Write `settings` into the form and bring every dependent control in line.
 *
 * The one place that knows how a setting reaches the screen. This used to be
 * two near-identical blocks, one for loading and one for the reset, so every
 * new option had to be added twice — and a `syncDestSaveState()` missing from
 * the second copy left the destination's save button highlighted after a
 * reset. One list now, one set of follow-ups, nothing to keep in step.
 */
function applySettingsToForm() {
  protocolEl.value       = settings.protocol;
  hostEl.value           = settings.host;
  portEl.value           = String(settings.port);
  usernameEl.value       = settings.username;
  passwordEl.value       = settings.password;
  destEl.value           = settings.defaultDestination;
  autoMagnetEl.checked   = settings.autoCaptureMagnets;
  keepaliveEl.checked    = settings.keepaliveEnabled;
  notifyEl.checked       = settings.notificationsEnabled;
  notifyAddedEl.checked  = settings.notifyOnAdded;
  notifyFailedEl.checked = settings.notifyOnFailed;
  notifyDoneEl.checked   = settings.notifyOnFinished;
  extractEl.checked      = settings.extractArchives;
  refreshIntEl.value     = String(settings.refreshInterval);
  sortByEl.value         = settings.sortBy;
  sortDirEl.value        = settings.sortDir;
  perPageEl.value        = String(settings.tasksPerPage);

  renderStatusOrder();
  syncSortControls();
  syncArchiveField();
  syncNotifySubOptions();
  syncHomeButtons();
  syncDestSaveState();
}

async function loadSettings() {
  const s = await browser.storage.local.get(DEFAULTS);
  settings = { ...DEFAULTS, ...s };

  // A stored order from an older version may be missing buckets we since added.
  const order = Array.isArray(settings.statusOrder) ? settings.statusOrder : [];
  settings.statusOrder = [
    ...order.filter(b => DEFAULT_STATUS_ORDER.includes(b)),
    ...DEFAULT_STATUS_ORDER.filter(b => !order.includes(b)),
  ];
  if (!TABS.includes(settings.startTab)) settings.startTab = DEFAULTS.startTab;

  applySettingsToForm();
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

/**
 * Drop the account but keep the NAS. Username, password and the trusted-device
 * token go; protocol, host, port and every other option stay, so signing back
 * in only means typing the credentials again.
 *
 * The background owns the transition, including handing the session back to
 * its original endpoint and removing the credentials and local device token.
 */
async function logoutAccount() {
  btnLogout.disabled = true;
  try {
    forgetTasks();
    await queueSettingsSave(async () => {
      await persistSettingsUpdate({ signOut: true });
      settings = { ...settings, username: '', password: '' };
    });

    stopAutoRefresh();
    forgetTasks(); // a refresh may have started while signing out
    clearConnDraft();

    usernameEl.value = '';
    passwordEl.value = '';
    otpCodeEl.value  = '';
    showOtpPrompt(false);

    // Marks the now-empty credential fields and opens their section.
    promptForSetup();
  } catch (err) {
    connMessageEl.textContent = err.message;
    connMessageEl.hidden = false;
  } finally {
    btnLogout.disabled = false;
  }
}

btnLogout.addEventListener('click', logoutAccount);

// ---------------------------------------------------------------------------
// Reset everything
// ---------------------------------------------------------------------------

/**
 * Wipe every stored value and return the form to its defaults.
 *
 * The background clears settings and the session together. The popup then
 * resets its drafts and controls.
 */
async function resetAllSettings() {
  btnResetYes.disabled = true;
  try {
    forgetTasks();
    await queueSettingsSave(async () => {
      await persistSettingsUpdate({ reset: true, options: DEFAULTS });
      settings = { ...DEFAULTS, statusOrder: [...DEFAULT_STATUS_ORDER] };
      // Put the UI back the way a fresh install looks. The defaults for host,
      // username and password are empty strings, so this covers them too.
      // Inside the queue: a save waiting behind this one reads the form, and
      // must find the defaults there rather than the settings just wiped.
      applySettingsToForm();
    });

    stopAutoRefresh();
    clearTimeout(connDraftTimer);
    clearTimeout(destDraftTimer);
    clearTimeout(draftSaveTimer);
    await browser.storage.session.remove(['connDraft', 'destDraft', 'bulkDraft', 'lastAdd', 'lastTab', 'setupRequired']);

    // Not settings, so not part of that: scratch fields with nothing stored
    // behind them.
    otpCodeEl.value   = '';
    bulkLinksEl.value = '';
    unzipPassEl.value = '';

    showOtpPrompt(false);
    setActiveFilter('all', false);
    forgetTasks();
    bulkStatusEl.textContent = '';

    promptForSetup();
  } catch (err) {
    connMessageEl.textContent = err.message;
    connMessageEl.hidden = false;
  } finally {
    btnResetYes.disabled = false;
  }
}

btnResetAll.addEventListener('click', () => {
  resetAllBar.hidden = false;
  btnResetNo.focus();
});
btnResetNo.addEventListener('click', () => { resetAllBar.hidden = true; });
btnResetYes.addEventListener('click', async () => {
  resetAllBar.hidden = true;
  await resetAllSettings();
});

// ---------------------------------------------------------------------------
// Unsaved connection details
// ---------------------------------------------------------------------------

/**
 * Firefox closes the popup as soon as anything outside it is clicked — the
 * password manager's own button included. Without this, half-entered
 * connection details would be gone on reopen. They are kept as a draft until
 * they are actually saved.
 */
const CONN_FIELDS = () => ({
  protocol: protocolEl.value,
  host:     hostEl.value,
  port:     portEl.value,
  username: usernameEl.value,
  password: passwordEl.value,
});

let connDraftTimer = null;
let destDraftTimer = null;

/**
 * Deliberately storage.session, not storage.local: this holds a password that
 * was typed but never saved, and it has no business outliving the browser.
 * Session storage keeps it for as long as the window is open — which is all
 * the popup closing and reopening needs — and is thrown away on shutdown.
 */
function saveConnDraft() {
  clearTimeout(connDraftTimer);
  connDraftTimer = setTimeout(() => {
    browser.storage.session.set({ connDraft: CONN_FIELDS() });
  }, 250);
}

/**
 * The destination keeps a draft of its own. Clicking away from the field is
 * often the very click that closes the popup, so it needs one — but it has its
 * own save button. Sharing the connection's draft, saving the connection threw
 * away a folder that was typed and not yet saved.
 */
function saveDestDraft() {
  clearTimeout(destDraftTimer);
  destDraftTimer = setTimeout(() => {
    browser.storage.session.set({ destDraft: destEl.value });
  }, 250);
}

/**
 * Overlay unsaved edits on top of the stored settings.
 *
 * Only fields that actually contain something. The draft is there to preserve
 * what was typed, not what was deleted: an emptied field was never saved, so
 * nothing was removed — restoring the blank would show an empty password next
 * to a "Connected" status, which is the stored one still doing its job.
 */
async function loadConnDraft() {
  const { connDraft, destDraft } = await browser.storage.session.get({ connDraft: null, destDraft: '' });
  if (destDraft) destEl.value = destDraft;
  // A restored destination may differ from what is stored, which is exactly
  // what the save button's highlight is there to say.
  syncDestSaveState();

  if (!connDraft) return;
  if (connDraft.protocol) protocolEl.value = connDraft.protocol;
  if (connDraft.host)     hostEl.value     = connDraft.host;
  if (connDraft.port)     portEl.value     = connDraft.port;
  if (connDraft.username) usernameEl.value = connDraft.username;
  if (connDraft.password) passwordEl.value = connDraft.password;

  // Half-finished input usually means the credentials section was open.
  if (connDraft.username || connDraft.password) {
    credentialsEl.open = true;
  }
}

function clearConnDraft() {
  clearTimeout(connDraftTimer);
  browser.storage.session.remove('connDraft');
}

function clearDestDraft() {
  clearTimeout(destDraftTimer);
  browser.storage.session.remove('destDraft');
}

for (const el of [hostEl, portEl, usernameEl, passwordEl]) {
  el.addEventListener('input', saveConnDraft);
}
protocolEl.addEventListener('change', saveConnDraft);

/**
 * Highlight the destination's save button while the field differs from what
 * is stored, so an unsaved edit is visible rather than something you have to
 * remember. It also saves on blur, but the button is the obvious way.
 */
function syncDestSaveState() {
  btnSaveDest.classList.toggle('pending', destEl.value.trim() !== settings.defaultDestination);
}

destEl.addEventListener('input', () => { syncDestSaveState(); saveDestDraft(); });

/**
 * Grey out the three per-kind switches while the master one is off. They keep
 * their own state — turning the master back on restores exactly the selection
 * that was there before, rather than resetting it to all-on.
 */
function syncNotifySubOptions() {
  const on = notifyEl.checked;
  notifySubOpts.classList.toggle('disabled', !on);
  for (const el of [notifyAddedEl, notifyFailedEl, notifyDoneEl]) {
    el.disabled = !on;
  }
}

/** The archive password only makes sense while auto-extract is switched on. */
function syncArchiveField() {
  const on = extractEl.checked;
  archivePwField.hidden = !on;
  if (!on) unzipPassEl.value = '';
  // The password field takes room from the link box rather than from the
  // bottom of the tab, so the box knows to be shorter while it is there.
  bulkLinksEl.classList.toggle('with-password', on);
}

// There used to be a syncExtractHint() here, asking the NAS through
// SYNO.DownloadStation.Info whether this account was a Download Station
// manager, and swapping the hint for "ask an administrator" when it was not.
// It rested on a wrong idea of how DSM works. Automatic extraction has two
// levels: a service an administrator enables once for the whole NAS, and a
// switch every account sets for itself — off by default, and the one that
// actually catches people out. Since anyone can set their own, the hint now
// says where it is instead of who has to be asked, and the API call it took
// to decide that is gone.

async function loadFilterState() {
  const s = await browser.storage.local.get({ activeFilter: 'all' });
  setActiveFilter(s.activeFilter, false);
}

function saveFilterState() {
  browser.storage.local.set({ activeFilter });
}

/**
 * Persist the form.
 *
 * `forceTest` comes from the button that promises to test the connection, so
 * it does so even when nothing about it changed. `feedbackOn` names the button
 * to confirm on — omitted for the option controls, which save themselves the
 * moment they change and have no button to flash.
 *
 * `commitDest` and `commitConn` mark the two blocks that are *not* applied as
 * you type them. Without them a half-typed folder or a password mid-edit would
 * be picked up by the next unrelated save — a toggle click — and quietly
 * become the stored value. Clearing the password field would then wipe the
 * stored password and mark the field as missing, without anyone pressing save.
 */
async function saveSettings(options = {}) {
  const { feedbackOn = null } = options;
  // Held for the whole save, not just the 1.5 seconds the confirmation shows.
  // "Save and test connection" runs a login afterwards that can take a minute
  // against a sleeping NAS, and the button used to come back to life halfway
  // through it — a second click there starts a second login.
  if (feedbackOn) feedbackOn.disabled = true;
  try {
    await commitSettings(options);
  } catch (err) {
    connMessageEl.textContent = err.message;
    connMessageEl.hidden = false;
  } finally {
    if (feedbackOn) feedbackOn.disabled = false;
  }
}

/**
 * The settings that change how the task list looks. Only these redraw it on a
 * save; a notification switch or the keepalive leaves the cards alone.
 */
const LAYOUT_KEYS = Object.freeze(['sortBy', 'sortDir', 'statusOrder', 'tasksPerPage']);

async function commitSettings({
  forceTest = false, feedbackOn = null, commitDest = false, commitConn = false,
} = {}) {
  const { credentialsChanged, perPageBefore, layoutChanged } = await queueSettingsSave(async () => {
    const base = settings;

    // A device token belongs to one NAS and one account — if either changes,
    // the background has to throw it away. Only ever true on a deliberate save.
    const credentialsChanged = commitConn && (
      base.host     !== hostEl.value.trim() ||
      base.username !== usernameEl.value.trim() ||
      base.password !== passwordEl.value ||
      base.protocol !== protocolEl.value ||
      base.port     !== (parseInt(portEl.value, 10) || 5001)
    );

    const nextSettings = {
      ...base,
      protocol:           commitConn ? protocolEl.value                          : base.protocol,
      host:               commitConn ? hostEl.value.trim()                       : base.host,
      port:               commitConn ? (parseInt(portEl.value, 10) || 5001)      : base.port,
      username:           commitConn ? usernameEl.value.trim()                   : base.username,
      password:           commitConn ? passwordEl.value                          : base.password,
      autoCaptureMagnets: autoMagnetEl.checked,
      defaultDestination: commitDest ? destEl.value.trim() : base.defaultDestination,
      keepaliveEnabled:   keepaliveEl.checked,
      notificationsEnabled: notifyEl.checked,
      notifyOnAdded:        notifyAddedEl.checked,
      notifyOnFailed:       notifyFailedEl.checked,
      notifyOnFinished:     notifyDoneEl.checked,
      extractArchives:    extractEl.checked,
      refreshInterval:    parseInt(refreshIntEl.value, 10),
      sortBy:             sortByEl.value,
      sortDir:            sortDirEl.value,
      startTab:           base.startTab,
      statusOrder:        readStatusOrder(),
      tasksPerPage:       parseInt(perPageEl.value, 10) || DEFAULTS.tasksPerPage,
    };
    // Only what this save changed. The whole snapshot also carried every value
    // it had merely passed along, and those are the ones another save may have
    // changed in the meantime.
    const changedOptions = Object.fromEntries(Object.entries(nextSettings).filter(([key, value]) =>
      !CONNECTION_KEYS.includes(key) && JSON.stringify(value) !== JSON.stringify(base[key])));

    // The old list goes before the save — logging out the old NAS can take a
    // while — and again after it, in case a refresh slipped in meanwhile.
    if (credentialsChanged) forgetTasks();
    await persistSettingsUpdate({
      connection: commitConn ? connectionSettings(nextSettings) : undefined,
      options: changedOptions,
    });
    if (credentialsChanged) forgetTasks();
    // Merged into `settings` as it is now rather than replacing it with the
    // snapshot: the start tab is stored on its own and may have changed.
    settings = {
      ...settings, ...changedOptions, ...(commitConn ? connectionSettings(nextSettings) : {}),
    };
    return {
      credentialsChanged,
      perPageBefore: base.tasksPerPage,
      layoutChanged: LAYOUT_KEYS.some(key => key in changedOptions),
    };
  });
  // Only when the connection details were actually written. This used to run on
  // every save, and every option toggle is a save — so flipping any switch threw
  // away a password that had been typed but not yet saved, and the field came
  // back empty on the next open. The draft exists precisely to survive that.
  // Each draft goes with its own save only.
  if (commitConn) clearConnDraft();
  if (commitDest) clearDestDraft();

  // Saving the connection is also what folds the credentials away: they are
  // done with, and the block is long. It is an ordinary fold, so the state is
  // remembered like any other — open it again and it stays open until the next
  // save.
  if (commitConn) credentialsEl.open = false;

  // Only a different page size makes the current page number meaningless. This
  // used to reset on every save, and every option toggle is a save — so turning
  // a notification off sent you back to page 1 of the task list.
  if (settings.tasksPerPage !== perPageBefore) currentPage = 1;

  syncArchiveField();
  syncNotifySubOptions();
  syncDestSaveState(); // the field now matches what's stored
  if (layoutChanged) renderTasks();
  syncRefreshTimer(); // the refresh interval may have just changed
  showSavedFeedback(feedbackOn);

  // Try the new details straight away rather than letting the first download
  // be the thing that discovers they are wrong.
  if (credentialsChanged || forceTest) {
    if (connFieldsFilled()) {
      for (const el of REQUIRED_FIELDS) el.classList.remove('invalid');
      // If a verification code is on screen and filled in, this button does
      // the same as the one next to it — no reason to make people find that.
      connMessageEl.hidden = true;
      const otp = otpField.hidden ? '' : otpCodeEl.value.trim();
      await attemptConnect(otp || undefined);
    } else {
      promptForSetup();
    }
  }
}

/**
 * Brief confirmation on whichever button was actually pressed. Only the label
 * changes — saveSettings owns `disabled`, and keeps it set until everything it
 * started has finished.
 */
function showSavedFeedback(button) {
  if (!button) return;
  const original = button.textContent;
  button.textContent = msg('saved');
  setTimeout(() => { button.textContent = original; }, 1500);
}

// ---------------------------------------------------------------------------
// Collapsible sections
// ---------------------------------------------------------------------------

/**
 * Every disclosure whose open state is worth remembering.
 *
 * Credentials is nested inside the Connection section rather than being a
 * section itself, and was left out of this — so it fell back to the markup's
 * default and came up collapsed every single time, however often you opened
 * it. Reaching for a password manager closes the popup, which made that the
 * one place where forgetting hurt most.
 */
const REMEMBERED_SECTIONS = '.section.collapsible, .credentials';

/**
 * Every section starts open; only what the user actually folds away is
 * remembered, so a fresh install shows everything and a tidied-up layout
 * survives closing the popup.
 */
async function loadSectionStates() {
  const { sectionStates } = await browser.storage.local.get({ sectionStates: {} });
  for (const section of document.querySelectorAll(REMEMBERED_SECTIONS)) {
    const stored = sectionStates[section.id];
    if (stored !== undefined) section.open = stored;
  }
}

function saveSectionStates() {
  const sectionStates = {};
  for (const section of document.querySelectorAll(REMEMBERED_SECTIONS)) {
    sectionStates[section.id] = section.open;
  }
  browser.storage.local.set({ sectionStates });
}

for (const section of document.querySelectorAll(REMEMBERED_SECTIONS)) {
  section.addEventListener('toggle', saveSectionStates);
}

// ---------------------------------------------------------------------------
// First-run setup guard
// ---------------------------------------------------------------------------

/**
 * Connection fields that must be filled in before anything can be added, each
 * with the locale key of its own label — so a complaint about a missing field
 * can name it exactly as it is written above the input.
 */
const REQUIRED_FIELDS_BY_LABEL = new Map([
  [hostEl,     'host'],
  [usernameEl, 'username'],
  [passwordEl, 'password'],
]);
const REQUIRED_FIELDS = [...REQUIRED_FIELDS_BY_LABEL.keys()];

/**
 * Is there a usable connection *stored*? This is what downloads actually run
 * on, so it deliberately ignores the form — a password cleared on screen but
 * never saved has not stopped anything from working.
 */
function isConfigured() {
  return hasCredentials(settings);
}

/** Are the fields filled in right now? The question the save button asks. */
function connFieldsFilled() {
  return REQUIRED_FIELDS.every(el => el.value.trim() !== '');
}

/**
 * Send the user to the Settings tab, open the Credentials section and mark
 * every required field that is still empty — so what has to be filled in is
 * obvious the moment the popup opens.
 */
function promptForSetup() {
  activateTab('settings', { remember: false });
  credentialsEl.open = true;
  document.getElementById('connectionSection').open = true;

  let firstMissing = null;
  const missingNames = [];
  for (const [el, labelKey] of REQUIRED_FIELDS_BY_LABEL) {
    const missing = el.value.trim() === '';
    el.classList.toggle('invalid', missing);
    if (missing) {
      missingNames.push(msg(labelKey));
      if (!firstMissing) firstMissing = el;
    }
  }

  if (missingNames.length) {
    // Intl.ListFormat joins them the way the language does it — "host and
    // password", "Host und Passwort" — rather than with a comma everywhere.
    const list = new Intl.ListFormat(browser.i18n.getUILanguage(), {
      style: 'long', type: 'conjunction',
    }).format(missingNames);
    connMessageEl.textContent = missingNames.length === 1
      ? msg('fillRequiredField', list)
      : msg('fillRequiredFields', list);
    connMessageEl.hidden = false;
  } else {
    connMessageEl.hidden = true;
  }

  // Only claim the connection is unset when it really is. Emptying a field on
  // screen does not undo a stored connection that is still working, and saying
  // otherwise in the header would contradict the "Connected" it shows.
  if (!isConfigured()) setStatus('error', msg('setupRequiredShort'));
  firstMissing?.focus();
}

// Clear a field's marking as soon as the user types something into it, and the
// message once nothing is missing any more.
for (const el of REQUIRED_FIELDS) {
  el.addEventListener('input', () => {
    if (el.value.trim() !== '') el.classList.remove('invalid');
    if (connFieldsFilled()) connMessageEl.hidden = true;
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

function renderStatusOrder(order = settings.statusOrder) {
  const frag = document.createDocumentFragment();

  for (const bucket of order) {
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
  saveSettings();
});

btnOrderReset.addEventListener('click', () => {
  // Drawn, not written into `settings` first: a save sends only what differs
  // from `settings`, so an order already put there would never be stored.
  renderStatusOrder(DEFAULT_STATUS_ORDER);
  saveSettings();
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
    saveSettings();
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
  // The header clips long text, so keep the whole message on the tooltip.
  statusText.title = message;
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

/**
 * Show or hide the two-step verification prompt. DSM only asks once per
 * device: the login that carries a code also asks for a device token, which
 * the background stores and reuses.
 */
function showOtpPrompt(show, wrong = false) {
  otpField.hidden = !show;
  codePending = show;
  if (!show) { otpCodeEl.value = ''; return; }

  activateTab('settings', { remember: false });
  document.getElementById('connectionSection').open = true;
  setStatus('error', wrong ? msg('otpWrong') : msg('otpRequired'));
  otpCodeEl.focus();
  otpCodeEl.select();
}

/**
 * Run a connection attempt, optionally carrying a freshly typed code.
 * Returns true once connected.
 */
async function attemptConnect(otpCode) {
  setStatus('checking', msg('connecting'));
  try {
    const result = await browser.runtime.sendMessage({ action: ACTIONS.TEST_CONNECTION, otpCode });

    if (result.connectionChanged) return false;

    if (result.success) {
      showOtpPrompt(false);
      const v = result.info?.authVersion ?? '?';
      setStatus('connected', msg('connectedWithVersion', String(v)));
      refreshTasks();
      startAutoRefresh();
      return true;
    }
    if (result.otpRequired || result.otpWrong) {
      showOtpPrompt(true, result.otpWrong);
      stopAutoRefresh();
      return false;
    }
    // The header clips; the list area has room for the whole reason.
    const why = errText(result.error, 'connectionFailed');
    setStatus('error', why);
    showMessage(why, true);
    stopAutoRefresh();
    return false;
  } catch (err) {
    const why = err.message || msg('extensionError');
    setStatus('error', why);
    showMessage(why, true);
    stopAutoRefresh();
    return false;
  }
}

async function testConnection() {
  btnTest.disabled = true;
  try {
    await attemptConnect();
  } finally {
    btnTest.disabled = false;
  }
}

async function submitOtp() {
  const code = otpCodeEl.value.trim();
  if (!code) { otpCodeEl.focus(); return; }
  btnOtpSubmit.disabled = true;
  try {
    await attemptConnect(code);
  } finally {
    btnOtpSubmit.disabled = false;
  }
}

btnOtpSubmit.addEventListener('click', submitOtp);
otpCodeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitOtp(); }
});

// ---------------------------------------------------------------------------
// Task list
// ---------------------------------------------------------------------------

/**
 * Human-readable badge text. The API reports raw values like "error"; show
 * the localized wording for the ones we have, and fall back to the raw status
 * for the rarer ones (seeding, extracting, …) rather than flattening them.
 */
const STATUS_LABEL_KEY = {
  downloading:         'statusDownloading',
  waiting:             'statusWaiting',
  error:               'statusFailed',
  paused:              'statusPaused',
  stopped:             'statusPaused',
  finished:            'statusFinished',
  extracting:          'statusExtracting',
  seeding:             'statusSeeding',
  finishing:           'statusFinishing',
  hash_checking:       'statusChecking',
  filehosting_waiting: 'statusHostWaiting',
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
  bps = nonNegativeNumber(bps);
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

  const total      = nonNegativeNumber(task.size);
  const downloaded = nonNegativeNumber(task.additional?.transfer?.size_downloaded);
  if (total === 0) return 0;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

let cachedTasks = [];
/**
 * Which connection the tasks on screen came from, as the background named it.
 * Sent back with every action on them, so an id cannot land on another NAS.
 */
let tasksConnection = null;
/** Bumped whenever the list is dropped; a refresh begun before that is ignored. */
let tasksGeneration = 0;
let refreshTimer = null;
/**
 * The interval the running timer was built with. Kept so the timer is only torn
 * down and rebuilt when that figure actually changes — the close watch below
 * swaps it twice per add, and rebuilding on every sync would reset the countdown
 * each time a tab was switched.
 */
let refreshTimerMs = 0;

const taskCardTpl = document.getElementById('taskCardTpl');

/** Replace taskList contents with a single text message. */
function showMessage(text, isError = false) {
  const p = document.createElement('p');
  p.className = `hint center ${isError ? 'error' : ''}`.trim();
  p.textContent = text;
  taskListEl.replaceChildren(p);
}

/**
 * Whether the list should be refreshing at all.
 *
 * Kept apart from the timer itself because the two answer different questions.
 * This one says there is something worth watching; the timer only runs while
 * the Tasks tab is also on screen, since asking the NAS about a list nobody is
 * looking at is pure noise. Without remembering the intent, switching tabs and
 * back would leave the list frozen until something else happened to restart it.
 */
let refreshWanted = false;

/**
 * Set while DSM waits for a two-factor code. Nothing refreshes on its own until
 * one is typed: each refresh signs in without it and is only asked again. That
 * includes the close watch after an add, which outranks refreshWanted — turning
 * that off left the three-second timer to start again on returning to Tasks.
 */
let codePending = false;

/**
 * The half minute after an add, watched closely.
 *
 * A freshly queued download is the one moment where the list changes fast and
 * is worth looking at: a small file can start, run and finish well inside the
 * ten seconds the normal interval waits, so the only thing ever seen of it
 * would be "Finished". For half a minute after an add the list therefore
 * refreshes every three seconds, and then falls back to whatever the setting
 * says — which is the right figure for the long downloads that are left.
 *
 * It runs even with "Manual only" chosen. That setting is about the extension
 * polling on its own; this follows a button the user pressed a moment ago, is
 * capped at ten requests, and stops by itself.
 */
const BURST_WINDOW_MS   = 30000;
const BURST_INTERVAL_MS = 3000;

/** When the close watch runs out. In the past means there is none. */
let burstUntil = 0;
let burstEndTimer = null;

const isBursting = () => Date.now() < burstUntil;

/**
 * Watch closely for the rest of the window that opened at `since`.
 *
 * Dated from when the add finished rather than from now, so a popup reopened
 * twenty seconds later gets the ten that are left instead of a fresh thirty —
 * and one reopened an hour later gets none at all.
 */
function startBurstRefresh(since = Date.now()) {
  const until = since + BURST_WINDOW_MS;
  if (until <= Date.now()) return;
  burstUntil = Math.max(burstUntil, until);

  // Nothing else would notice the window closing: the timer has to be rebuilt
  // at the slower interval, and only a wake-up at that moment can do it.
  clearTimeout(burstEndTimer);
  burstEndTimer = setTimeout(() => {
    burstEndTimer = null;
    syncRefreshTimer();
  }, burstUntil - Date.now());

  syncRefreshTimer();
}

/** Run the timer exactly when it is of any use, and at the right speed. */
function syncRefreshTimer() {
  // Off the Tasks tab there is nothing on screen to refresh, whatever else
  // is true — including during the close watch. The same while a code is due.
  const wantedMs =
    activeTab !== 'tasks' || codePending              ? 0 :
    isBursting()                                      ? BURST_INTERVAL_MS :
    refreshWanted && settings.refreshInterval > 0     ? settings.refreshInterval * 1000 :
    0;                                                // 0 means "Manual only"

  if (refreshTimer !== null && refreshTimerMs === wantedMs) return;

  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    refreshTimerMs = 0;
  }
  if (wantedMs > 0) {
    refreshTimer = setInterval(refreshTasks, wantedMs);
    refreshTimerMs = wantedMs;
  }
}

function startAutoRefresh() {
  refreshWanted = true;
  refreshFailures = 0; // a deliberate restart deserves a fresh set of attempts
  syncRefreshTimer();
}

function stopAutoRefresh() {
  refreshWanted = false;
  syncRefreshTimer();
}

// No unload handler for the timer: closing the popup destroys the document and
// every interval with it. The listener that used to sit here could not run late
// enough to matter, and `unload` is deprecated besides.

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
    added:    t => nonNegativeNumber(t.additional?.detail?.create_time),
    name:     t => (t.title ?? '').toLowerCase(),
    progress: t => calcProgress(t),
    size:     t => nonNegativeNumber(t.size),
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

/**
 * The list as the cards show it, filtered and sorted, kept until the tasks, the
 * filter or the sort order change. Turning a page used to count, filter and sort
 * the whole unchanged list again for the ten cards it then showed.
 */
let preparedTasks = { source: null, key: '', sorted: [] };

function prepareTasks() {
  const key = JSON.stringify([activeFilter, settings.sortBy, settings.sortDir, settings.statusOrder]);
  if (preparedTasks.source !== cachedTasks || preparedTasks.key !== key) {
    const filtered = activeFilter === 'all'
      ? cachedTasks
      : cachedTasks.filter(t => bucketOf(t) === activeFilter);
    preparedTasks = { source: cachedTasks, key, sorted: sortTasks(filtered) };
  }
  return preparedTasks.sorted;
}

function renderTasks(tasks) {
  if (tasks) {
    cachedTasks = tasks;
    // The counts depend on the tasks alone, not on filter, sort or page.
    updateFilterCounts(cachedTasks);
  }

  const sorted = prepareTasks();

  if (sorted.length === 0) {
    showMessage(msg('noTasks'));
    renderPager(0, 0, 0, 0);
    return;
  }

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
        // And its folder, so the new task lands where the old one was.
        btn.dataset.destination = task.additional?.detail?.destination ?? '';
      }
    }
    // Every task can be removed on its own, whatever it is doing. "Clear"
    // only sweeps up finished ones, and the bulk delete takes everything —
    // this is the way to get rid of exactly one.
    const removeBtn = card.querySelector('[data-field="removeBtn"]');
    removeBtn.hidden = false;
    removeBtn.dataset.taskId = task.id;

    // Transfer rates sit next to the name; a failure reason gets its own line.
    const dl = formatSpeed(task.additional?.transfer?.speed_download ?? 0);
    const ul = formatSpeed(task.additional?.transfer?.speed_upload   ?? 0);
    if (dl || ul) {
      const speedEl = card.querySelector('[data-field="speed"]');
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

    if (reason) {
      const failEl = card.querySelector('[data-field="failure"]');
      failEl.hidden = false;
      failEl.textContent = reason;
    }

    fragment.appendChild(card);
  }

  taskListEl.replaceChildren(fragment);
}

/**
 * True while a refresh is on its way. A request to a sleeping NAS is retried
 * in the background and can take the better part of a minute, which is longer
 * than the refresh interval — without this the timer would pile request on
 * request while nothing is answering.
 */
let refreshInFlight = false;

/**
 * Consecutive failures before the popup stops asking, mirroring the background
 * poll's own limit. Without one, a NAS that has gone away is contacted every
 * few seconds for as long as the popup stays open, each attempt dragging its
 * full retry chain behind it. The Refresh button starts it again.
 */
const REFRESH_MAX_FAILURES = 5;
let refreshFailures = 0;

/**
 * Take the task list off screen because the connection it came from is being
 * replaced. Its ids mean nothing on another NAS — or name a different task
 * there — so nothing on it may stay clickable, and a refresh already on its way
 * for the old connection must not bring it back.
 */
function forgetTasks() {
  tasksGeneration++;
  tasksConnection = null;
  // A "Delete all" still waiting for its Yes was asked about the old list.
  deleteAllBar.hidden = true;
  deleteAllConnection = null;
  // The refresh that was running is disowned; let the next one through.
  refreshInFlight = false;
  btnRefresh.disabled = false;
  currentPage = 1;
  totalSpeedEl.hidden = true;
  renderTasks([]);
}

async function refreshTasks() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  btnRefresh.disabled = true;
  const generation = tasksGeneration;
  try {
    const result = await browser.runtime.sendMessage({ action: ACTIONS.LIST_TASKS });
    // Asked before the connection changed, so the answer is about the old one.
    if (generation !== tasksGeneration) return;
    if (result.success) {
      refreshFailures = 0;
      tasksConnection = result.connection ?? null;
      const tasks = result.data?.tasks ?? [];
      renderTasks(tasks);
      updateTotalSpeed(tasks);

      // Something is still moving, so keep asking; nothing is, so stop — the
      // Refresh button and a new link both bring the timer back.
      //
      // This used to only ever stop. An add arms the timer and then asks for
      // the list, and a NAS that had not registered the new task yet answered
      // "nothing running" — switching off the very watch the add had just
      // started. Saying both halves out loud fixes that by itself.
      if (tasks.some(isWorkingTask)) startAutoRefresh();
      else stopAutoRefresh();
    } else if (result.otpRequired || result.otpWrong) {
      // A sign-in the background started on its own wants a code. Asked for the
      // way a connection test asks, and nothing more is asked of the NAS until
      // it is typed. This used to count as an ordinary failure: the code field
      // stayed hidden and the header could go on saying "Connected". A prompt
      // already on screen stays put, rather than pulling anyone back to
      // Settings every time they look at the list.
      stopAutoRefresh();
      if (otpField.hidden) showOtpPrompt(true, result.otpWrong);
      else setStatus('error', msg(result.otpWrong ? 'otpWrong' : 'otpRequired'));
    } else {
      refreshFailed(errText(result.error, 'connectionFailed'));
    }
  } catch {
    if (generation === tasksGeneration) refreshFailed(msg('backgroundUnreachable'));
  } finally {
    // A disowned refresh leaves these alone: forgetTasks already released them,
    // and a newer refresh may be holding them by now.
    if (generation === tasksGeneration) {
      refreshInFlight = false;
      btnRefresh.disabled = false;
    }
  }
}

function refreshFailed(why) {
  showMessage(why, true);
  // Whatever the header last said is now a stale figure from a NAS we could
  // not reach. Better nothing than "↓ 87 MB/s" beside an error.
  totalSpeedEl.hidden = true;
  if (++refreshFailures >= REFRESH_MAX_FAILURES) {
    refreshFailures = 0;
    stopAutoRefresh();
  }
}

// ---------------------------------------------------------------------------
// Bulk add
// ---------------------------------------------------------------------------

// The popup is torn down every time it closes, so the pending list is kept in
// storage. That way links can be collected across several visits and only get
// cleared once they've actually been sent — or when the user empties the list.
//
// storage.session, like the connection draft: collecting links across a
// browsing session is the point, but a list left over from last week is not
// something to hand back to someone weeks later.
let draftSaveTimer = null;

function saveDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    browser.storage.session.set({ bulkDraft: bulkLinksEl.value });
  }, 250);
}

async function loadDraft() {
  const { bulkDraft } = await browser.storage.session.get({ bulkDraft: '' });
  bulkLinksEl.value = bulkDraft;
}

/**
 * Empty the box and the stored copy of it.
 *
 * Returns the removal so callers that are about to lose the popup can wait for
 * it. Emptying the field is instant, but the stored draft is what a reopened
 * popup reads — leave that write in flight and the links come back.
 */
function clearDraft() {
  clearTimeout(draftSaveTimer);
  bulkLinksEl.value = '';
  return browser.storage.session.remove('bulkDraft');
}

/**
 * Mark the box as holding rejected links and say why.
 *
 * The links left in it are the failures — everything the NAS took has been
 * removed, so pressing the button again retries exactly what did not work and
 * cannot add the rest a second time.
 */
function showLinksFailed(count, reason, unknown) {
  bulkLinksEl.classList.add('invalid');
  linksMessageEl.hidden = false;
  linksMessageEl.textContent = unknown
    ? msg('linksUncertain', String(count))
    : (reason ? msg('linksFailedReason', String(count), reason)
              : msg('linksFailed', String(count)));
}

function clearLinksFailed() {
  bulkLinksEl.classList.remove('invalid');
  linksMessageEl.hidden = true;
}

bulkLinksEl.addEventListener('input', () => {
  saveDraft();
  // Editing the list answers the complaint about it.
  clearLinksFailed();
});

btnClearList.addEventListener('click', () => {
  if (bulkLinksEl.readOnly) return;
  clearDraft();
  clearLinksFailed();
  bulkStatusEl.textContent = '';
  bulkLinksEl.focus();
});

/**
 * An add runs in the background and outlives the popup, so whether one is under
 * way is kept there rather than here. Read on open, watched while open.
 */
let backgroundAddBusy = true;
let localAddsPending = 0;
let consumingAdd = null;
let popupReady = false;

function syncAddControls() {
  const busy = backgroundAddBusy || localAddsPending > 0 || consumingAdd !== null;
  btnAddBulk.disabled = busy;
  btnAddTorrent.disabled = busy;
  btnClearList.disabled = busy;
  bulkLinksEl.readOnly = busy;
  bulkLinksEl.setAttribute('aria-busy', String(busy));
  $('addBusyHint').hidden = !busy;
  btnAddBulk.textContent = busy ? msg('addingInProgress') : msg('addAll');
}

function setAddBusy(busy) {
  backgroundAddBusy = busy;
  syncAddControls();
}

async function loadAddBusy() {
  // Consume the result before making the controls editable. The background
  // has already saved the updated draft together with that result.
  await consumeLastAdd();
  const { addInFlight, lastAdd } = await browser.storage.session.get({ addInFlight: false, lastAdd: null });
  if (lastAdd) await consumeLastAdd();
  setAddBusy(addInFlight === true);
}

/**
 * Show how an add went — wherever the answer comes from.
 *
 * This used to live in the continuation after the popup's own sendMessage,
 * which only runs if the popup is still there when the answer arrives. It
 * usually is not: Firefox closes the popup on the first click outside it, and
 * an add against a sleeping NAS takes far longer than that. The result was
 * lost, the links stayed in the box as though nothing had happened, and
 * pressing the button again added every one of them a second time.
 *
 * The background now leaves the outcome in session storage and this is the one
 * place that reads it, so a popup that stayed open and a popup that was
 * reopened do exactly the same thing with it.
 */
async function applyAddOutcome(result) {
  if (!result) return;

  // Files are named rather than put back: a file picker cannot be handed its
  // selection again, so a failed one has to be chosen once more by hand.
  const isFiles = Array.isArray(result.failedNames);
  const failed  = isFiles ? result.failedNames : (result.failedUrls ?? []);
  const added   = result.added ?? 0;

  if (result.success) {
    bulkStatusEl.textContent = isFiles
      ? msg('filesAdded', String(added))
      : msg('linksAdded', String(added));
    if (!isFiles) {
      clearLinksFailed();
      clearTimeout(draftSaveTimer);
      bulkLinksEl.value = '';
    }
  } else if (isFiles) {
    const names  = failed.join(', ');
    const reason = result.deliveryUnknown ? ` — ${msg('notifyUncertain')}`
      : result.errorMessage ? ` — ${result.errorMessage}` : '';
    bulkStatusEl.textContent =
      msg('linksPartial', String(added), String(result.failed ?? 0)) +
      reason + (names ? ` (${names})` : '');
  } else if (failed.length) {
    // Keep only what did not get through. Pressing the button again then
    // retries exactly those instead of adding the accepted ones twice.
    showLinksFailed(failed.length, result.errorMessage, result.deliveryUnknown);
    bulkStatusEl.textContent = added > 0 ? msg('linksAdded', String(added)) : '';
    clearTimeout(draftSaveTimer);
    bulkLinksEl.value = failed.join('\n');
  } else {
    bulkStatusEl.textContent = errText(result.error, 'addLinksFailed');
  }

  if (added === 0) return;

  startAutoRefresh();
  startBurstRefresh(result.at);

  // Where the new downloads are, and the only tab on which the close watch
  // above actually runs — activateTab fetches the list on arrival. Two things
  // hold it back. A partial failure has left a marked box and a reason on this
  // tab, and moving away would hide the one thing that still needs a decision.
  // And a result read minutes later is worth reporting but not worth pulling
  // someone off the tab they just chose to open; the watch has expired by then
  // anyway, so there would be nothing to see move.
  if (result.success && isBursting()) activateTab('tasks');
}

/**
 * Take the last add's result and clear it, so it is acted on exactly once.
 */
function consumeLastAdd() {
  if (consumingAdd) return consumingAdd;
  consumingAdd = (async () => {
    const { lastAdd } = await browser.storage.session.get({ lastAdd: null });
    if (!lastAdd) return;
    await applyAddOutcome(lastAdd);
    await browser.storage.session.remove('lastAdd');
  })().finally(() => {
    consumingAdd = null;
    syncAddControls();
  });
  syncAddControls();
  return consumingAdd;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if ('addInFlight' in changes) {
    if (changes.addInFlight.newValue === true) setAddBusy(true);
    else if (popupReady) loadAddBusy();
  }
  // The background can put a link back into the list: a retry that removed the
  // original task and then could not add it again. That happens during an add,
  // while the field is read-only, so nothing typed here can be overwritten —
  // outside that window a change is only the echo of our own draft save.
  if ('bulkDraft' in changes && bulkLinksEl.readOnly) {
    const value = changes.bulkDraft.newValue ?? '';
    if (value !== bulkLinksEl.value) {
      clearTimeout(draftSaveTimer);
      bulkLinksEl.value = value;
    }
  }
  // Written by the background the moment an add finishes. The removal in
  // consumeLastAdd arrives here as the same key with no new value; ignore it.
  if (popupReady && 'lastAdd' in changes && changes.lastAdd.newValue) consumeLastAdd();
});

/**
 * Hand an add to the background and deal with the answers that mean nothing was
 * attempted. The outcome itself comes back through applyAddOutcome — the one
 * path that also works when this popup did not live long enough to see it.
 *
 * Shared by links and files, which each carried a copy. `prepare` builds the
 * message and may take a while: reading files does. The connection is fixed
 * before it runs, and the background refuses the add if another has been
 * configured since. Taken when the message went out instead, a torrent file
 * read while a new connection was saved was uploaded to the new NAS.
 */
async function sendAdd(status, prepare) {
  localAddsPending++;
  syncAddControls();
  bulkStatusEl.textContent = status;
  try {
    // A save that was already under way decides where this goes.
    await settingsSaves;
    const connection = connectionKey(settings);
    const result = await browser.runtime.sendMessage({ ...await prepare(), connection });
    if (result.setupRequired) {
      bulkStatusEl.textContent = msg('setupRequired');
      promptForSetup();
    } else if (result.busy) {
      // Another popup, or this one before it was closed, already started this.
      bulkStatusEl.textContent = msg('addBusy');
    } else {
      // The storage listener has almost certainly done this already. Asking
      // again costs one read and means a popup that is still here does not
      // depend on that notification having arrived; consumeLastAdd clears the
      // result as it takes it, so whichever gets there first is the only one
      // that acts.
      await consumeLastAdd();
    }
  } catch (err) {
    bulkStatusEl.textContent = err.message || msg('addLinksFailed');
  } finally {
    // The background owns the flag, so read it back rather than assume this
    // call was the one holding it — a refused add leaves someone else's still
    // running, and clearing it here would free the button against them.
    localAddsPending--;
    await loadAddBusy();
  }
}

async function addBulkLinks() {
  if (btnAddBulk.disabled) return;
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

  clearLinksFailed();
  await sendAdd(msg('addingLinks', String(urls.length)), async () => {
    clearTimeout(draftSaveTimer);
    await browser.storage.session.set({ bulkDraft: bulkLinksEl.value });
    return {
      action: ACTIONS.ADD_TASKS_BULK,
      urls,
      unzipPassword: extractEl.checked ? unzipPassEl.value : '',
    };
  });
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

  await sendAdd(msg('addingFiles', String(chosen.length)), async () => ({
    action: ACTIONS.ADD_TASK_FILES,
    // File objects don't survive runtime messaging, so send the bytes.
    files: await Promise.all(chosen.map(async (f) => ({
      name: f.name,
      buffer: await f.arrayBuffer(),
    }))),
    unzipPassword: extractEl.checked ? unzipPassEl.value : '',
  }));
});

// ---------------------------------------------------------------------------
// Bulk task actions
// ---------------------------------------------------------------------------

/**
 * Say why an action did not work, or clear the line when one did.
 *
 * Every one of these used to be sent and forgotten. The NAS could refuse a
 * pause, a delete or a retry and the only visible result was a list that
 * redrew unchanged — indistinguishable from a button that does nothing.
 */
function reportActionResult(result) {
  const failed = !result || result.success === false;
  taskStatusEl.hidden = !failed;
  taskStatusEl.textContent = failed ? errText(result?.error, 'taskActionFailed') : '';
  return !failed;
}

/**
 * Whether the action may have taken effect after all. An unconfirmed task is
 * not a refused one, and the same goes for a create whose delivery is unknown —
 * keeping the watch running is what shows the user which of the two it was.
 */
function mayHaveTakenEffect(result) {
  return (result?.unconfirmed?.length ?? 0) > 0 || result?.deliveryUnknown === true;
}

async function runBulkAction(action, button, connection = tasksConnection) {
  button.disabled = true;
  try {
    // The list's origin travels along: "Delete all" confirmed while looking at
    // the old NAS must not clear out a newly configured one.
    const result = await browser.runtime.sendMessage({ action, connection });
    const ok = reportActionResult(result);
    await refreshTasks();
    if ((ok || mayHaveTakenEffect(result)) && action === ACTIONS.RESUME_ALL) startAutoRefresh();
  } catch (err) {
    taskStatusEl.hidden = false;
    taskStatusEl.textContent = err.message || msg('taskActionFailed');
  } finally {
    button.disabled = false;
  }
}

btnPauseAll.addEventListener('click', () => runBulkAction(ACTIONS.PAUSE_ALL, btnPauseAll));
btnResumeAll.addEventListener('click', () => runBulkAction(ACTIONS.RESUME_ALL, btnResumeAll));

/**
 * The list "Delete all" is being confirmed against. Taken when the question is
 * asked, not when Yes is pressed: in between, the connection can change and a
 * new list arrive, and Yes would then empty a NAS nobody was asked about.
 */
let deleteAllConnection = null;

// Deleting everything is irreversible, so it takes a second, deliberate click.
btnDeleteAll.addEventListener('click', () => {
  deleteAllConnection = tasksConnection;
  deleteAllBar.hidden = false;
  btnDeleteNo.focus();
});
btnDeleteNo.addEventListener('click', () => { deleteAllBar.hidden = true; });
btnDeleteYes.addEventListener('click', async () => {
  deleteAllBar.hidden = true;
  await runBulkAction(ACTIONS.DELETE_ALL, btnDeleteYes, deleteAllConnection);
});

// ---------------------------------------------------------------------------
// Transfer statistics
// ---------------------------------------------------------------------------

/**
 * Total throughput in the header, added up from the tasks we already have.
 *
 * This used to be its own API call to SYNO.DownloadStation.Statistic on every
 * refresh — a second request per tick, 1200 an hour at the three-second
 * setting, for two numbers the task list already carries.
 *
 * The two are not quite the same figure: the API reports what Download Station
 * is doing overall, this reports what its tasks are doing. Any difference is
 * traffic that has no task behind it, which is not what the header is for.
 */
function updateTotalSpeed(tasks) {
  let down = 0;
  let up   = 0;
  for (const task of tasks) {
    down += nonNegativeNumber(task.additional?.transfer?.speed_download);
    up   += nonNegativeNumber(task.additional?.transfer?.speed_upload);
  }

  const downText = formatSpeed(down);
  const upText   = formatSpeed(up);
  if (!downText && !upText) { totalSpeedEl.hidden = true; return; }

  totalSpeedEl.hidden = false;
  totalSpeedEl.textContent = msg('totalSpeed', downText ?? '0', upText ?? '0');
}

// ---------------------------------------------------------------------------
// Task action delegation (pause / resume)
// ---------------------------------------------------------------------------

taskListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, taskId, uri, destination } = btn.dataset;
  btn.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({
      action, id: taskId, uri, destination,
      // Task ids are only unique on one NAS; the background refuses the action
      // unless this still names the configured connection.
      connection: tasksConnection,
      // A retried archive needs the same password the original add used.
      unzipPassword: extractEl.checked ? unzipPassEl.value : '',
    });
    const ok = reportActionResult(result);
    await refreshTasks();
    // Resuming or retrying makes a task active again — re-arm the timer.
    if ((ok || mayHaveTakenEffect(result))
      && (action === ACTIONS.RESUME_TASK || action === ACTIONS.RETRY_TASK)) startAutoRefresh();
  } catch (err) {
    taskStatusEl.hidden = false;
    taskStatusEl.textContent = err.message || msg('taskActionFailed');
  } finally {
    // btn may already be replaced by refreshTasks re-render; safe to ignore
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

// The only place the connection details are written. Incomplete details are
// refused outright rather than half-saved: storing an empty password would
// drop the working one and leave nothing to sign in with.
btnSaveConn.addEventListener('click', () => {
  if (!connFieldsFilled()) {
    promptForSetup();
    return;
  }
  saveSettings({ forceTest: true, feedbackOn: btnSaveConn, commitConn: true });
});
// The destination is the one option that is not applied while you type it:
// it takes effect on this button or on Enter, and nowhere else.
btnSaveDest.addEventListener('click', () => saveSettings({ feedbackOn: btnSaveDest, commitDest: true }));
destEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  saveSettings({ feedbackOn: btnSaveDest, commitDest: true });
});
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
    const result = await browser.runtime.sendMessage({ action: ACTIONS.CLEAR_COMPLETED, connection: tasksConnection });
    reportActionResult(result);
    await refreshTasks();
  } catch (err) {
    taskStatusEl.hidden = false;
    taskStatusEl.textContent = err.message || msg('taskActionFailed');
  } finally {
    btnClear.disabled = false;
  }
});
// Every option applies the moment it changes — no save button for this block.
// The destination is deliberately not in this list: it is a path the NAS has to
// accept, and applying it halfway through typing would send downloads to a
// folder nobody meant. It waits for Enter or its own button; until then it is
// only a draft.
for (const el of [autoMagnetEl, keepaliveEl, notifyEl,
                  notifyAddedEl, notifyFailedEl, notifyDoneEl, extractEl,
                  refreshIntEl, sortDirEl, perPageEl]) {
  el.addEventListener('change', () => saveSettings());
}
// Swap the direction dropdown for the order list as soon as the sort changes,
// so the control matches the selection before anything is saved.
sortByEl.addEventListener('change', () => { syncSortControls(); saveSettings(); });

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = ['add', 'tasks', 'settings'];

/** Which tab is on screen. The refresh timer depends on it. */
let activeTab = 'add';

/**
 * Switch tabs.
 *
 * `remember` is false where the extension moved you itself — an unconfigured
 * connection, a two-step prompt. Those are interruptions, not a choice, and
 * recording them would mean the popup reopens on Settings long after the
 * problem was dealt with.
 */
function activateTab(name, { remember = true } = {}) {
  const arriving = name !== activeTab;
  activeTab = name;

  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    // Roving tabindex: one stop for the whole strip, arrows move within it.
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.dataset.panel === name);
  }

  // The timer is paused off this tab, so the list can be a few seconds stale
  // when you come back. Fetch once immediately rather than showing the old
  // figures until the next tick.
  syncRefreshTimer();
  if (arriving && name === 'tasks' && refreshWanted) refreshTasks();

  // Remembered for as long as the browser is running, so reopening the popup
  // puts you back where you were. storage.session, not local: once Firefox
  // closes the trail is stale and the chosen start tab takes over again.
  if (remember) browser.storage.session.set({ lastTab: name });
}

/** Mark which house is lit — the tab the popup opens on. */
function syncHomeButtons() {
  for (const b of document.querySelectorAll('.home')) {
    b.setAttribute('aria-pressed', String(b.dataset.home === settings.startTab));
  }
}

const tabsEl = document.getElementById('tabs');

tabsEl.addEventListener('click', (e) => {
  const home = e.target.closest('.home');
  if (home) {
    // Picking a start page should not also switch to it — you are usually
    // setting it for next time, not asking to go there now.
    settings.startTab = home.dataset.home;
    browser.storage.local.set({ startTab: settings.startTab });
    syncHomeButtons();
    return;
  }
  const tab = e.target.closest('.tab');
  if (tab) activateTab(tab.dataset.tab);
});

/**
 * Arrow keys move between tabs, Home and End jump to the ends — what the tab
 * role promises anyone navigating by keyboard. Without it the roving tabindex
 * would leave the other two tabs unreachable.
 */
tabsEl.addEventListener('keydown', (e) => {
  const current = e.target.closest('.tab');
  if (!current) return;

  const tabs = [...tabsEl.querySelectorAll('.tab')];
  const i = tabs.indexOf(current);
  let next = null;

  if (e.key === 'ArrowRight')     next = tabs[(i + 1) % tabs.length];
  else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home')      next = tabs[0];
  else if (e.key === 'End')       next = tabs[tabs.length - 1];
  else return;

  e.preventDefault();
  activateTab(next.dataset.tab);
  next.focus();
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
    syncAddControls();
    applyStaticLocalization();

    // Load all persisted state before touching the UI
    await Promise.all([
      loadSettings(), loadFilterState(), loadDraft(), loadSectionStates(),
    ]);
    // After loadSettings, so unsaved edits win over the last saved values.
    await loadConnDraft();

    // The interface is complete and translated at this point, so show it.
    // Everything below this line talks to the NAS, and a sleeping one can take
    // the better part of a minute to answer — spent behind an overlay that
    // would look like a popup that has hung. The header's status line carries
    // the waiting instead: it says "Connecting…" until the tasks arrive.
    overlay.style.display = 'none';
    setStatus('checking', msg('connecting'));
    // Where you left off this session, otherwise the tab the little house
    // marks. Overridden below when the connection is not set up yet.
    const { lastTab } = await browser.storage.session.get({ lastTab: null });
    activateTab(TABS.includes(lastTab) ? lastTab : settings.startTab);

    // An add that finished while the popup was closed left its result behind.
    // After the tab is chosen, so a fresh one may override it; after loadDraft,
    // so the box it prunes is the restored one.
    popupReady = true;
    await loadAddBusy();

    // A download attempted before setup flags the popup to land on Settings.
    let cameFromFailedDownload = false;
    try {
      const flag = await sendWithRetry(ACTIONS.CONSUME_SETUP_FLAG);
      cameFromFailedDownload = !!flag?.setupRequired;
    } catch {
      // Background not ready — the isConfigured() check below still covers us.
    }

    // Nothing works without host + credentials, so Settings wins over the
    // chosen start tab until they exist.
    if (!isConfigured()) {
      promptForSetup();
      showMessage(msg('setupRequired'), true);
      return;
    }
    if (cameFromFailedDownload) {
      // Configured but the attempt still failed setup — show Settings anyway.
      activateTab('settings');
    }

    // Ask the background whether it already has a live session — an instant
    // memory check, and at the same time what wakes a suspended event page.
    let status;
    try {
      status = await sendWithRetry(ACTIONS.GET_STATUS, 5, 150);
    } catch {
      setStatus('error', msg('backgroundUnavailable'));
      showMessage(msg('noTasks'));
      return;
    }

    if (status.connected) {
      setStatus('connected', msg('connected'));
      refreshTasks();
      startAutoRefresh();
      return;
    }

    // No session yet. attemptConnect logs in and puts its own reason in the
    // list area on failure — including a two-step prompt if DSM asks for one.
    await attemptConnect();
  } finally {
    overlay.style.display = 'none';
  }
})();
