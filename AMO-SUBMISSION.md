# AMO submission — version 1.1.4

Working document for the upload at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/synology-download-manager/versions/submit/).
Not part of the extension package.

Upload `synology-download-station-manager-1.1.4.zip`.

**Before uploading:** leave the **support email empty**; AMO exposes it through
the public, unauthenticated API.

## Release notes

English and German only. AMO falls back to the default locale for the other
languages; the extension interface remains available in all six languages.

### English

```
Added

• Entering an IP address under HTTPS now points out that the certificate has to match it.
• Certificate failures show Firefox's own explanation. Where two requests to one address overlap and the reason cannot be attributed, the general message stands.
• The full reason is selectable under Settings, Connection and stays after reopening the popup. Any answer at that address clears it. Both test buttons unfold the section; the short notification points there.

Fixed

• Seeding torrents can be paused; they had no pause button, and Pause all walked past them.
• Magnet links inside an embedded frame are captured; only the top document was reached before.
• Magnet links in SVG graphics are sent as URLs instead of objects.
• IPv6 NAS addresses work with or without square brackets in the Host field.
• A refused task list stops the confirmation check and gives that reason; the download stays uncertain. The notification says so for right-clicks and captured magnets too.
• Retry keeps the link when the NAS is changed after the old task was already removed.
• Retry calls a task removed only when the NAS confirmed that deletion; a reply refusing it, or naming no task, was reported as a removal.
• Retry, pause, resume and delete name the reason a secure connection was refused.
• Retry respects a failed connection test before it wakes the NAS.
• Failures from the previous NAS no longer block the new connection or count toward stopping its download watch.
• After a successful sign-in, older sign-in failures no longer block the connection.
• A late answer from the connection watch no longer ends a session that has been set up since.
• Keyboard focus stays on the same button when the list refreshes, and the list is not scrolled back to it.
• Switching the NAS while a download watch was finishing no longer signs the new connection out again.
• The task counter on the extension icon is no longer cleared by a slower background check that answered late.
• The bundled Outfit webfont now ships with its licence text as fonts/OFL.txt.

Changed

• Recognised certificate failures are reported without automatic retries.
• Wording and translations improved throughout, in all six languages.
• The manifest now declares what is transmitted: authentication information and website content for the links you hand over. The recipient is unchanged: the NAS you configured and nowhere else, no telemetry, no third party.
```

### Deutsch

```
Neu

• Beim Eintragen einer IP-Adresse unter HTTPS steht jetzt dabei, dass das Zertifikat dazu passen muss.
• Bei Zertifikatsfehlern wird die Meldung von Firefox angezeigt. Überlappen zwei Anfragen an dieselbe Adresse und lässt sich der Grund nicht zuordnen, bleibt die allgemeine Meldung.
• Der vollständige Grund steht markierbar unter Einstellungen, Verbindung und bleibt nach erneutem Öffnen. Eine Antwort an dieser Adresse löscht ihn. Beide Testschaltflächen öffnen den Bereich; die kurze Benachrichtigung verweist dorthin.

Behoben

• Seedende Torrents lassen sich pausieren; bisher fehlte der Knopf dafür.
• Magnet-Links in eingebetteten Frames werden übernommen; bisher nur im obersten Dokument.
• Magnet-Links in SVG-Grafiken werden als URLs statt als Objekte übergeben.
• IPv6-Adressen der NAS funktionieren im Hostfeld mit und ohne eckige Klammern.
• Eine abgelehnte Aufgabenliste beendet die Nachprüfung mit dem Grund; der Download bleibt ungewiss. Das nennt die Benachrichtigung auch bei Rechtsklick und Magnet-Link.
• Wiederholen behält den Link, wenn die NAS nach dem Entfernen der alten Aufgabe gewechselt wird.
• Wiederholen meldet eine Aufgabe nur als entfernt, wenn die NAS deren Löschung bestätigt hat.
• Wiederholen, Pausieren, Fortsetzen und Löschen nennen den Grund einer abgelehnten gesicherten Verbindung mit.
• Wiederholen beachtet einen fehlgeschlagenen Verbindungstest, bevor es die NAS weckt.
• Fehler der vorherigen NAS sperren die neue Verbindung nicht mehr und zählen nicht zum Abbruch ihrer Download-Überwachung.
• Nach einer erfolgreichen Anmeldung blockieren ältere Anmeldefehler die Verbindung nicht mehr.
• Eine verspätete Antwort der Verbindungsüberwachung beendet keine inzwischen neu aufgebaute Sitzung mehr.
• Der Tastaturfokus bleibt beim Aktualisieren auf derselben Schaltfläche, und die Liste springt nicht dorthin zurück.
• Ein NAS-Wechsel während des Auslaufens der Überwachung meldet die neue Verbindung nicht mehr ab.
• Der Aufgabenzähler am Erweiterungssymbol wird nicht mehr von einer spät antwortenden Hintergrundprüfung geleert.
• Die Outfit-Schrift bringt ihren Lizenztext als fonts/OFL.txt mit.

Geändert

• Erkannte Zertifikatsfehler werden ohne automatische Wiederholungen gemeldet.
• Formulierungen und Übersetzungen in allen sechs Sprachen überarbeitet.
• Das Manifest deklariert jetzt, was übertragen wird: Anmeldeinformationen und Website-Inhalte für die übergebenen Links. Empfänger bleibt ausschließlich die eingerichtete NAS, ohne Telemetrie, ohne Dritte.
```

