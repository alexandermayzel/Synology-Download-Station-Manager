# AMO submission — version 1.1.1

Working document for the upload at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/synology-download-manager/versions/submit/).
Not part of the package: the build script ships a fixed file list and this file
is not on it.

Upload `synology-download-station-manager-1.1.1.zip`.

Two fields are filled in during the upload:

| AMO field | Audience | Section below |
|---|---|---|
| **Release Notes** | end users, per language | [Release notes](#release-notes) |
| **Notes to Reviewer** | Mozilla reviewers, English | [Notes to reviewer](#notes-to-reviewer) |

**Before uploading:** leave the **support email empty**; AMO exposes it through
the public, unauthenticated API.

---

## Release notes

English and German only. AMO falls back to the default locale for any language
without its own notes, so Spanish, French, Portuguese and Russian users see the
English block. The extension's interface and its store description stay in all
six languages — this only limits the version notes.

### English

```
Fixed

• The information about automatic extraction has been made precise, in the extension's hints and in its documentation. Auto extract is switched on per account, under Download Station > Settings > Auto extract, and is off by default.
• The archive password is passed on to Download Station, which keeps it in its own Password List. That is now stated.
```

### Deutsch

```
Behoben

• Die Angaben zum automatischen Entpacken wurden präzisiert, in den Hinweisen der Erweiterung wie in der Dokumentation. Das Entpacken wird pro Konto eingeschaltet, unter Download Station > Einstellungen > Automatisch extrahieren, und ist voreingestellt aus.
• Das Archiv-Passwort wird an die Download Station weitergereicht, die es in ihre Kennwortliste aufnimmt. Das steht jetzt dabei.
```

---

## Notes to reviewer

English, one field, plain text. Paste as is.

```
WHAT IT DOES

Sends links, magnet links and .torrent/.nzb files to the user's own Synology NAS through the official Download Station Web API, and controls the resulting tasks. Address, account and password are the user's own; no vendor server involved.

SOURCE CODE

No build step. The files in the ZIP are the complete, unmodified source - nothing minified, transpiled, bundled or generated - so no source upload is required.
github.com/alexandermayzel/Synology-Download-Station-Manager (tag v1.1.1)

NO REMOTE CODE, NO THIRD PARTIES

No eval(), no new Function(), no innerHTML, no remotely hosted script, no CDN, no analytics, no telemetry, no third-party library. The Outfit webfont is bundled in fonts/ (SIL OFL 1.1).

DATA COLLECTION

data_collection_permissions.required is ["none"]. Nothing is transmitted anywhere except to the user's own NAS. Credentials live in browser.storage.local, as the README explains.

PERMISSIONS - UNCHANGED SINCE 1.0.2

None added, removed or widened. The two broad ones:

- host_permissions "*://*/*" - the NAS address is whatever the user types in: a LAN IP, a hostname, a DDNS name, any port. It is not known at build time, so it cannot be narrowed.
- content script on <all_urls> - content.js is 64 lines and does one thing: with magnet capture on, it intercepts clicks on magnet: links and forwards the URL to the background. It reads no page content and injects nothing, and is off by default; while off the handler returns on its first line.

WHERE DATA CAN GO

Exactly three fetch() call sites in the add-on, each building its URL from the protocol, host and port the user entered:

- background.js:205 - inside fetchOnce(), which every API call goes through; the calls to fetchOnce itself (251, 952) route here
- background.js:310 - SYNO.API.Info discovery, before any login, no credentials
- background.js:469 - the logout POST

popup/popup.js and content.js make no network call of any kind: no fetch(), XMLHttpRequest, WebSocket, sendBeacon or dynamic import(). Grepping popup.js for "fetch" matches one comment.

CHANGED IN 1.1.1

The manifest diff against 1.1.0 is one line: the version. This release corrects what the extension said about Download Station's automatic extraction, and removes the one call to SYNO.DownloadStation.Info the wrong claim rested on - it asked whether the account was a Download Station manager. Nothing else changed: same permissions, same destinations, same stored data.

TESTING

I cannot offer a test instance: the NAS this is built against sits on a private LAN, deliberately unreachable from the internet. Without one you can still install it, open the popup - no request is made until connection settings are saved - and point it at an unreachable host to exercise the retry path.

LICENCE

MPL-2.0, continuing the original "Download Station" add-on under the same licence, with its own extension ID and versioning. LICENSE is in the package.
```

---

## Checklist

- [x] Date on `## [1.1.1]` in `CHANGELOG.md` — 2026-09-02
- [x] `manifest.json` version is `1.1.1`
- [ ] Package rebuilt after the last edit
- [ ] Committed, tagged `v1.1.1` and pushed — the reviewer note points at the tag
- [ ] Release notes pasted for English and German
- [ ] Notes to reviewer pasted
- [ ] Support email still empty
- [ ] Store description updated — the old one still says extraction is a
      server-wide, admin-only setting (see `AMO-BESCHREIBUNG.md`)
