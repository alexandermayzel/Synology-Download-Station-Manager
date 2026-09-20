# AMO submission — version 1.1.3

Working document for the upload at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/synology-download-manager/versions/submit/).
Not part of the extension package.

Upload `synology-download-station-manager-1.1.3.zip`.

**Before uploading:** leave the **support email empty**; AMO exposes it through
the public, unauthenticated API.

## Release notes

English and German only. AMO falls back to the default locale for the other
languages; the extension interface remains available in all six languages.

### English

```
Security

• NAS requests no longer follow redirects, so credentials cannot reach another address.
• Archive passwords and two-factor codes are cleared on sign-out and on a connection change.

Added

• The extension version is shown in Settings.
• Choosing HTTP warns that the transfer is unencrypted.

Fixed

• Unintended HTTP-to-HTTPS upgrades.
• Unanswered adds are checked against the task list; uncertain results are reported separately.
• Links containing commas are rejected, so the NAS cannot split them into two.
• Retry creates a replacement only after a confirmed deletion, and names unconfirmed outcomes as such.
• A running code check blocks further sign-ins to the same connection; stale replies no longer reopen the prompt.
• Popup sign-in failures survive the popup closing, are notified, and block further automatic sign-ins.
• Refused sign-ins stop bulk adds and confirmation checks, and stop the popup refreshing.
• Connection, destination and link drafts survive an immediate close and a pending save.
• Invalid ports are rejected, a cleared destination stays empty, and a reset clears earlier messages.
• A stale task list no longer stops the refresh, and the pause button covers every task Pause all does.
• Premature monitoring stops caused by overlapping resume, keepalive and sign-in.
• Task actions tell a connection failure before sending from an uncertain result after it.
• The connection status no longer overwrites newer sign-in results; the full text is in the tooltip.
• Folder errors name the destination used and tell it from the NAS default.
• The closing notification matches the completed, failed and paused counts.

Changed

• Screen-reader feedback for filters and pagination, and the popup's document language.
• Magnet capture handles uppercase protocol names and links in open shadow DOM.
• The wake-up wait is 60 seconds and the base add timeout 25, with extra time per link.
• The refresh interval controls the popup task list; background monitoring runs independently.

Removed

• Local .torrent and .nzb uploads. Torrent links can still be added through the context menu.
```

### Deutsch

```
Sicherheit

• Anfragen an die NAS folgen keinen Weiterleitungen mehr; Zugangsdaten gelangen so nicht an fremde Adressen.
• Archivpasswort und Zwei-Faktor-Code werden beim Abmelden und beim Verbindungswechsel gelöscht.

Neu

• Die Version der Erweiterung steht in den Einstellungen.
• Die Wahl von HTTP warnt vor unverschlüsselter Übertragung.

Behoben

• Unbeabsichtigte Umstellung von HTTP auf HTTPS.
• Unbeantwortetes Hinzufügen wird gegen die Aufgabenliste geprüft; ungewisse Ergebnisse werden getrennt gemeldet.
• Links mit Komma werden abgelehnt, damit die NAS sie nicht in zwei teilt.
• Wiederholen legt erst nach bestätigter Löschung neu an und benennt unbestätigte Ergebnisse als solche.
• Eine laufende Codeprüfung sperrt weitere Anmeldungen derselben Verbindung; veraltete Antworten öffnen die Abfrage nicht wieder.
• Im Popup gescheiterte Anmeldungen überdauern das Schließen, werden gemeldet und sperren weitere automatische Anmeldungen.
• Abgelehnte Anmeldungen beenden Sammel-Adds und Nachprüfungen und stoppen die Aktualisierung im Popup.
• Entwürfe für Verbindung, Zielordner und Linkliste überstehen sofortiges Schließen und ein laufendes Speichern.
• Ungültige Portnummern werden abgewiesen, ein geleerter Zielordner bleibt leer, und das Zurücksetzen räumt alte Meldungen weg.
• Eine veraltete Aufgabenliste stoppt die Aktualisierung nicht mehr; der Pause-Knopf deckt alle Aufgaben von Alle anhalten ab.
• Vorzeitiges Ende der Überwachung durch überlappendes Fortsetzen, Keepalive und Anmelden.
• Aufgabenaktionen unterscheiden Verbindungsfehler vor dem Senden von ungewissem Ergebnis danach.
• Der Verbindungsstatus überschreibt neuere Anmeldeergebnisse nicht mehr; der volle Text steht im Tooltip.
• Ordnerfehler nennen den verwendeten Zielordner und unterscheiden ihn vom NAS-Standard.
• Die Abschlussmeldung passt zu den Zahlen für abgeschlossen, fehlgeschlagen und pausiert.

Geändert

• Screenreader-Ansagen für Filter und Seiten sowie die Dokumentsprache des Popups.
• Die Magnet-Übernahme erkennt großgeschriebene Protokollnamen und Links im offenen Shadow DOM.
• Die Wartezeit für eine schlafende NAS beträgt 60 Sekunden, die Grundzeit fürs Hinzufügen 25, mit Zuschlag je Link.
• Die Intervall-Einstellung steuert die Aufgabenliste im Popup; die Hintergrundüberwachung läuft unabhängig davon.

Entfernt

• Das Hochladen lokaler .torrent- und .nzb-Dateien. Torrent-Links gehen weiterhin über das Kontextmenü.
```

