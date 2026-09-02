# AMO submission — version 1.1.0

Working document for the upload at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/synology-download-manager/versions/submit/).
Not part of the package: the build script ships a fixed file list and this file
is not on it.

Upload `synology-download-station-manager-1.1.0.zip`.

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
New

• Three tabs — Add, Tasks and Settings — so the task list gets the popup's full
  height: seven downloads visible at once instead of two. The house icon on each
  tab picks which one the popup opens on.
• A notification when the last download finishes, with what became of the ones
  that were running: completed, failed, paused.
• Notification settings: a master switch plus separate ones for added, failed
  and finished downloads. Sign-in and destination folder problems are always
  reported.
• "Save and test connection", which checks the login right away including the
  two-factor prompt. Plus "Sign out" and "Reset all settings".
• For half a minute after adding something, the task list refreshes every three
  seconds and then falls back to the interval in the settings. Small downloads
  used to start, run and finish inside a single tick of the normal interval.

Fixed

• A sleeping NAS is now waited out instead of being reported as an error.
  Requests are repeated for about half a minute, roughly how long a NAS takes to
  wake its disks. Downloads started from the context menu say so, since they
  have no window to show progress in.
• The result of adding links survives the popup closing. Firefox closes it the
  moment anything outside is clicked, and everything that happened afterwards —
  emptying the box, putting the refused links back, counting what got through —
  used to run inside that popup. Against a sleeping NAS it was usually gone by
  then, so the links stayed put as if nothing had happened and pressing the
  button again added all of them a second time.
• Adding from the context menu now waits its turn instead of running alongside
  another add, and a link whose fate is genuinely unknown is no longer reported
  as failed — that invited a second right-click and a second download.
• Clearing the password field no longer wipes the stored password on the next
  unrelated save, and changing any option no longer discards a password that was
  typed but not yet saved.
• Changing an option no longer signs the DSM session out or sends the task list
  back to page one.
• Pause, resume, retry, remove and the bulk actions now say why they failed
  instead of appearing to do nothing.
• Four task states were shown as raw English values in every language: seeding,
  finishing, hash checking, and waiting for a file host.

Changed

• Tasks per page now defaults to 10, and failed downloads sort right behind
  active ones.
• "Task refresh interval" is now called "Background task refresh interval",
  because the half minute after an add no longer uses it.
• Settings are grouped into Connection, Downloads, Notifications, Tasks and
  Advanced options.
• The interface was reworked throughout, with contrast calculated against
  WCAG 2.1 rather than eyeballed.
• Nothing secret travels in a URL any more: the password and the session id go
  to the NAS in the request body, so neither lands in its web server log.
• The tabs answer the arrow keys and are announced properly by screen readers,
  and the popup now reports the language it is actually showing.
```

### Deutsch

```
Neu

• Drei Tabs — Hinzufügen, Aufgaben und Einstellungen —, damit die Aufgabenliste
  die volle Höhe des Fensters bekommt: sieben Downloads auf einen Blick statt
  zwei. Das Haussymbol auf jedem Tab legt fest, womit das Fenster öffnet.
• Eine Benachrichtigung, wenn der letzte Download fertig ist — mit dem, was aus
  den laufenden geworden ist: abgeschlossen, fehlgeschlagen, pausiert.
• Einstellungen für Benachrichtigungen: ein Hauptschalter und drei eigene für
  hinzugefügte, fehlgeschlagene und abgeschlossene Downloads. Probleme bei der
  Anmeldung und beim Zielordner werden immer gemeldet.
• „Verbindung speichern und testen“ prüft die Anmeldung sofort, samt
  Zwei-Faktor-Abfrage. Dazu „Abmelden“ und „Alle Einstellungen zurücksetzen“.
• Eine halbe Minute nach dem Hinzufügen aktualisiert sich die Aufgabenliste alle
  drei Sekunden und fällt danach auf das Intervall aus den Einstellungen zurück.
  Kleine Downloads begannen und endeten bisher innerhalb eines einzigen Takts.

Behoben

• Eine schlafende NAS wird abgewartet statt als Fehler gemeldet. Anfragen werden
  etwa eine halbe Minute lang wiederholt — ungefähr so lange, wie eine NAS zum
  Aufwecken ihrer Festplatten braucht. Über das Kontextmenü gestartete Downloads
  sagen Bescheid, weil sie kein Fenster haben, in dem sie das zeigen könnten.
