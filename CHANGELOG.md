# Changelog

All notable changes to this extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.1.4] — 2026-09-23

### Added

- Hint on an IP address under HTTPS that the certificate must match the entered
  address, and that the host name the certificate covers is the one to use.
- A refused certificate is now named as such instead of being reported as an
  unreachable NAS, quoting the browser's own explanation of what does not match.
  This uses the new `webRequest` permission, which Firefox grants without asking
  and which is only ever consulted for this extension's own requests to the NAS.
  Firefox's explanation can arrive shortly after the request has failed; the
  extension waits up to half a second for it and continues as soon as it
  arrives. Each reason is tied to the request that met it by the browser's own
  request id. Where no id is given and two requests to one address overlap, the
  general message stands.
- The whole reason for a refused connection stands above the connection fields
  in *Settings → Connection*: the address, the browser's wording and what to
  check. It wraps instead of being cut off, can be selected and copied, is still
  there after the popup has been closed and reopened, and goes as soon as
  anything answers at that address again. Delayed processing of an earlier
  failure cannot restore it after a successful response. The attempts that follow
  a refusal usually come back as a NAS that did not answer; the panel says so and
  keeps the browser's wording as the last precise reason rather than a fresh verdict.
  *Test* and *Save and test connection* unfold the section and put it in front
  of you. The notification stays short and points there — it shows one line and
  cuts off the rest, which is exactly where the explanation used to disappear.
  If a later task-list check answers, its result replaces the earlier certificate
  error in the notification as well.

### Fixed

- Seeding torrents can be paused. They had no pause button, and *Pause all*
  walked past them while the upload carried on.
- Magnet links inside an embedded frame are captured. Only the top document was
  reached before.
- Magnet links in SVG graphics are sent as URLs; their clicks were intercepted
  but the link target was passed as an object instead of a string.
- IPv6 NAS addresses work with or without square brackets in the Host field.
- API refusals during an add's confirmation check are reported with their
  reason and stop the lookup. The add's outcome remains unconfirmed; a refused
  task list is not evidence that the download failed. For a right-click or a
  captured magnet link, the notification title states that uncertainty and
  asks the user to check Tasks, while its body gives the reason.
- *Retry* keeps the link when the NAS is changed after the old task has already
  been removed. Both the task and the link were lost before.
- *Retry* calls a task removed only when the NAS confirmed that very task. A
  reply that accepted the request while refusing the deletion, or that named no
  task at all, was reported as a removal when the NAS was switched in between.
- *Retry* names the reason a secure connection was refused, alongside saying the
  link has been kept.
- After a failed connection test, *Retry* respects the block on automatic
  sign-ins before waking the NAS or removing the old task.
- A failure reported by the NAS you have since left no longer blocks the one you
  switched to.
- Late background failures from the previous NAS no longer count toward stopping
  the new NAS's download watch.
- After a successful sign-in, older sign-in failures no longer block the
  connection — not even one that arrives while the connection test is still
  running or whose stored result is read late. A failure landing late, after the
  password had been corrected or a test had gone through, shut that working
  session out of the popup, which then read *Connected* while *Refresh* sent
  nothing at all.
- A keepalive answer about a session that has since been replaced no longer
  signs the new one out. A connection test that succeeded while the keepalive
  was away left the extension reporting itself as not connected.
- Keyboard focus stays on the same button when the task list refreshes, as long
  as that button is still there, and the list is not scrolled back to it. Every
  refresh rebuilt the list and the pager from scratch, and the focus went with
  them — every few seconds, with nothing on screen to say where.
- Switching the NAS while a download watch was finishing no longer signs the new
  connection straight out again.
- The badge keeps the newer count instead of being cleared by a slower
  background check that answered late.
- Pause, resume and delete name the reason a secure connection was refused,
  alongside saying the result is unconfirmed.
- The bundled Outfit webfont now ships with its licence. The font files carried
  the copyright notice and a link, but the SIL Open Font License asks for the
  text itself wherever the font travels; it is `fonts/OFL.txt`.

### Changed

- Certificate refusals that can be attributed to their request are reported at
  once, with the browser's reason. The automatic retries for them are gone; they
  were four attempts over thirty seconds that could not change the answer.
- Wording and translations improved throughout, in all six languages.
- The manifest now declares what is transmitted — authentication information for
  the credentials, website content for the links you hand over — where it
  previously declared `none`. Nothing has changed about where any of it goes: to
  the NAS you configured and nowhere else, with no telemetry and no third party.
  `none` was simply the wrong word for sending a password to anything at all.

## [1.1.3] — 2026-09-20

### Security

- NAS requests no longer follow redirects, preventing credentials and session
  IDs from being forwarded to another address.
- Archive passwords and two-factor codes are cleared on sign-out and connection
  changes.

### Added

- Extension version displayed in Settings.
- Warning that HTTP transmits passwords and session IDs unencrypted.

### Fixed

- Fixed unintended HTTP-to-HTTPS upgrades.
- Unanswered add requests are checked against the task list. Confirmed downloads
  are removed from the input; failed and unverified results are reported
  separately in both notifications and the popup.
- Links containing commas are rejected with an explanation to prevent the NAS
  from splitting them into separate downloads.
