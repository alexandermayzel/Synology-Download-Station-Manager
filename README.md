# Synology - Download Station Manager

A Firefox extension that sends links, magnet links and torrent files to your
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
Add-on…* → pick `manifest.json`. Survives until Firefox closes, needs no
signing, and reloads after every edit.

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
  automatically — Download Station rejects more than 50 URIs per call. If some
  are refused, only those stay in the box, marked and with the reason, so trying
  again cannot add the accepted ones twice.
- **Right-click any link** → *Download with Download Station*. Works on selected
  text as well, for sites that fake links with JavaScript, and picks out
  **every** link in a multi-line selection rather than just the first.
- **Torrent and NZB files**, several at once.
- **Magnet links** can be intercepted automatically, so a click goes to the NAS
  instead of prompting for a torrent client. Off by default.
- **The list survives** a closed popup, so links can be collected across several
  visits. Cleared after a successful add, by *Clear list*, or when Firefox
  closes.
- **Archive password** — optional field, sent as `unzip_password` with each task.

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
  as a trusted device and background work never prompts again.
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
then on, so background work never prompts again. Changing the host, account or
password discards the token.

**Trade-off:** a stored device token is, by design, a standing bypass of the
second factor for this extension — anyone who can read the Firefox profile can
use it. Same exposure as the stored password, but worth knowing. DSM lists the
device under *Control Panel → Security → Account*, where the trust can be
revoked.

</details>

---

## Settings

All settings live in the popup's **Settings** tab.

### Connection

| Field | Notes |
|---|---|
| Protocol | `https` (port 5001) or `http` (port 5000) |
| Host | IP, hostname or DDNS name of the NAS. **Not** `localhost` — that points at your own computer |
| Port | DSM web port |
| Username / Password | The DSM account from the section above |

Saved by its own button, not while typing. The Credentials block folds away on
save and stays however you leave it after that.

### Downloads

| Option | Default | Notes |
|---|---|---|
| Default destination | *(empty)* | Applied on Enter or its own save button. See [Destination folder](#destination-folder) |
| Auto-capture magnet links | **off** | Intercepts `magnet:` clicks on every page |
| Extract archives automatically | **off** | Shows the archive-password field. See [Automatic extraction](#automatic-extraction-happens-on-the-nas) |

### Notifications

| Option | Default | Notes |
|---|---|---|
| Notifications | **on** | Master switch, with three of its own below: downloads added / failed / finished |

### Tasks

| Option | Default | Notes |
|---|---|---|
| Task refresh interval | 10 s | 3 / 10 / 30 seconds, or manual. Runs only while tasks are active |
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
Station → Settings → General*). Filled in, the value is a folder name **relative
to a shared folder, without a leading slash** — `downloads`, not `/downloads`
and not `/volume1/downloads`.

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
can show "Connected" the instant it opens. That traffic can stop the NAS parking
its disks, which is why it ships **off**. With it off the extension signs in when
needed and hands the session back when it is done.

### Automatic extraction happens on the NAS

The extension's *Extract archives automatically* option only reveals the
archive-password field. The extraction is Download Station's own, and it has two
levels — which is what makes it easy to get wrong:

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
Password List afterwards and is tried on later archives. The extension itself
stores nothing.

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

Four things deliberately do **not** persist:

| | Kept in | Gone when |
|---|---|---|
| Unsaved connection details | `storage.session` | Firefox closes |
| An unsaved destination folder | `storage.session` | Firefox closes |
| The pending link list | `storage.session` | Firefox closes |
| The archive password | nowhere | the popup closes |

The drafts exist because Firefox closes the popup the moment you click anything
outside it — reaching for a password manager's toolbar button included.

Nothing secret travels in a URL. The password and the session id go to the NAS
in the body of a POST request, so neither is written to its web server log — the
task list included, which is fetched every few seconds and would otherwise leave
a usable session id in that log all day.

### A sleeping NAS

With the disks parked the first request is refused outright, and it can be half a
minute before the NAS answers. Rather than report that as a failure, a request
times out after 8 seconds and is quietly repeated up to four times, ten seconds
apart, showing nothing beyond "Connecting…" in the header. An answer that says
*no* — wrong password, missing folder — is never repeated and appears at once.

Requests that change something are treated more carefully. Reading a task list
twice costs nothing; creating a task twice creates it twice. A refused
connection proves nothing was sent, so those are still repeated — but once a
request has gone out and only the answer is missing, it is reported rather than
sent again, because the NAS may well have acted on it. If that happens while
links are being added, the message says so and asks you to check Tasks before
trying again.

Because such a request gets a single attempt, adding a download starts by
knocking: a plain read with no session behind it, repeated for up to 30 seconds
until the NAS answers, then a couple of seconds for Download Station to finish
starting. Only then is anything created, and by that point the NAS is awake and
answers quickly.

A sleeping NAS refuses the connection outright rather than leaving it hanging,
so each knock costs almost nothing and the waiting happens in three-second gaps
between them — the download starts within a few seconds of the NAS becoming
reachable. A NAS that is already awake adds well under a second. One that never
answers is reported as unreachable after about 45 seconds, with every link left
in the box.

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
finishes with keepalive off. A Manifest V3 extension cannot reliably run code as
the browser shuts down, so a session still open at that moment stays open until
DSM times it out.

### Why the broad permissions

`<all_urls>` is needed because the NAS address is whatever you type into the
settings and cannot be narrowed at build time. The content script runs on all
pages but only listens for clicks on `magnet:` links.

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
fonts/                 Outfit (bundled, no external requests)
```

No build step: the files in this repository are exactly what ships. To package
for AMO, zip the directory contents with `manifest.json` at the root.

**APIs used:** `SYNO.API.Info` (discovery) · `SYNO.API.Auth` (login incl.
`otp_code` and device token, logout) · `SYNO.DownloadStation.Task` (list, create,
pause, resume, delete) · `SYNO.DownloadStation.Info` (`getinfo` for
`is_manager`). Total throughput is added up from the task list rather than asked
for separately, which is one fewer request per refresh.

Reference: [Synology Download Station Web API guide](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/DownloadStation/All/enu/Synology_Download_Station_Web_API.pdf)
