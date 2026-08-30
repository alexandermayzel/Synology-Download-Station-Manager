# Synology - Download Station Manager

A Firefox extension that sends links, magnet links and torrent files to your
**Synology NAS** through the official Download Station Web API — and lets you
watch and manage the resulting tasks without opening DSM.

> **License:** Mozilla Public License 2.0. This project continues the
> development of the original *Download Station* Firefox add-on, which is
> published under the same license. See [LICENSE](LICENSE).

---

## Features

### Adding downloads

- **Paste a list of links.** One per line, added in a single go. Lists longer
  than 50 are split automatically, because Download Station rejects a
  task-creation call carrying more than 50 URIs.
- **The list survives.** What you type stays in the box when the popup closes,
  so links can be collected across several visits. It is cleared only after a
  successful add, or with the *Clear list* button.
- **Torrent and NZB files.** Upload `.torrent` / `.nzb` straight from the
  popup, several at once.
- **Right-click any link** and choose *Download with Download Station*. It also
  works on selected text for sites that fake links with JavaScript instead of a
  real `<a href>` — and a multi-line selection has **every** link in it picked
  out, not just the first.
- **Magnet links** can be intercepted automatically, so a click goes to the NAS
  instead of prompting for an external torrent client. Off by default.
- **Archive password.** Optional field for password-protected archives, sent as
  `unzip_password` with each task.

### Watching and managing

- **Filter buttons with live counts** — All, Active, Waiting, Failed, Paused,
  Finished.
- **Sorting.** By status (with a drag-to-reorder priority list), date added,
  name, progress or size, ascending or descending. The status order defaults to
  Active → Waiting → Paused → Failed → Finished, so running downloads stay on
  page one no matter how many finished tasks pile up.
- **Pagination** — 25, 50 or 100 tasks per page.
- **Per-task actions** — pause, resume, retry a failed task, remove it.
- **Bulk actions** in the task header — pause all, resume all, clear finished
  (broom), delete all (trash, with confirmation).
- **Live progress**, transfer rates per task and total throughput in the status
  bar. While an archive is being unpacked the bar shows the extraction
  progress, not the already-full download bar.
- **Toolbar badge** with the number of running downloads.

### Under the hood

- **Readable errors.** Every documented API error code and all 26 failure
  reasons from the Web API guide's Appendix B are translated — "wrong archive
  password", "volume is full", "premium account required" instead of a bare
  number. A failed task shows its reason in the list and in the tooltip.
- **API auto-discovery.** Queries `SYNO.API.Info` for the correct endpoint
  paths and versions (DSM 6, DSM 7+), capped at the versions this extension
  actually knows.
- **Adaptive polling.** After you add something, a background check follows it
  to completion once a minute and then stops by itself. Seeding, paused and
  finished tasks do not keep it running.
- **Two-factor authentication** — enter the code once; the browser is then
  registered as a trusted device, so background operations never prompt again.
- **Six languages** — English, German, Spanish, French, Brazilian Portuguese,
  Russian; follows the browser language.

---

## Requirements

| | |
|---|---|
| Firefox | **142 or newer** |
| NAS | DSM 6 or newer with the **Download Station** package installed |
| Account | A DSM account with Download Station access (see below) |

---

## Setting up the NAS account

Both of these are required — the first one alone is not enough:

1. **Application access.** *Control Panel → User & Group → [user] →
   Applications* → allow **Download Station**.
2. **Folder permission.** *Control Panel → Shared Folder → [destination
   folder] → Permissions* → **Read/Write** for that user. Download Station
   creates tasks with the permissions of the account that is logged in, so
   without this you get error 403 even though the folder exists.

If the destination is a sub-folder, make sure the permission applies to
sub-folders as well, not only to the top-level shared folder.

**Recommended:** create a dedicated DSM account just for this extension, with
Download Station access and write permission on exactly one folder — no admin
rights, no other shares.

### Two-factor authentication (experimental)

When DSM asks for a code, the popup shows a field for it. That
login also registers this browser as a trusted device, and the returned device
token is reused from then on — so background work (context menu, polling) keeps
working without ever prompting again.

Changing the host, account or password discards the token; the next login will
ask for a code once more.

**Trade-off:** a stored device token is, by design, a standing bypass of the
second factor for this extension. Anyone who can read the Firefox profile can
use it. That is the same exposure as the stored password, but worth knowing.
DSM lists the device under *Control Panel → Security → Account*, where the
trust can be revoked at any time.

---

## Installation

### Temporary (any Firefox, gone after restart)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** and pick `manifest.json`