• Das Ergebnis des Hinzufügens überlebt jetzt das Schließen des Fensters. Firefox
  schließt es beim ersten Klick daneben, und alles, was danach kam — Liste
  leeren, abgelehnte Links zurücklegen, zählen was durchging —, lief bisher in
  genau diesem Fenster. Bei schlafender NAS war es dann meist weg, die Links
  blieben stehen, als wäre nichts passiert, und ein zweiter Druck auf den Knopf
  fügte alle ein zweites Mal hinzu.
• Das Hinzufügen über das Kontextmenü wartet, statt parallel zu einem anderen
  Vorgang zu laufen. Und ein Link, dessen Schicksal wirklich unbekannt ist, wird
  nicht mehr als fehlgeschlagen gemeldet — das lud zu einem zweiten Rechtsklick
  und damit zu einem zweiten Download ein.
• Ein geleertes Passwortfeld überschreibt nicht mehr beim nächsten beliebigen
  Speichern das gespeicherte Passwort, und das Umlegen einer Option verwirft
  nicht mehr ein eingetipptes, noch nicht gespeichertes Passwort.
• Das Ändern einer Option meldet die DSM-Sitzung nicht mehr ab und springt nicht
  mehr auf Seite 1 der Aufgabenliste zurück.
• Pausieren, Fortsetzen, Wiederholen, Entfernen und die Sammelaktionen sagen
  jetzt, warum sie fehlgeschlagen sind, statt scheinbar nichts zu tun.
• Vier Aufgabenstatus wurden in allen Sprachen als englische Rohwerte angezeigt:
  Seeding, Fertigstellen, Prüfsummenprüfung und Warten auf einen Filehoster.

Geändert

• „Aufgaben pro Seite“ steht jetzt standardmäßig auf 10, und fehlgeschlagene
  Downloads stehen direkt hinter den aktiven.
• „Aktualisierungsintervall“ heißt jetzt „Aktualisierungsintervall im
  Hintergrund“, weil die halbe Minute nach dem Hinzufügen es nicht mehr benutzt.
• Die Einstellungen sind in Verbindung, Downloads, Benachrichtigungen, Aufgaben
  und Erweiterte Optionen gegliedert.
• Die Oberfläche wurde überarbeitet, der Kontrast dabei nach WCAG 2.1 berechnet
  statt geschätzt.
• Nichts Vertrauliches steht mehr in einer URL: Passwort und Sitzungskennung
  gehen im Anfragekörper an die NAS und landen damit nicht in deren
  Webserver-Log.
• Die Tabs reagieren auf die Pfeiltasten und werden von Screenreadern korrekt
  angesagt, und das Fenster meldet jetzt die Sprache, die es tatsächlich zeigt.
```

---

## Notes to reviewer

English, one field, plain text. Paste as is.

```
WHAT THIS ADD-ON DOES

Sends links, magnet links and .torrent/.nzb files to the user's own Synology
NAS through the official Download Station Web API, and lists and controls the
resulting download tasks. The NAS address, account and password are entered by
the user in the popup. There is no vendor server and no service of ours
involved anywhere.

SOURCE CODE

No build step. The files in the uploaded ZIP are the complete, unmodified
source. Nothing is minified, transpiled, bundled or generated, so no source
upload is required.

Public repository:
https://github.com/alexandermayzel/Synology-Download-Station-Manager

NO REMOTE CODE, NO THIRD PARTIES

No eval(), no new Function(), no innerHTML, no remotely hosted scripts, no CDN,
no analytics, no telemetry, no third-party libraries. The Outfit webfont is
bundled in fonts/ (SIL Open Font License 1.1) precisely so that the add-on
issues no third-party requests at all. The only network traffic the add-on ever
generates goes to the host the user configured in the settings.

DATA COLLECTION

browser_specific_settings.gecko.data_collection_permissions.required is
["none"]. Nothing is transmitted anywhere except to the user's own NAS.
Credentials are stored in browser.storage.local, which is documented in the
README under "Where credentials are stored", including the explicit statement
that they are not encrypted and why encrypting them locally would be
security theatre.

