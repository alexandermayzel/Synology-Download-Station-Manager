# AMO submission — version 1.1.2

Working document for the upload at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/synology-download-manager/versions/submit/).
Not part of the extension package.

Upload `synology-download-station-manager-1.1.2.zip`.

**Before uploading:** leave the **support email empty**; AMO exposes it through
the public, unauthenticated API.

## Release notes

English and German only. AMO falls back to the default locale for the other
languages; the extension interface remains available in all six languages.

### English

```
Security

• Magnet capture only reacts to clicks you make. Web pages can no longer trigger downloads by script.
• Signing out or changing the connection cannot be undone by a delayed two-factor login response. Changing the NAS signs out the original NAS.

Fixed

• Network errors and unreadable responses no longer cause download creation to be repeated automatically. Uncertain results ask you to check Tasks before trying again.
• Pause, resume and delete report the result of each task. A task the NAS does not confirm is no longer shown as failed. Retry stops unless the original task was confirmed deleted.
• Resuming one download restarts background monitoring, including when the NAS does not confirm the result.
• File sizes and dates returned as text sort correctly. Zero sizes no longer show an invalid progress percentage.
• After a connection change, the old task list disappears and its actions can no longer affect the new NAS. Queued context-menu links and files still being read are not sent to the new connection.
• Settings saved in quick succession no longer overwrite each other. Saving the connection keeps an unsaved destination folder.
• Background monitoring no longer stops because of a delayed response, a single unanswered request or a failed new sign-in, and resumes when the task list shows running downloads. The completion notification counts every download seen running.
• A two-factor code needed while refreshing the task list is now requested, and refreshing pauses until it is entered.
• Retry uses the original folder. If adding fails after the original task was removed, the link is put back into the link list.
• A NAS that could not be woken, or a sign-in without an answer, is reported as a failure, not as an uncertain result.

Changed

• While adding downloads, the link list is read-only and the add and clear-list buttons are disabled. Links can still be copied. The controls become available once the result is displayed, including after reopening the popup.
• The updated list is saved with the result in the background, so closing the popup cannot bring back accepted links.
• Keepalive requests are skipped while the NAS was reached recently.
• Two-factor and sign-out hints have been clarified.
```

### Deutsch

```
Sicherheit

• Die automatische Magnetübernahme reagiert nur noch auf eigene Klicks. Webseiten können keine Downloads mehr per Skript auslösen.
• Eine verspätete Zwei-Faktor-Anmeldeantwort kann das Abmelden oder einen Verbindungswechsel nicht rückgängig machen. Beim NAS-Wechsel wird die ursprüngliche NAS abgemeldet.

Behoben

• Netzwerkfehler und unlesbare Antworten führen nicht mehr zum automatischen erneuten Anlegen von Downloads. Bei unklarem Ergebnis bitte vor einem weiteren Versuch die Aufgaben prüfen.
• Pausieren, Fortsetzen und Löschen melden das Ergebnis jeder einzelnen Aufgabe. Eine Aufgabe, die die NAS nicht bestätigt, gilt nicht mehr als fehlgeschlagen. Wiederholen wird abgebrochen, solange das Löschen der ursprünglichen Aufgabe nicht bestätigt ist.
• Das Fortsetzen eines einzelnen Downloads startet die Hintergrundüberwachung wieder, auch wenn die NAS das Ergebnis nicht bestätigt.
• Als Text gelieferte Dateigrößen und Zeitangaben werden korrekt sortiert. Bei Dateigröße null wird kein ungültiger Fortschritt mehr angezeigt.
• Nach einem Verbindungswechsel verschwindet die alte Aufgabenliste, und ihre Aktionen können die neue NAS nicht mehr treffen. Eingereihte Kontextmenü-Links und noch eingelesene Dateien werden nicht an die neue Verbindung gesendet.
• Kurz nacheinander gespeicherte Einstellungen überschreiben sich nicht mehr. Das Speichern der Verbindung behält einen ungespeicherten Zielordner.
• Die Hintergrundüberwachung endet nicht mehr wegen einer verspäteten Antwort, einer einzelnen unbeantworteten Anfrage oder einer gescheiterten Neuanmeldung und startet wieder, wenn die Aufgabenliste laufende Downloads zeigt. Die Abschlussmeldung zählt jeden als laufend gesehenen Download.
• Ein beim Aktualisieren der Aufgabenliste benötigter Zwei-Faktor-Code wird jetzt abgefragt; bis zur Eingabe pausiert die Aktualisierung.
• Wiederholen verwendet den ursprünglichen Ordner. Scheitert das Hinzufügen, nachdem die ursprüngliche Aufgabe entfernt wurde, steht der Link wieder in der Linkliste.
• Eine NAS, die nicht geweckt werden konnte, oder eine unbeantwortete Anmeldung wird als Fehler gemeldet statt als ungewisses Ergebnis.

Geändert

• Während des Hinzufügens sind die Linkliste schreibgeschützt und die Schaltflächen zum Hinzufügen und Leeren gesperrt. Links können weiter kopiert werden. Nach Anzeige des Ergebnisses werden die Bedienelemente wieder freigegeben, auch nach erneutem Öffnen des Popups.
• Die bereinigte Liste wird zusammen mit dem Ergebnis im Hintergrund gespeichert. Das Schließen des Popups bringt bereits akzeptierte Links nicht zurück.
• Keepalive-Anfragen entfallen, solange die NAS kürzlich erreicht wurde.
• Die Hinweise zur Zwei-Faktor-Anmeldung und zum Abmelden wurden präzisiert.
```