## Notes to reviewer

English, one field, plain text.

```
Controls the user's own Synology Download Station via its Web API.

SOURCE CODE

No build step: the ZIP is the unmodified source. MPL-2.0, own extension ID. No eval(), new Function(), innerHTML, remote script, CDN or third-party library; the Outfit webfont is bundled in fonts/ with its OFL.txt.
github.com/alexandermayzel/Synology-Download-Station-Manager, tag v1.1.4

CSP unchanged since 1.1.3: MV3 default minus upgrade-insecure-requests, which broke plain-HTTP NAS access.

PERMISSIONS

data_collection_permissions.required is ["authenticationInfo","websiteContent"], where 1.1.3 declared none: what goes to the user's configured NAS includes the DSM user name, password and two-factor code, the links picked, their folder and an archive password where given - which Mozilla counts as data leaving the browser. It goes nowhere else: no telemetry, no third party, nothing to the developer. No page address, referrer or history. Credentials live in storage.local.

"webRequest" is new in 1.1.4 and the only addition; host_permissions is unchanged.

Why: fetch rejects every network failure with one opaque TypeError - a refused certificate and a sleeping NAS look the same. onErrorOccurred is the only Firefox API naming the real reason; getSecurityInfo() needs webRequestBlocking and headers that never arrive.

Scope: two non-blocking listeners - nothing blocked, modified, redirected or cancelled. onErrorOccurred for the reason, onBeforeRequest for the requestId that ties it to its request. Patterns come from the addresses this extension requests itself, never <all_urls>; an event must have no tab (tabId === -1), an originUrl of this extension where given, and an address in flight - so a tab's own NAS interface is ignored.

Read and never sent: requestId, error string, request type, address without its query string, timestamp. Three diagnostic records in storage.session, all ending with the browser session: lastTransportError, the last event; transportWatch, the registered patterns and their time; connectionProblem, the configured address's failure, shown in the panel and cleared once anything answers. Recognised by Firefox's symbolic security names (SEC_ERROR_, SSL_ERROR_, MOZILLA_PKIX_ERROR_) or, over HTTPS, by an error given as a sentence rather than a name - shape, never wording; anything else keeps the general message.

host_permissions "*://*/*" covers the user-configured NAS address. The content script (matches <all_urls>) acts only on user clicks (event.isTrusted) and only with the magnet option on, off by default; all_frames is new in 1.1.4, for iframes.

One fetch() call site, background.js:832 in fetchOnce(), with redirect: 'error' so no password, code or session ID goes elsewhere.

TESTING: 216 regression tests against simulated storage, popup and NAS replies; load via about:debugging.
```

## Checklist — 1.1.4 (not yet released)

Release notes and notes to reviewer above are written for 1.1.4.

- [x] `manifest.json` version is `1.1.4`
- [x] `CHANGELOG.md` release date set (2026-09-23)
- [x] Title, upload file name, release notes (en + de) and notes to reviewer written for 1.1.4
- [x] Regression tests pass
- [x] Package rebuilt and verified after the last extension edit
- [ ] Tested in Firefox with a NAS — the refused certificate reproduced end to end
- [ ] Committed, tagged `v1.1.4` and pushed
- [ ] Release notes pasted for English and German
- [ ] Notes to reviewer pasted
- [ ] Data collection in the AMO form matches the manifest: authentication
      information and website content, required, no optional categories
- [ ] Support email still empty