PERMISSIONS — UNCHANGED SINCE 1.0.2

No permission was added, removed or widened in this version.

- host_permissions "*://*/*" — the NAS address is whatever the user types into
  the settings: a LAN IP, a hostname, a DDNS name, on any port. It cannot be
  narrowed at build time because it is not known at build time.

- content script on <all_urls> — content.js is 56 lines and does exactly one
  thing: when the user has switched on magnet capture, it intercepts clicks on
  magnet: links and forwards the URL to the background script. It reads no page
  content, injects nothing into the page, and sends nothing anywhere else. The
  option is off by default, and while it is off the click handler returns on its
  first line.

- storage — connection settings and UI preferences, all local. Unsaved drafts
  go to storage.session so they do not outlive the browser.

- notifications — downloads added, failed and finished (each individually
  switchable, plus a master switch), and sign-in and destination folder errors,
  which are always shown because they break every download rather than one.

- alarms — polls the task list once a minute while a download is running, then
  stops by itself.

- contextMenus — the "Download with Download Station" entry on links and on
  selected text.

WHAT CHANGED IN 1.1.0

The manifest diff against 1.0.2 is two lines: the version number, and one added
background script, actions.js — the constants the popup and the background both
depend on (message names and the settings defaults), in one place so they cannot
drift apart.

The rest of the release is the popup restructured into three tabs, a completion
notification with a tally, per-category notification settings, retry handling
for a NAS whose disks are asleep, and a contrast rework measured against
WCAG 2.1.

Two changes are worth pointing out to a reviewer specifically:

- Every request carrying a password or a session id was changed from GET to
  POST, so neither appears in the NAS's own web server access log. That includes
  the task list, which is polled every few seconds while the popup is open.
- Unsaved connection details moved from storage.local to storage.session. In
  1.0.2 a password that was typed but never saved persisted indefinitely.

HOW TO TEST WITHOUT A SYNOLOGY NAS

The add-on needs a NAS running Download Station to do anything useful, which a
reviewer will understandably not have. What can be verified without one:

- Install and open the popup. It appears immediately on the Settings tab. No
  network request is made until connection settings are saved.
- Enter any unreachable host and press "Save and test connection". This
  exercises the timeout and retry path: the request times out after 8 seconds
  and is repeated up to four times, ten seconds apart, ending in a plain error
  message after roughly 30 to 60 seconds depending on whether the host refuses
  the connection or simply does not answer.
- Leave a required field empty and press the same button. It refuses to save and
  names the specific fields that are missing.
- All tabs, settings, sorting, filtering and the six translations work with no
  NAS present.

I cannot offer a test instance: the NAS this is developed against sits on a
private LAN and is deliberately not reachable from the internet, which is the
configuration this add-on is built for and the one I would recommend to any of
its users.

The network behaviour is, however, fully reviewable by reading the source. There
are exactly three fetch() call sites in the entire add-on, all of them in
background.js and all of them building their URL from the protocol, host and port
the user entered in the settings:

- background.js:205 — fetchOnce(), which every API call goes through.
- background.js:313 — the SYNO.API.Info endpoint discovery (carries no
  credentials: it asks which paths the NAS publishes, before any login).
- background.js:475 — the logout POST.

popup/popup.js and content.js contain no fetch(), no XMLHttpRequest, no
WebSocket, no sendBeacon and no dynamic import(). Grepping for any of those
across the package returns the three lines above and nothing else, which settles
the question of where data can go without needing a running NAS.

LICENCE

MPL-2.0. This add-on continues the development of the original "Download
Station" add-on, which is published under the same licence. It has its own
extension ID and its own version numbering. LICENSE is included in the package.
```

---

## Checklist

- [x] Date on `## [1.1.0]` in `CHANGELOG.md` — 2026-09-02
- [x] `manifest.json` version is `1.1.0`
- [ ] Package rebuilt after the last edit
- [ ] ZIP entry paths use forward slashes, `manifest.json` at the root
- [ ] Release notes pasted for English and German
- [ ] Notes to reviewer pasted
- [ ] Support email still empty
- [ ] Screenshots reflect the three-tab layout
- [ ] Git tag `v1.1.0` after AMO accepts the version
