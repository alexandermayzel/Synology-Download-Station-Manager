# Synology - Download Station Manager

A Firefox extension that sends links, magnet links and torrent links to your
**Synology NAS** through the official Download Station Web API — and lets you
watch and manage the resulting tasks without opening DSM.

**[Install from addons.mozilla.org →](https://addons.mozilla.org/firefox/addon/synology-download-manager/)**

> **License:** Mozilla Public License 2.0. This project continues the
> development of the original *Download Station* Firefox add-on, which is
> published under the same license. See [LICENSE](LICENSE).

[Installation](#installation) ·
[Features](#features) ·
[Requirements](#requirements) ·
[NAS account](#setting-up-the-nas-account) ·
[Settings](#settings) ·
[Things to know](#things-to-know) ·
[Project layout](#project-layout)

---

## Installation

**From the store** — [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/synology-download-manager/)
→ *Add to Firefox*. Updates arrive on their own. The link carries no language
code on purpose; Mozilla redirects it to whatever your browser asks for.

**From an `.xpi`** — for a specific version. Take it from
[Releases](https://github.com/alexandermayzel/Synology-Download-Station-Manager/releases)
or from the store page under *See all versions*, then `about:addons` → gear icon
→ *Install Add-on From File…*. Dragging the file onto a Firefox window does the
same. Firefox installs only signed extensions, so a ZIP built straight from this
source will be refused.

**From source** — `about:debugging#/runtime/this-firefox` → *Load Temporary
Add-on…* → pick `manifest.json`. Survives until Firefox closes and needs no
signing. After an edit press *Reload* on that same page; automatic reloading is
what `web-ext run` is for.

<details>
<summary>Signing your own build (maintainers)</summary>

Mozilla will sign a build without publishing it in the store: sign in at
[addons.mozilla.org](https://addons.mozilla.org) → **Submit a New Add-on** →
**"On your own"**, upload a ZIP of this directory, download the signed `.xpi`.

`manifest.json` must sit at the **root** of the archive and the entry paths must
use forward slashes — Windows' `Compress-Archive` writes backslashes, which AMO
rejects.

Firefox Developer Edition, Nightly and ESR can skip signing entirely with
`xpinstall.signatures.required = false` in `about:config`. Release and Beta
cannot; the setting exists there but is ignored.

</details>

---

## Features

### Adding downloads

- **Paste a list of links**, one per line. Lists longer than 50 are split
  automatically — Download Station rejects more than 50 URIs per call. Links the
  NAS confirmed are removed from the box; refused ones stay, marked and with the
  reason. A link whose outcome could not be established stays as well, so check
  the task list before sending that one again.
- **Right-click any link** → *Download with Download Station*. Works on selected
  text as well, for sites that fake links with JavaScript, and picks out
  **every** link in a multi-line selection rather than just the first.
- **Torrent and NZB files** by their link — right-click it and the NAS fetches
  the file itself. Uploading one from the disk is not offered; see *No file
  upload* below for why.
- **Magnet links** can be intercepted automatically, so a click goes to the NAS
  instead of prompting for a torrent client, including links in embedded frames
  and SVG graphics. Off by default.
- **The list survives** a closed popup, so links can be collected across several
  visits. Cleared after a successful add, by *Clear list*, or when Firefox
  closes.
- **While adding**, the list is read-only and the add and clear-list buttons
  are disabled. Links can still be selected and copied. Editing is available
  again after the result is displayed, even if the popup was closed and
  reopened in the meantime; the downloads themselves can keep running.
- **Archive password** — optional field, sent as `unzip_password` with each task.
- **Links containing a comma** are turned down with a reason rather than sent.
  The API separates links with commas, so one address would arrive as two. This
  holds for every route in: the list, a right-click, a magnet link and *Retry* —
  and the retry checks before it deletes the task it is replacing.

### Watching and managing

- **Filter buttons with live counts** — All, Active, Waiting, Failed, Paused,
  Finished — plus sorting and pagination at 10/25/50/100.
- **Per task:** pause, resume, retry, remove — 24×24 px targets, the minimum
  WCAG 2.2 sets for a pointer. **In bulk:** pause all, resume all, clear
  finished, delete all.
- **Live progress**, transfer rates per task and total throughput. While an
  archive is unpacked the bar shows the extraction, not the already-full
  download.
- **Toolbar badge** with the number of running downloads.
- **Three tabs** — *Add*, *Tasks*, *Settings* — so the task list gets the popup's
  full height. The house icon on each tab picks which one the popup opens on.
- **A notification when the queue runs dry**, with what became of the downloads
  that were being watched: completed, failed, paused.

### Under the hood

- **Readable errors.** Every documented API error code and all 26 failure reasons
  from the Web API guide's Appendix B are translated — "wrong archive password",
  "volume is full" instead of a bare number.
- **API auto-discovery** via `SYNO.API.Info` (DSM 6 and 7+), capped at the
  versions this extension knows.
- **Adaptive polling.** A background check follows an added download to
  completion once a minute, then stops by itself.
- **Two-factor authentication** — enter the code once; the browser is registered
  as a trusted device, and background work reuses that token for as long as DSM
  accepts it.
- **Six languages** — English, German, Spanish, French, Brazilian Portuguese,
  Russian; follows the browser language.
- **Contrast measured, not eyeballed** — every colour checked against WCAG 2.1
  by calculation. See [Contrast](#contrast). The tabs carry real tab semantics
  and answer the arrow keys, and the popup reports the language it is actually
  showing.

---

## Requirements

| | |
|---|---|
| Firefox | **142 or newer** |
| NAS | DSM 6 or newer with the **Download Station** package installed |
| Account | A DSM account with Download Station access **and** read/write permission on the destination shared folder |

---

## Setting up the NAS account

Both of these are required — the first alone is not enough:

1. **Application access.** *Control Panel → User & Group → [user] →
   Applications* → allow **Download Station**.
2. **Folder permission.** *Control Panel → Shared Folder → [destination folder]
   → Permissions* → **Read/Write** for that user. Tasks are created with the
   permissions of the logged-in account, so without this you get error 403 even
   though the folder exists. For a sub-folder, make sure the permission applies
   to sub-folders too.

**Recommended:** a dedicated DSM account just for this extension — Download
Station access, write permission on exactly one folder, no admin rights.

<details>
<summary>Two-factor authentication (experimental)</summary>

When DSM asks for a code, the popup shows a field for it. That login also
registers this browser as a trusted device, and the returned token is reused from
then on, so background work does not prompt while DSM still accepts it. Revoke
the device in DSM and a code is asked for again. Changing the host, account or
password discards the token.

**Trade-off:** a stored device token is, by design, a standing bypass of the
second factor for this extension — anyone who can read the Firefox profile can
use it. Same exposure as the stored password, but worth knowing. DSM lists the
device under *Control Panel → Security → Account*, where the trust can be
revoked.

Signing out of the extension removes its stored credentials and device token.
To revoke the trusted device on the NAS as well, remove it in DSM.

</details>

---

## Settings

All settings live in the popup's **Settings** tab.

### Connection

| Field | Notes |
|---|---|
| Protocol | `https` (port 5001) or `http` (port 5000) |
| Host | IP, hostname or DDNS name of the NAS. IPv6 accepts both `fd00::1` and `[fd00::1]`; enter the port separately. **Not** `localhost` — that points at your own computer |
| Port | DSM web port |
| Username / Password | The DSM account from the section above |

Saved by its own button, not while typing. The Credentials block folds away on
save and stays however you leave it after that.

### Downloads

| Option | Default | Notes |
|---|---|---|
| Default destination | *(empty)* | Applied on Enter or its own save button. See [Destination folder](#destination-folder) |
| Auto-capture magnet links | **off** | Intercepts `magnet:` clicks on every page |
| Enter archive password | **off** | Shows the archive-password field. Extraction itself is set in DSM — see [Automatic extraction](#automatic-extraction-happens-on-the-nas) |

### Notifications

| Option | Default | Notes |
|---|---|---|
| Notifications | **on** | Master switch, with three of its own below: downloads added / failed / finished |

### Tasks

| Option | Default | Notes |
|---|---|---|
| Task refresh interval | 10 s | 3 / 10 / 30 seconds, or manual. Runs only while tasks are active. For 30 seconds after an add, the list refreshes every 3 seconds whatever this says, *Manual only* included |
| Tasks per page | 10 | 10 / 25 / 50 / 100 |
| Sort tasks by | By status | Plus a drag-to-reorder status priority, by default Active → Failed → Waiting → Paused → Finished |

### Advanced options

| Option | Default | Notes |
|---|---|---|
| Keep session alive in background | **off** | See [HDD hibernation](#hdd-hibernation) |

**Start tab** is not among them: the house icon on each tab picks which one the
popup opens on, solid on the chosen one, *Add* by default. Within a browser
session the popup reopens on whichever tab you last used; the house takes over
again once Firefox has been closed.

---

## Things to know

### Destination folder

Leave it empty to use the folder configured on the NAS itself (*DSM → Download
Station → Settings → General*). Filled in, the value is a path that **starts with
the name of the shared folder and carries no leading slash** —
`downloads/series`, not `/downloads/series` and not `/volume1/downloads/series`.

Unlike the other options it is not applied as you type: it takes effect on Enter
or its save button, which stays highlighted while the field differs from what is
stored. Two errors point here — **406**, neither the NAS nor the extension has a
destination set, and **403**, the folder is missing or the account cannot see it.

### What notifications cannot be switched off

The three switches cover downloads: added, failed, finished. **Sign-in failures**
and **destination folder problems** (errors 402, 403, 406, 407, plus 105 when the
account may not use Download Station) get through regardless — they break *every*
download rather than one, and suppressed, a right-click would simply appear to do
nothing. A link the NAS could not fetch is not in that list; silencing those is
what the switches are for.

### HDD hibernation

*Keep session alive in background* pings the NAS every three minutes so the popup
can show "Connected" the instant it opens. The ping is skipped when the same
session reached the NAS within that time anyway, as the download watch and an
open popup do. That traffic can stop the NAS parking its disks, which is why it
ships **off**. With it off the extension signs in when needed and hands the
session back when it is done — though not always the moment the last download
finishes; see [Sessions on browser close](#sessions-on-browser-close) for the
cases that hold a session open.

After a failed popup connection test, new automatic sign-ins are blocked,
including those needed to add downloads. Use **Test** or **Save and test connection**
to retry; an existing session can still be used. **Retry** respects this block
before checking whether the NAS is awake or removing the old task.

### Automatic extraction happens on the NAS

The extension's *Enter archive password* option only reveals the
archive-password field and hands that password to the NAS. The extraction is
Download Station's own, and it has two levels — which is what makes it easy to
get wrong:

1. **The service**, enabled once for the whole NAS. Only an administrator can
   switch it on.
2. **Per account**, in *DSM → Download Station → Settings → Auto extract →
   Enable Auto extract for downloaded files*. Every user sets this for
   themselves, **it is off by default**, and this is the one that usually
   explains why nothing gets extracted.

Neither is reachable through the documented Web API for an ordinary account:
`SYNO.DownloadStation.Info`'s `getconfig` and `setserverconfig` need manager
privilege, and they cover the service, not the per-account switch. So the
extension names the setting instead of trying to change it — reconfiguring
someone's NAS is not what an add-on that sends links should be doing.

The archive password is a different matter. It travels with the task as
`unzip_password`, and **Download Station keeps it**: the password turns up in its
Password List afterwards and is tried on later archives. The extension does not
save the archive password in browser storage.

### Where credentials are stored

Protocol, host, port, username, password and the destination folder live in
`browser.storage.local` — this profile only, **not** synced, **not encrypted**.
Anyone who can read your Firefox profile can read them, which is why a dedicated
least-privilege DSM account is the recommendation.

They have to persist: DSM sessions expire, and the extension signs in again on
its own when the poll alarm fires or you send a download from the context menu —
moments when nobody is there to type anything. Encrypting them would not help,
because the key would live in the same profile, and Firefox gives extensions no
access to its own password manager.

The following temporary data is cleared automatically:

| | Kept in | Gone when |
|---|---|---|
| Unsaved connection details | `storage.session` | Firefox closes |
| An unsaved destination folder | `storage.session` | Firefox closes |
| The pending link list | `storage.session` | Firefox closes |
| Connection diagnostic panel | `storage.session` | anything answers at that address again, or Firefox closes |
| The archive password | memory only, for this popup and any submission still running | the popup closes and any submission in progress has finished |

The drafts exist because Firefox closes the popup the moment you click anything
outside it — reaching for a password manager's toolbar button included.

Nothing secret travels in a URL. The password and the session id go to the NAS in
the body of a POST request rather than in the query string — the task list
included, which is fetched every few seconds and would otherwise put a usable
session id into every one of those request lines. What the NAS's web server
writes down is its own configuration; keeping the values out of the URL is the
part this extension controls.

### A sleeping NAS

Four mechanisms, at different points and for different reasons.

**Ordinary requests.** With the disks parked the first request may be refused
outright or simply left hanging, and it can be half a minute before the NAS
answers at all. Rather than report that as a failure, a request times out after
8 seconds and is quietly tried again — four attempts in total, ten seconds
apart — showing nothing beyond "Connecting…" in the header. An answer that says *no* — wrong password, missing folder — is never
repeated and appears at once.

A sign-in carrying a two-factor code is the exception: one attempt, 25 seconds,
and never repeated. A code is good for one use, and the NAS may have accepted it
with only the reply going missing — asking again would spend it a second time,
which DSM answers with "wrong code".

**Before an add, a wake check.** A create gets a single attempt, so adding starts
by knocking: a plain read with no session behind it, repeated in three-second
gaps for up to a minute until the NAS answers, then a couple of seconds for
Download Station to finish starting. A probe may be refused immediately or time
out after five seconds, so each knock costs little either way. One that never
answers is reported as unreachable after about a minute, with every link left in
the box.

**Then the add itself.** One attempt, and by now the NAS should be awake. The
create gets 25 seconds plus 300 milliseconds per link in the batch. That is
sized for a Download Station that is busy rather than asleep; it is a budget,
not a guarantee that the answer arrives inside it.

**Afterwards, if the add went unanswered.** A browser network error cannot tell
us whether the request reached the NAS, and a missing or unreadable response does
not mean the download was refused. The task list is then asked what became of the
link: every task carries the URI it was created from, so one that is there counts
as added and leaves the link list. The NAS does not list a task the instant it
takes it, so the question is repeated every three seconds and dropped as soon as
every link is accounted for. The lookup uses a 15-second budget. Waiting for an
already-running sign-in or API discovery can extend the overall duration. A link
that never appears is reported for what those answers show: the NAS answered and
the link was not in its task list, so it can be sent again — or the NAS never
answered, so nothing could be established. Either way it waits in the list.
If the NAS refuses the task-list request, for example because the account lacks
permission, the lookup stops and shows that API error. Whether the add arrived
remains unknown. For a right-click or a captured magnet link, the notification
title says the download is unconfirmed and asks you to check Tasks; its body
gives the reason the lookup failed. A successful task-list check replaces any
earlier certificate error with the result of that check.

### No file upload

Local `.torrent` and `.nzb` file uploads are not supported. Send a direct link
instead so Download Station can fetch the file itself — through the right-click
menu, or by pasting the link into the Links list.

There used to be a button for it. Two things stand in its way, and the second
one decides it.

The file dialog takes the focus, so Firefox closes the popup — and the script
that was to read the chosen file closes with it. Pressing the button did
nothing at all: no upload, no message, nothing on the NAS. A window of its own
survives that.

What it then runs into is the NAS. On the DSM 7 installation this was tested
against, the documented upload — `SYNO.DownloadStation.Task` create with a file —
answered with error 101, "invalid parameter", in every shape that was tried.
DSM's own interface uses `SYNO.DownloadStation2.Task` instead, and that endpoint
checks the session before it parses the upload: the session id has to travel in
the URL, where the NAS can record it in its web server log. Keeping session ids
out of URLs is why every other request here is a POST, and one upload is not
worth undoing it.

The link route has neither problem, so that is the one the popup points at.
Reads and repeatable task actions still retry temporary network failures.

### Contrast

Colours are verified by calculation against WCAG 2.1, with translucent fills
composited over their real background first — 41 pairs, covering every text,
icon, control outline and status colour the popup draws. Small type (4.5:1) and
control outlines (3:1) both clear their thresholds.

Six values sit below 3:1 on purpose. WCAG asks for that ratio on what is needed
to *identify* a control, not on every line: the header separator is decoration,
and the card, section and credentials borders only group — a stronger one turns
the task list into a table, and the section is identified by its title and
chevron, both above 7:1. The two grooves are the other case. Making a recess
lighter stops it being a recess: what matters is the scrollbar thumb against its
groove (5.5:1) and the progress fill against its own (9.9:1), and where the
progress bar ends is printed as a percentage beside it anyway.

### Sessions on browser close

Sessions are released when the connection details change, and when polling
finishes with keepalive off — but not while the popup is open, and not while an
add or a resume is still running. The session those hold on to is kept, and
closing the popup afterwards does not release it either: nothing goes looking
for it again. A Manifest V3 extension cannot reliably run code as the browser
shuts down, so a session still open at that moment — for any of these reasons —
stays open until DSM times it out.

### Why the broad permissions

Three entries, for three different reasons. `host_permissions` is `*://*/*`
because the NAS address is whatever you type into the settings and cannot be
narrowed at build time. The content script's `matches` is `<all_urls>`: it is
loaded on every page, where it watches for clicks on `magnet:` links. With magnet
capture off — the default — its listener returns immediately and nothing is
intercepted.

`webRequest`, new in 1.1.4, is there to name one failure properly. `fetch`
rejects every network failure with the same opaque `TypeError`, so a certificate
the browser refuses is indistinguishable from a NAS that is asleep; both were
reported as *the NAS did not respond* and retried for thirty seconds, which could
not change the answer. `webRequest.onErrorOccurred` is the only Firefox API that
names the real reason. Two events are watched, and neither is used for anything
else: `onErrorOccurred` for the reason, and `onBeforeRequest` for the request id
alone — the id is what ties a reason to the request that met it, and it can only
be learnt while the request is starting. Both listeners observe and never block;
their patterns come from the addresses this extension requests itself; and an
event counts only when it belongs to no tab, matches an address in flight right
then, and — where Firefox names the page that triggered it — names this
extension. That name is not always given, so its absence is no reason to discard
the event; a tab always identifies itself, and the NAS interface open in a tab of
your own is ignored on that alone.

Firefox's explanation can arrive shortly after the request has failed. The
extension waits up to half a second for it and continues as soon as it arrives.
A request whose id is known is answered by that id or not at all; where no id
was learnt, the address and the timing decide, and where two of this extension's
requests to one address overlap, the general message stands rather than a guess.

Two things are read as a certificate problem: the security-layer error names
Firefox states symbolically (`SEC_ERROR_…`, `SSL_ERROR_…`, `MOZILLA_PKIX_ERROR_…`),
and — over HTTPS only — an error given as a translated sentence rather than a
symbolic name. The second uses the observed format of Firefox's error messages
without matching translated wording; Mozilla documents `details.error` as
internal and promises nothing about it between versions, so the classification
may be imperfect if Firefox reports a different format. Anything not recognised
keeps the general message.

### Where a refused connection is explained

A notification shows one line and cuts off the rest, which is exactly where the
browser's own explanation used to disappear. So the notification says only that
the secure connection failed and where to read the rest, and the whole of it —
the address, Firefox's wording and what to check — stands above the connection
fields in **Settings → Connection**, wraps rather than truncates, and can be
selected and copied.

It is kept there: closing and reopening the popup does not lose it, and the
attempts that follow a refused certificate usually come back as a NAS that did
not answer, which would otherwise take the one thing you can act on with them.
Once that happens the panel says so — *last attempt: the NAS did not respond* —
and names Firefox's wording as the last precise reason rather than as a fresh
verdict. It goes as soon as anything answers at that address again, whatever the
answer. Delayed processing of an earlier failure cannot bring that explanation
back after a successful response.

There is one of these, and it belongs to the address you have configured. A
failure arriving from a NAS you have since switched away from is not recorded:
it would take the place of the one about the NAS you are actually using, and
that one would then be shown nowhere at all. Pressing **Test** or **Save and
test connection** unfolds the section and puts it in front of you; a failure in
the background leaves it to be found.

### What leaves the browser

Your DSM user name, password and two-factor code, and the links you hand over,
are sent to the NAS you configured — and nowhere else. There is no telemetry, no
analytics and no third-party endpoint, and nothing reaches the author. Mozilla
counts a transmission of that kind as data collection, so `manifest.json`
declares `authenticationInfo` for the credentials and `websiteContent` for the
links — that category covers the text and links on a page, which is what a
chosen link target is. The address of the page you are on, the referrer and your
history are never part of it. That list of categories is fixed and has no way to
say *only to your own NAS*, which is why it is said here.

---

## Project layout

```
manifest.json          Extension manifest (Manifest V3, Firefox)
LICENSE                Mozilla Public License 2.0
CHANGELOG.md           Release history
actions.js             Message names shared by popup and background
background.js          API calls, session handling, context menu, alarms
content.js             Magnet-link click interceptor
_locales/<lang>/       Translations (en, de, es, fr, pt_BR, ru)
popup/
  popup.html           Popup markup (Add / Tasks / Settings tabs)
  popup.js             Popup logic
  popup.css            Styles (CSS custom properties, Firefox panel look)
icons/                 Extension icons
fonts/                 Outfit (bundled, no external requests) and its OFL.txt
tests/                 Regression tests (development only)
```

The extension itself is under the Mozilla Public License 2.0 (`LICENSE`). The
bundled Outfit webfont is not: it is © 2021 The Outfit Project Authors under the
SIL Open Font License 1.1, whose full text ships beside it as `fonts/OFL.txt`.
The OFL asks for exactly that whenever the font travels with something else.

No build step: extension scripts ship as written. For AMO, package
`manifest.json`, `actions.js`, `background.js`, `content.js`, `LICENSE`, and the
`popup`, `_locales`, `icons` and `fonts` directories, with `manifest.json` at the
archive root. Tests and submission notes are not part of the extension.

Run the regression tests with Node.js 18 or newer:

```sh
node --test tests/regression.test.cjs
```

They use simulated browser storage, popup controls and NAS responses. No NAS
credentials or network access are required. Test the packaged extension in
Firefox with a NAS as well before publishing a release.

**APIs used:** `SYNO.API.Info` (discovery) · `SYNO.API.Auth` (login incl.
`otp_code` and device token, logout) · `SYNO.DownloadStation.Task` (list, create,
pause, resume, delete). Total throughput is added up from the task list rather than asked
for separately, which is one fewer request per refresh.

Reference: [Synology Download Station Web API guide](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/DownloadStation/All/enu/Synology_Download_Station_Web_API.pdf)