### Permanent

Firefox only installs signed extensions. Sign it through Mozilla without
publishing it in the store:

1. Create an account on [addons.mozilla.org](https://addons.mozilla.org)
2. **Submit a New Add-on** → choose **"On your own"** (self-distribution)
3. Upload a ZIP of this directory — `manifest.json` must sit at the **root** of
   the archive, and the archive must use forward slashes in its entry paths
   (Windows' `Compress-Archive` writes backslashes, which AMO rejects)
4. Download the signed `.xpi` and install it via `about:addons` → gear icon →
   *Install Add-on From File…*

Alternatively, in Firefox Developer Edition / Nightly / ESR only, set
`xpinstall.signatures.required = false` in `about:config`.

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

### Options

| Option | Default | Notes |
|---|---|---|
| Auto-capture magnet links | **off** | Intercepts `magnet:` clicks on every page |
| Extract archives automatically | **off** | Shows the archive-password field. See the caveat below |
| Keep session alive in background | **off** | See "HDD hibernation" below |
| Task refresh interval | 10 s | 3 / 10 / 30 seconds, or manual only. Runs only while tasks are active |
| Sort tasks by | By status | Plus a drag-to-reorder status priority |
| Tasks per page | 50 | 25 / 50 / 100 |
| Default destination | *(empty)* | See "Destination folder" below |

---

## Things to know

### Destination folder

Leave **Default destination** empty to use the folder configured on the NAS
itself (*DSM → Download Station → Settings → General*). If you do fill it in,
the value is a folder name **relative to a shared folder, without a leading
slash** — `downloads`, not `/downloads` and not `/volume1/downloads`.

Two errors point here:

- **406 — no default destination:** neither the NAS nor this extension has one
  set. Set it in DSM, or fill the field.
- **403 — destination does not exist:** the folder is missing, or the account
  cannot see it. Check the name and the folder permission.

### HDD hibernation

*Keep session alive in background* pings the NAS every three minutes so the
popup can show "Connected" the instant it opens. That regular traffic can stop
the NAS from parking its disks, which is why it ships **off**. With it off the
extension logs in again when needed and hands the session back when it is done.

### Automatic extraction is a server-side setting

The *Extract archives automatically* option in this extension only reveals the
archive-password field. Auto-extract itself is a **server-wide** Download
Station setting that applies to all users, and only a Download Station manager
can change it — in *DSM → Download Station → Settings → Auto Extract*. The
extension checks `is_manager` and tells you which case applies; it deliberately
does not flip a NAS-wide setting on your behalf.

### Where credentials are stored

Host, username and password are kept in `browser.storage.local` — this profile
only, **not** synced through your Firefox account, and **not encrypted**.
Anyone with access to your Firefox profile directory can read them. This is why
a dedicated, least-privilege DSM account is the recommendation. The archive
password is deliberately *not* stored at all and is gone when the popup closes.

### Sessions on browser close

Sessions are released when you change the connection details, and when polling
finishes with keepalive switched off. There is no reliable way for a Manifest
V3 extension to run code as the browser shuts down, so a session still open at
that moment stays open on the NAS until DSM times it out on its own.

### Why the broad permissions

- `<all_urls>` host permission — the NAS address is whatever you type into the
  settings, so it cannot be narrowed at build time.
- Content script on all pages — it only listens for clicks on `magnet:` links
  and sends nothing anywhere else.

---

## Project layout

```
manifest.json          Extension manifest (Manifest V3, Firefox)
LICENSE                Mozilla Public License 2.0
background.js          API calls, session handling, context menu, alarms
content.js             Magnet-link click interceptor
_locales/<lang>/       Translations (en, de, es, fr, pt_BR, ru)
popup/
  popup.html           Popup markup (Downloads / Settings tabs)
  popup.js             Popup logic
  popup.css            Styles (CSS custom properties, Firefox panel look)
icons/                 Extension icons
fonts/                 Outfit (bundled, no external requests)
```

No build step: the files in this repository are exactly what ships. To package
for AMO, zip the directory contents with `manifest.json` at the root.

## APIs used

`SYNO.API.Info` (discovery) · `SYNO.API.Auth` (login incl. `otp_code` and
device token, logout) ·
`SYNO.DownloadStation.Task` (list, create, pause, resume, delete) ·
`SYNO.DownloadStation.Info` (`getinfo` for `is_manager`) ·
`SYNO.DownloadStation.Statistic` (total transfer rates)

Reference: [Synology Download Station Web API guide](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/DownloadStation/All/enu/Synology_Download_Station_Web_API.pdf)