- *Retry* only creates a replacement after confirmed deletion. Messages
  distinguish failures before sending, unconfirmed deletion and unconfirmed
  replacement, preserving the link when needed.
- Two-factor verification blocks additional sign-ins to the same connection.
  Code submissions are not repeated after a lost response, and stale replies
  no longer reopen the code prompt.
- Popup login failures are retained across popup closure and trigger
  notifications. They block further automatic sign-ins while existing sessions
  remain usable.
- Rejected sign-ins stop bulk adds and confirmation checks. Authentication
  failures during confirmation also stop automatic popup refreshes.
- Connection, destination and link drafts survive immediate popup closure.
  Saving connection details preserves edits made while the save is pending.
- Invalid ports are rejected, cleared destinations remain empty, and resetting
  settings also clears previous error messages.
- Stale task lists no longer stop refreshes after resuming a download.
  Individual pause buttons now cover all tasks supported by *Pause all*.
- Fixed premature monitoring stops caused by overlapping resume, keepalive
  and login operations.
- Task actions distinguish connection failures before sending from unconfirmed
  results after sending.
- Connection status follows refresh results without overwriting newer login
  results. Full error messages appear below the header and in its tooltip.
- Folder errors describe the destination actually used, distinguishing an
  explicit path from the NAS default.
- Completion notification titles now match the completed, failed and paused
  task counts.

### Changed

- Improved screen-reader feedback for filters and pagination, and corrected
  the popup's document language.
- Magnet capture supports uppercase protocol names and links in open shadow DOM.
- Increased the NAS wake-up wait to 60 seconds and the base add timeout to
  25 seconds, with additional time per link.
- Clarified that the refresh interval controls the popup task list;
  background monitoring runs independently.
- Reworded the texts for the destination folder, the two-factor code, the NAS
  connection and the extension's own description.

### Removed

- Removed local `.torrent` and `.nzb` uploads: the file picker could close the
  popup, and the tested DSM endpoint required the session ID in the URL.
  Torrent links remain supported through the context menu.

## [1.1.2] — 2026-09-14

### Security

- Magnet capture only reacts to clicks made by the user. A web page can no
  longer send a download to the NAS by clicking a magnet link from a script.
- A delayed login, including two-factor authentication, cannot restore a
  session or device token after sign-out, reset or a connection change.

### Fixed

- Adding downloads: a create is never repeated automatically after a network
  error, and uncertain outcomes are reported as such, including file uploads.
  A NAS that could not be woken, or a sign-in that got no answer, is reported
  as a plain failure, since nothing was sent.
- Task actions: pause, resume and delete check the result per task, and tasks
  the NAS did not confirm are no longer shown as failed. Retry re-adds a task in
  its original folder only once the original is confirmed deleted; if that
  fails, the link goes back into the Links list.
- Connection changes: the old NAS is signed out with its own session, and the
  old task list disappears at once. Task actions, "Delete all", queued links,
  files still being read and remaining batches cannot reach the new NAS.
- Background monitoring: it restarts after a resume and when the task list
  shows running downloads. Polls run one at a time and their failure count
  survives the background page being unloaded, so the failure limit works
  again, also when signing in again fails; a refused sign-in ends the watch at
  once. A newer task list outranks an older answer, and the completion
  notification counts downloads seen running in either. An unanswered
  keepalive or a logout in progress no longer takes the session away, and DSM
  code 119 leads to a new sign-in.
- Two-factor: a code needed while the task list refreshes is asked for instead
  of being reported as an ordinary error, and nothing refreshes on its own
  until it is entered.
- Settings saved in quick succession no longer overwrite each other, and saving
  the connection keeps a destination folder that was typed but not saved.
- Sizes, dates and transfer rates returned as text are handled numerically.
- Closing the popup while an add result is shown cannot restore accepted links.

### Changed

- While downloads are being added, the link list is read-only and the add and
  clear-list buttons are disabled until the result is shown. Links can still
  be copied.
- Sign-out and two-factor messages were clarified.
- The keepalive skips its request when the same session reached the NAS within
  the last three minutes, also after the background page was unloaded.
- Internal clean-up: unused code was removed and the active task statuses are
  defined once. Changing unrelated settings no longer redraws the task list, and
  changing pages reuses the prepared sort order. Drafts left by older versions
  are cleared once on update instead of on every popup open, and links and files
  share one way of handing an add to the background.
- Added regression tests.

## [1.1.1] — 2026-09-02

### Changed

- The descriptions of automatic extraction were made precise, in the extension's
  hints and in the README. It is switched on per account under *Download Station
  → Settings → Auto extract*, and is off by default.
- The archive-password hint now says that Download Station keeps the password in
  its own Password List, and that the field applies to links added from the
  popup.

### Removed

- The `SYNO.DownloadStation.Info` call and its `is_manager` check, which the new
  wording no longer needs. It was the only use of that API.

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

- Every request that carries a password or a session id goes out as POST, with
  those values in the body instead of the URL. The task list was the one that
  mattered: it is fetched every few seconds, and each fetch used to carry a
  working session id in its address.
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

[1.1.4]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/alexandermayzel/Synology-Download-Station-Manager/releases/tag/v1.0.2