## Notes to reviewer

English, one field, plain text.

```
WHAT IT DOES

Sends links and magnet links to the user's own Synology NAS through the official Download Station Web API and controls the resulting tasks. Torrent and NZB files are added by their link, which the NAS fetches. No vendor server is involved.

SOURCE CODE

No build step. The files in the ZIP are the unmodified source: nothing minified, transpiled or bundled. Tests and these notes are excluded. MPL-2.0, continuing the original Download Station add-on under the same licence, with its own extension ID.
github.com/alexandermayzel/Synology-Download-Station-Manager, tag v1.1.3

NO REMOTE CODE, NO THIRD PARTIES

No eval(), new Function(), innerHTML, remotely hosted script, CDN, analytics, telemetry or third-party library. The Outfit webfont is bundled in fonts/.

CONTENT SECURITY POLICY

This version declares extension_pages as script-src 'self'; object-src 'self'. For scripts and objects that is the Manifest V3 default: only packaged code runs, no inline script, no eval, no remote script. The declaration exists to drop one other part of the default, upgrade-insecure-requests, which rewrote http:// to https:// for this extension's own requests. Download Station is reachable over plain HTTP, which the settings offer, so the rewrite broke a documented option. Nothing about script execution is relaxed.

DATA COLLECTION AND PERMISSIONS

data_collection_permissions.required remains ["none"]. No permissions were added or widened. Credentials are in browser.storage.local, session state in browser.storage.session.

host_permissions "*://*/*" permits the user-configured NAS address. The content script's matches is <all_urls>: it loads on every page regardless of the magnet option. With the option off its click listener returns at once; with it on, it acts only on clicks the user made (event.isTrusted). Off by default.

WHERE REQUESTS ARE MADE

background.js has a single fetch() call site, background.js:256 in fetchOnce(). API discovery and sign-out previously called fetch() directly and now go through it too. That call sets redirect: 'error', so nothing carrying a password, a two-factor code or a session ID can be redirected to another address. Popup and content scripts make no network requests.

CHANGED IN 1.1.3

See the release notes. No new API endpoints or permissions are used; the only manifest change is the content_security_policy described above.

TESTING

144 regression tests use simulated browser storage, popup controls and NAS responses, without connecting to a real NAS. They cover network and response failures, partial task actions, delayed authentication, connection changes, redirect refusal, and two-factor sign-ins answering out of order.
No public NAS instance is provided; load it through about:debugging and point it at a test NAS.
```

## Checklist — 1.1.3 (not yet released)

Release notes and notes to reviewer above are written for 1.1.3.

- [x] `manifest.json` version is `1.1.3`
- [x] `CHANGELOG.md` release date set (2026-09-20)
- [x] Title, upload file name, release notes (en + de) and notes to reviewer written for 1.1.3
- [x] Regression tests pass
- [x] Package rebuilt and verified after the last extension edit
- [x] Tested in Firefox with a NAS
- [ ] Committed, tagged `v1.1.3` and pushed
- [ ] Release notes pasted for English and German
- [ ] Notes to reviewer pasted
- [ ] Support email still empty
