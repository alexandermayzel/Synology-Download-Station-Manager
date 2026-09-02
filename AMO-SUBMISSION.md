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

• Three tabs — Add, Tasks and Settings — so the task list gets the popup's full height: seven downloads at once instead of two. The house icon on each tab picks which one the popup opens on.
• A notification when the last download finishes, with what became of the ones that were running: completed, failed, paused.
• Notification settings: a master switch plus separate ones for added, failed and finished downloads. Sign-in and destination folder problems are always reported.
• "Save and test connection", which checks the login right away including the two-factor prompt. Plus "Sign out" and "Reset all settings".
• For half a minute after an add, the task list refreshes every three seconds, then falls back to the interval in the settings.

Fixed

• A sleeping NAS is waited out instead of being reported as an error — for about half a minute, roughly how long a NAS takes to wake its disks.
• The result of adding links survives the popup closing. Firefox closes it on the first click outside, and everything that followed an add used to run inside it. Against a sleeping NAS it was usually gone by then, so the links stayed in the box as if nothing had happened, and a second press added all of them again.
• Adding from the context menu waits its turn instead of running alongside another add. A link whose fate is genuinely unknown is no longer called a failure — that invited a second right-click and a second download.
• Clearing the password field no longer wipes the stored password on the next unrelated save, and changing an option no longer discards a password typed but not yet saved.
• Changing an option no longer signs the DSM session out or sends the task list back to page one.
• Pause, resume, retry, remove and the bulk actions now say why they failed instead of appearing to do nothing.
• Four task states were shown as raw English values in every language: seeding, finishing, hash checking, waiting for a file host.

Changed

• Tasks per page defaults to 10, and failed downloads sort right behind active ones.
• "Task refresh interval" is now "Background task refresh interval".
• Settings are grouped into Connection, Downloads, Notifications, Tasks and Advanced options.
• The interface was reworked throughout, with contrast calculated against WCAG 2.1 rather than eyeballed.
• Nothing secret travels in a URL any more: the password and the session id go to the NAS in the request body, so neither lands in its web server log.
• The tabs answer the arrow keys and are announced properly by screen readers, and the popup reports the language it is actually showing.
```

### Deutsch

```
Neu

• Drei Tabs — Hinzufügen, Aufgaben und Einstellungen —, damit die Aufgabenliste die volle Höhe bekommt: sieben Downloads auf einen Blick statt zwei. Das Haussymbol legt fest, womit das Fenster öffnet.
• Eine Benachrichtigung, wenn der letzte Download fertig ist — mit dem, was aus den laufenden geworden ist: abgeschlossen, fehlgeschlagen, pausiert.
• Einstellungen für Benachrichtigungen: ein Hauptschalter und drei eigene für hinzugefügte, fehlgeschlagene und abgeschlossene Downloads. Probleme bei Anmeldung und Zielordner werden immer gemeldet.
• „Verbindung speichern und testen“ prüft die Anmeldung sofort, samt Zwei-Faktor-Abfrage. Dazu „Abmelden“ und „Alle Einstellungen zurücksetzen“.
• Eine halbe Minute nach dem Hinzufügen aktualisiert sich die Liste alle drei Sekunden, danach gilt wieder das Intervall aus den Einstellungen.

Behoben

• Eine schlafende NAS wird abgewartet statt als Fehler gemeldet — etwa eine halbe Minute lang, ungefähr so lange, wie eine NAS zum Aufwecken ihrer Festplatten braucht.
• Das Ergebnis des Hinzufügens überlebt das Schließen des Fensters. Firefox schließt es beim ersten Klick daneben, und alles, was nach dem Hinzufügen kam, lief bisher in diesem Fenster. Bei schlafender NAS war es dann meist weg, die Links blieben stehen, als wäre nichts passiert, und ein zweiter Druck fügte alle erneut hinzu.
• Das Hinzufügen über das Kontextmenü wartet, statt parallel zu laufen. Ein Link, dessen Schicksal wirklich unbekannt ist, gilt nicht mehr als fehlgeschlagen — das lud zu einem zweiten Rechtsklick und einem zweiten Download ein.
• Ein geleertes Passwortfeld überschreibt nicht mehr beim nächsten beliebigen Speichern das gespeicherte Passwort, und das Umlegen einer Option verwirft kein eingetipptes, ungespeichertes Passwort mehr.
• Das Ändern einer Option meldet die DSM-Sitzung nicht mehr ab und springt nicht mehr auf Seite 1 zurück.
• Pausieren, Fortsetzen, Wiederholen, Entfernen und die Sammelaktionen sagen jetzt, warum sie fehlgeschlagen sind.
• Vier Aufgabenstatus wurden in allen Sprachen als englische Rohwerte angezeigt: Seeding, Fertigstellen, Prüfsummenprüfung, Warten auf einen Filehoster.

Geändert

• „Aufgaben pro Seite“ steht standardmäßig auf 10, fehlgeschlagene Downloads stehen direkt hinter den aktiven.
• „Aktualisierungsintervall“ heißt jetzt „Aktualisierungsintervall im Hintergrund“.
• Die Einstellungen sind in Verbindung, Downloads, Benachrichtigungen, Aufgaben und Erweiterte Optionen gegliedert.
• Die Oberfläche wurde überarbeitet, der Kontrast dabei nach WCAG 2.1 berechnet statt geschätzt.
• Nichts Vertrauliches steht mehr in einer URL: Passwort und Sitzungskennung gehen im Anfragekörper an die NAS und landen nicht in deren Webserver-Log.
• Die Tabs reagieren auf die Pfeiltasten und werden von Screenreadern korrekt angesagt.
```

---

## Notes to reviewer

English, one field, plain text. Paste as is.

```
WHAT IT DOES

Sends links, magnet links and .torrent/.nzb files to the user's own Synology NAS through the official Download Station Web API, and controls the resulting tasks. Address, account and password are the user's own; no vendor server involved.

SOURCE CODE

No build step. The files in the ZIP are the complete, unmodified source - nothing minified, transpiled, bundled or generated - so no source upload is required.
github.com/alexandermayzel/Synology-Download-Station-Manager (tag v1.1.0)

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

- background.js:205 - inside fetchOnce(), which every API call goes through; the calls to fetchOnce itself (251, 977) route here
- background.js:313 - SYNO.API.Info discovery, before any login, no credentials
- background.js:475 - the logout POST

popup/popup.js and content.js make no network call of any kind: no fetch(), XMLHttpRequest, WebSocket, sendBeacon or dynamic import(). Grepping popup.js for "fetch" matches one comment.

CHANGED IN 1.1.0

The manifest diff against 1.0.2 is two lines: the version, and one added background script, actions.js, holding shared constants. Two points: every request carrying a password or a session id changed from GET to POST, so neither reaches the NAS's own access log; and unsaved connection details moved from storage.local to storage.session.

TESTING

I cannot offer a test instance: the NAS this is built against sits on a private LAN, deliberately unreachable from the internet. Without one you can still install it, open the popup - no request is made until connection settings are saved - and point it at an unreachable host to exercise the retry path.

LICENCE

MPL-2.0, continuing the original "Download Station" add-on under the same licence, with its own extension ID and versioning. LICENSE is in the package.
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
