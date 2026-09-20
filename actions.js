/**
 * Download Station — constants shared by the popup and the background.
 *
 * Two kinds live here, both for the same reason: they were written out twice
 * and had no way of staying in step.
 *
 * The message names used to be bare strings in two files. A typo in one of them
 * fails silently in the worst way: the background simply has no case for it, so
 * `respondWith` never runs, no response is ever sent, and the popup waits for an
 * answer that is not coming. Referring to a property instead turns that into an
 * immediate ReferenceError at the call site.
 *
 * The settings defaults were a verbatim copy of twelve keys. A default changed
 * in one file and not the other means the popup and the background disagree
 * about what the extension does before anything has been saved — the kind of
 * difference nothing reports and nobody finds by reading either file alone.
 *
 * Loaded as a plain script before the others, so it works the same in the
 * background and in the popup without a module system.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const ACTIONS = Object.freeze({
  // From the content script, which is the one place that cannot use this list:
  // it runs on every page, and loading this file beside it would put a second
  // file on all of them for one string. content.js repeats the value verbatim
  // and says so — change it here and it has to change there too.
  MAGNET_CLICKED:     'magnetClicked',

  // Adding. Files have no entry: a .torrent is added by its link, through the
  // context menu — see the hint in the popup's Files section.
  ADD_TASKS_BULK:     'addTasksBulk',

  // Reading
  LIST_TASKS:         'listTasks',
  GET_STATUS:         'getStatus',
  CONSUME_SETUP_FLAG: 'consumeSetupFlag',

  // Acting on one task. These four travel in the task card's data-action
  // attribute, so their values appear in popup.html as well.
  PAUSE_TASK:         'pauseTask',
  RESUME_TASK:        'resumeTask',
  RETRY_TASK:         'retryTask',
  DELETE_TASK:        'deleteTask',

  // Acting on many
  PAUSE_ALL:          'pauseAll',
  RESUME_ALL:         'resumeAll',
  DELETE_ALL:         'deleteAll',
  CLEAR_COMPLETED:    'clearCompleted',

  // Settings
  TEST_CONNECTION:    'testConnection',
  SETTINGS_UPDATED:   'settingsUpdated',
});

/**
 * Settings both sides need to agree on.
 *
 * The popup owns several more — how the task list is sorted, paged and
 * refreshed, which tab opens first — and adds them to these. Those never reach
 * the background, so they stay where they are used.
 */
const SETTINGS_DEFAULTS = Object.freeze({
  protocol: 'https',
  host: '',
  port: 5001,
  username: '',
  password: '',
  autoCaptureMagnets: false,
  defaultDestination: '',
  keepaliveEnabled: false,
  notificationsEnabled: true,
  notifyOnAdded: true,
  notifyOnFailed: true,
  notifyOnFinished: true,
});

/** The three fields without which no API call can succeed. */
function hasCredentials(settings) {
  return !!(settings.host && settings.username && settings.password);
}

/**
 * Fill every [data-i18n] element of `root` from _locales.
 *
 * `translate` is passed in rather than taken from the page: the popup declares
 * its own `msg`, and a second one here would be a redeclaration in the
 * background's global scope, where this file also loads.
 *
 * Templates are localized too — document.querySelectorAll does not descend into
 * <template> content, so their DocumentFragments are passed explicitly.
 */
function localizeTree(root, translate) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = translate(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = translate(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = translate(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', translate(el.dataset.i18nAriaLabel));
  }
}

const CONNECTION_KEYS = Object.freeze(['protocol', 'host', 'port', 'username', 'password']);

function connectionSettings(settings) {
  return Object.fromEntries(CONNECTION_KEYS.map(key => [key, settings[key]]));
}

/**
 * Which NAS and account something belongs to: a task list, or an add the popup
 * is sending.
 *
 * Task ids are only unique within one Download Station, so an id means nothing
 * without this. The password is left out: changing it does not change whose
 * tasks these are. Here rather than in the background because the popup has to
 * build the same key for an add, before it knows what the background will say.
 */
function connectionKey(settings) {
  return JSON.stringify([settings.protocol, settings.host, String(settings.port), settings.username]);
}

/** DSM may return numeric fields as JSON strings. */
function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/**
 * Task statuses that mean the NAS is still working on something, so it is worth
 * asking again. Deliberately not everything the popup files under "active":
 * seeding shows there too but can go on forever, and waiting for it would never
 * end. The popup's refresh and the background's watch both decide by this, and
 * two copies of the list could drift apart without anyone noticing.
 */
const WORKING_STATUSES = Object.freeze([
  'downloading', 'waiting', 'extracting', 'finishing', 'hash_checking', 'filehosting_waiting',
]);

/**
 * Which statuses a pause or a resume may be offered for.
 *
 * Shared for the same reason as the list above: the popup decides whether a
 * card gets the button, the background decides which tasks "Pause all" covers,
 * and the two had drifted apart — a task waiting on a file host was picked up
 * by the bulk action but had no button of its own.
 */
const PAUSABLE  = Object.freeze(['downloading', 'waiting', 'filehosting_waiting']);
const RESUMABLE = Object.freeze(['paused', 'stopped']);

function canPauseTask(status) {
  return PAUSABLE.includes(String(status ?? '').toLowerCase());
}

function canResumeTask(status) {
  return RESUMABLE.includes(String(status ?? '').toLowerCase());
}

function isWorkingTask(task) {
  return WORKING_STATUSES.includes(task?.status?.toLowerCase());
}