## Notes to reviewer

English, one field, plain text.

```
WHAT IT DOES

Sends links, magnet links and .torrent/.nzb files to the user's own Synology NAS through the official Download Station Web API, and controls the resulting tasks. Address, account and password are the user's own; no vendor server involved.

SOURCE CODE

No build step. The extension files in the ZIP are the unmodified source: nothing minified, transpiled or bundled. Development tests and these submission notes are excluded.
github.com/alexandermayzel/Synology-Download-Station-Manager

NO REMOTE CODE, NO THIRD PARTIES

The packaged extension uses no eval(), new Function(), innerHTML, remotely hosted script, CDN, analytics, telemetry or third-party library. The Outfit webfont is bundled in fonts/.

DATA COLLECTION AND PERMISSIONS

data_collection_permissions.required remains ["none"]. No permissions were added or widened. API requests go to the user's configured NAS. Credentials are stored in browser.storage.local; temporary session state is held in browser.storage.session.

host_permissions "*://*/*" permits the user-configured NAS address. The content script runs on <all_urls> to intercept magnet clicks only when that option is enabled, and only for clicks the user makes (event.isTrusted). It is off by default.

WHERE REQUESTS ARE MADE

background.js has three fetch() call sites: fetchOnce() for API requests and wake-up probes, discoverApiPaths() for API discovery, and logoutSession() for signing out. Popup and content scripts make no network requests themselves.

CHANGED IN 1.1.2

This release fixes unsafe retries of download creation, per-task result handling for pause/resume/delete including results the NAS does not confirm, late login responses after sign-out or connection changes, task actions, queued links and file uploads reaching a newly configured NAS, overlapping settings saves and polls, logout endpoint selection, resume polling, retry recovery, and numeric task fields returned as strings. The link field is read-only during an add and its result is saved with the updated draft. The keepalive skips its request after recent API contact. No new API endpoints or permissions are used.

TESTING

Regression tests use simulated browser storage, popup controls and NAS responses, without connecting to a real NAS. They cover network and response failures, partial task actions, delayed authentication, connection changes, reopening the popup during an add, and numeric fields.
No public NAS test instance is provided. The extension can be loaded temporarily in Firefox through about:debugging and configured with a test NAS.

LICENCE

MPL-2.0, continuing the original Download Station add-on under the same licence, with its own extension ID and versioning. LICENSE is in the package.
```

## Checklist

- [x] `manifest.json` version is `1.1.2`
- [x] `CHANGELOG.md` release date is 2026-09-14
- [x] Regression tests pass
- [x] Package rebuilt and verified after the last extension edit
- [x] Tested in Firefox with a NAS
- [x] Committed, tagged `v1.1.2` and pushed
- [ ] Release notes pasted for English and German
- [ ] Notes to reviewer pasted
- [ ] Support email still empty
