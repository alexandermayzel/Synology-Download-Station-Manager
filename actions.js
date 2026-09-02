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

  // Adding
  ADD_TASKS_BULK:     'addTasksBulk',
  ADD_TASK_FILES:     'addTaskFiles',

  // Reading
  LIST_TASKS:         'listTasks',
  GET_STATUS:         'getStatus',
  GET_DS_INFO:        'getDsInfo',
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
