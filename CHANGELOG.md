# Changelog

All notable changes to this extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-09-02

### Added

- Three tabs — **Add**, **Tasks**, **Settings** — so the task list gets the
  popup's full height: seven visible entries instead of two. A house icon on
  each tab picks which one the popup opens on.
- Notification when the last download finishes, with what became of the ones
  that were running: completed, failed, paused.
- Notification settings: a master switch and three of its own (added, failed,
  finished). Sign-in and destination-folder problems are always reported —
  those break every download rather than one.
- *Save and test connection*, which tests immediately including the two-factor
  prompt; *Sign out*; *Reset all settings*.
- For half a minute after an add the task list refreshes every three seconds,
  then falls back to the interval in the settings. Small downloads used to
  start, run and finish inside one tick of the normal interval, so the only
  thing ever seen of them was *Finished*.
- A notification when the NAS turns out to be asleep, for downloads started
  from the context menu or a magnet link. Those have no window to report
  progress in, and half a minute of silence is indistinguishable from a menu
  entry that does nothing.

### Security

- Every request that carries a password or a session id goes out as POST, so
  neither is written to the NAS's web server log. The task list was the one that
  mattered: it is fetched every few seconds and used to put a working session id
  in that log each time.
- Unsaved connection details no longer outlive the browser. A password typed
  but never saved was held in permanent storage; drafts live in session storage
  now and are discarded when Firefox closes.

### Fixed

- **A sleeping NAS is waited out** instead of being reported as an error.
  Requests are retried for about half a minute, which is roughly how long a NAS
  takes to wake its disks. A refusal it actually sends still appears at once.
- **Connection details are only written by their own save button.** Clearing
  the password field used to be picked up by the next unrelated save — a toggle
  click — which wiped the stored password. Incomplete details are now refused
  and named rather than stored, and an emptied field comes back as the stored
  value.
- **Adding a link can no longer add it several times.** A request that ran into
  the extension's own timeout was repeated, so a slow NAS that had in fact
  received it ended up with the download two, three or four times over — while
  the popup reported failure and left the links in the box to be sent again.
  Requests that change something are now only repeated when the connection
  demonstrably never came up, and one add at a time is allowed no matter how
  often the popup is closed and reopened. Since such a request gets a single
  attempt, adding starts by waking the NAS with a harmless read and waiting for
  it to answer, so a spun-down disk is no longer reported as a failure.
- **The result of an add survives the popup closing.** Firefox destroys the
  popup as soon as anything outside it is clicked, and everything that happens
  after an add — emptying the box, putting the refused links back, saying how
  many got through — used to run inside that popup. Against a sleeping NAS it
  was regularly gone by then, so the links sat there as though nothing had
  happened and pressing the button again added every one of them a second time.
  The outcome is now handed over rather than reported in place, and shown
  whenever the popup is next opened.
- Adding from the context menu or a magnet link waits its turn instead of
  running alongside another add. Two right-clicks in a row are two different
  links, so the second is queued rather than turned away.
- A download started from the context menu that ran into the extension's own
  timeout is no longer called a failure. Whether the NAS received it cannot be
  known, and saying "failed" invited a second right-click that queued it twice.
- After a partial failure the box keeps only the links the NAS refused, marked
  and with the reason, so trying again cannot duplicate the ones that worked.
- The task list no longer stops refreshing right after an add. Arming the timer
  and then asking for the list raced: a NAS that had not registered the new task
  yet answered "nothing running", which switched off the very watch the add had
  just started.
- Changing an option no longer signs the DSM session out, discards a password
  that was typed but not yet saved, or sends the task list back to page one.
- Pause, resume, retry, remove and the bulk actions say why they failed instead
  of appearing to do nothing.
- Saving works while the background service is asleep.
- The popup stops asking an unreachable NAS after five attempts, as the
  background poll already did.
- Background polling gives up on an unreachable NAS instead of retrying every
  minute, and no longer asks it for the API paths twice per call.
- The Credentials block remembers whether it is open.
- Four task states were shown as raw API values in every language: seeding,
  finishing, hash checking, waiting for a file host.

### Changed

- Options apply as they are changed; the connection and the destination folder
  wait for their save button.
- *Task refresh interval* is now *Background task refresh interval*, since the
  half minute after an add no longer uses it.
- Every task has its own remove button, now 24×24 px so it meets the minimum
  target size — the card gained a single pixel, so the list still shows as many
  tasks. *Tasks per page* defaults to 10. Failed sorts right behind Active.
- The status badge moved up beside the file name, which gives every progress bar
  the same width and gives the longer status wordings room.
- Settings are grouped into Connection, Downloads, Notifications, Tasks and
  Advanced options.
- Interface reworked throughout: every text, icon, outline and status colour
  measured against WCAG 2.1 rather than eyeballed, toggle switches instead of
  checkboxes, and the popup appears straight away with "Connecting…" in the
  header instead of behind an overlay. Switches, secondary buttons, the failure
  reason on a task and the progress groove were the last to be brought up.
- The tabs carry proper tab semantics and answer the arrow keys, the popup
  reports its language instead of always claiming English, and the status line
  is announced rather than only drawn.

### Internal

- One API call per refresh removed, and the popup stops polling while the Tasks
  tab is off screen.
- Message names and the settings defaults live in one shared file; duplicated
  code folded together; the runtime layout measurement replaced by ordinary CSS.
- Icons that appear twice are drawn once and referenced. The two bins had
  quietly become different drawings — the smaller one was missing the strokes
  inside the body.

## [1.0.2] — 2026-08-30

First public release, published as **Synology - Download Station Manager**.

Continues the development of the original *Download Station* add-on under the
same licence (MPL-2.0), with its own extension ID and version numbering.

### Features

- Add links one at a time, as a pasted list, by right-click (including every
  link in a multi-line selection), or as `.torrent` / `.nzb` uploads. Lists
  longer than 50 are split to match the API limit.
- Optional automatic interception of `magnet:` links.
- Task list with filter counts, sorting (status order is drag-to-reorder, or by
  date added, name, progress, size) and paging at 25/50/100.
- Per-task pause, resume, retry and remove; bulk pause, resume, clear finished
  and delete all.
- Live progress, per-task and total transfer rates, extraction progress.
- Every documented API error code and all 26 task failure reasons translated
  into actionable messages.
- Two-factor authentication (experimental).
- Six languages: English, German, Spanish, French, Brazilian Portuguese,
  Russian.
- Adaptive polling that stops on its own, and an optional session keepalive
  that is off by default so the NAS's disks can hibernate.

[1.1.0]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/releases/tag/v1.0.2
