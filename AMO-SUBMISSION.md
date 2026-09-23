# AMO submission — version 1.1.6 (unreleased)

Working document for the upload at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/synology-download-manager/versions/submit/).
Not part of the extension package.

Upload `synology-download-station-manager-1.1.6.zip` after the checks below pass.
Version 1.1.4 was uploaded; 1.1.5 rolls back to the 1.1.3 implementation.
This release restores the 1.1.4 improvements and adds explicit handling of
Firefox website permissions.

**Before uploading:** leave the **support email empty**; AMO exposes it through
the public, unauthenticated API.

## Release notes

English and German only. AMO falls back to the default locale for the other
languages; the extension interface remains available in all six languages.

### English

```
Firefox website permissions

• Missing or revoked NAS access has its own message and Allow NAS access button under Settings → Connection. The message explains why access is needed. The button closes the toolbar popup for Firefox's permission dialog; reopen the extension after granting access. An extension tab stays open and tests the connection directly.
• Test, Save and test connection and two-factor submissions check access without prompting. Saving keeps the entered connection first. Automatic requests also stop without prompting or retrying missing access; permission failures are distinct from network and certificate failures.
• Right-click downloads remain available without access to the source page. Selected text is checked for links when clicked; ordinary text is ignored. Missing NAS access opens Connection in the popup, or an extension tab if necessary. Nothing is resent automatically; check Tasks before retrying an unconfirmed download.
• The magnet switch saves your choice and requests HTTP/HTTPS access directly. The popup closes for a pending prompt; approval activates capture. Refusal or revocation keeps the preference on but capture inactive. A red panel above the switch offers another permission request, without a system notification. Pages already open may need reloading after approval. Local file pages are excluded.

Fixed

• Inline errors share a red frame, including rejected two-factor codes. Option switches no longer shift popup contents out of view.
• Tests, two-factor codes, task retries and wake checks stay with their connection. Later refusals cannot erase an earlier unconfirmed task result; Retry keeps the link if deletion remains uncertain. Task errors name their source after a NAS change, including already displayed errors.
• Repeated Enter cannot duplicate a two-factor submission. Older connection replies cannot replace a newer test result in another view. Sign-outs and resets clear old drafts even after closing the popup, while preserving newer edits. Delayed refusals cannot override new grants; permission changes do not hide magnet-save errors.
• The sort-direction selector has an accessible name. Spanish and Brazilian Portuguese NAS-permission messages are clearer.

Restored after the 1.1.5 rollback

• The certificate diagnostics and fixes from 1.1.4 return. When Firefox provides an attributable certificate error, its complete explanation appears under Settings → Connection and survives reopening the popup. Both test buttons unfold the section.
• Pausing seeding torrents, magnet links in embedded frames and SVG graphics, IPv6 NAS addresses, retained links when Retry cannot finish, background monitoring and keyboard-focus fixes are included again.
• Data declarations cover credentials and selected links sent only to the configured NAS. No telemetry or third-party recipient.
```

### Deutsch

```
Website-Berechtigungen in Firefox

• Fehlender oder entzogener NAS-Zugriff wird unter Einstellungen, Verbindung erklärt. NAS-Zugriff erlauben schließt das Popup für die Firefox-Abfrage; öffne die Erweiterung danach erneut. Ein Erweiterungstab bleibt offen und testet direkt.
• Test, Speichern und testen sowie Zwei-Faktor-Anmeldungen prüfen den Zugriff ohne Abfrage. Speichern behält die Eingaben. Automatische Anfragen stoppen ebenso ohne Abfrage oder Wiederholung; Berechtigungsfehler sind von Netzwerk- und Zertifikatsfehlern unterschieden.
• Rechtsklick-Downloads bleiben ohne Zugriff auf die Quellseite verfügbar. Markierter Text wird beim Klick auf Links geprüft, gewöhnlicher ignoriert. Fehlt der NAS-Zugriff, öffnet sich Verbindung im Popup, ersatzweise im Tab. Nichts wird automatisch erneut gesendet; prüfe unbestätigte Downloads in der Aufgabenliste.
• Der Magnet-Schalter speichert deine Wahl und fragt HTTP/HTTPS-Zugriff an. Das Popup schließt für die Abfrage; Zustimmung aktiviert die Übernahme. Bei Ablehnung oder Entzug bleibt die Option an, die Übernahme aber inaktiv. Ein roter Bereich über dem Schalter bietet sie erneut an, ohne Systembenachrichtigung. Offene Seiten eventuell neu laden. Lokale Dateiseiten sind ausgeschlossen.

Behoben

• Fehlermeldungen sind rot umrahmt, auch falsche Zwei-Faktor-Codes. Optionsschalter verschieben den Fensterinhalt nicht mehr.
• Tests, Zwei-Faktor-Codes, Aufgaben- und Weckversuche bleiben bei ihrer Verbindung. Eine unbestätigte Aktion bleibt das auch nach späteren Fehlern. Bei unbestätigter Löschung bleibt der Link erhalten. Aufgabenfehler nennen nach einem NAS-Wechsel ihre Herkunft.
• Enter sendet Codes nicht doppelt. Alte Verbindungsantworten verdrängen kein neueres Testergebnis einer anderen Ansicht. Abmelden und Reset löschen alte Entwürfe auch nach Popup-Schluss, behalten neuere Eingaben. Alte Ablehnungen überschreiben keine Freigabe; Berechtigungsänderungen verbergen keine Magnet-Speicherfehler.
• Die Sortierrichtung hat eine Beschriftung für Screenreader. Spanische und portugiesische NAS-Zugriffsmeldungen sind präziser.

Wieder enthalten nach dem Rollback 1.1.5

• Zertifikatsdiagnose und Korrekturen aus 1.1.4 sind zurück. Bei einem zuordenbaren Zertifikatsfehler steht die vollständige Firefox-Erklärung unter Einstellungen, Verbindung, auch nach erneutem Öffnen. Beide Testschaltflächen öffnen den Bereich.
• Ebenso: Pausieren seedender Torrents, Magnet-Links in Frames und SVG-Grafiken, IPv6-Adressen, behaltene Links bei unvollständigem Wiederholen sowie Korrekturen an Überwachung und Tastaturfokus.
• Zugangsdaten und ausgewählte Links gehen ausschließlich an die eingerichtete NAS. Keine Telemetrie, keine Dritten.
```

## Notes to reviewer

English, one field, plain text.

```
Controls the configured Synology Download Station via its Web API.

RELEASE
1.1.6 restores 1.1.4 after the 1.1.5 rollback to 1.1.3, adding host-permission handling.

SOURCE
No build: ZIP is source. MPL-2.0, own ID. No eval(), new Function(), innerHTML, remote scripts or third-party libraries. Outfit bundled with fonts/OFL.txt.
github.com/alexandermayzel/Synology-Download-Station-Manager, intended tag v1.1.6
CSP: MV3 default minus upgrade-insecure-requests, which would block plain-HTTP NAS access.

PERMISSIONS
host_permissions is *://*/* for a configurable NAS. Requests check permissions.contains before dispatch. Test/Save/OTP only check; Save retains details first. Allow NAS access requests the saved scheme/host (all ports), closing the toolbar popup; reopen to connect. Extension tabs stay open and test.

Context-menu visibility uses context types when page access is missing; link/selection contents are validated on click. Missing NAS access opens Connection (popup or fallback tab). Nothing is resent; check Tasks for uncertain outcomes.

Tests, OTP, task retries and wake checks keep their connection. Guards prevent duplicate OTP sends and stale replies replacing newer logins or drafts. Failed task retries retain prior uncertainty and task errors retain their source.

Magnet capture defaults off. Its preference survives refusal/revocation; capture requires HTTP/HTTPS access. The switch prompts directly and closes a popup while pending. Missing access gets an inline retry panel, no system notification. Already-open pages may need reloading after approval. content_scripts covers HTTP/HTTPS in all frames; only trusted magnet clicks while active are intercepted. A failed queued preference save stays in storage.session until saved, reset or browser close.

webRequest: two non-blocking listeners observe its own NAS requests. onBeforeRequest supplies requestId; onErrorOccurred supplies the reason. Events require tabId -1, an extension originUrl if present, and an address in flight. No page traffic is recorded.

storage.session holds lastTransportError (last event), transportWatch (patterns), connectionProblem (address's failure, cleared once it answers). Records end with the browser session; no query strings, credentials or page content. Certificate classification accepts SEC_ERROR_, SSL_ERROR_, MOZILLA_PKIX_ERROR_ or, over HTTPS, prose instead of a symbolic name. It uses shape, never language; Firefox's original explanation is quoted.

DATA
Required: authenticationInfo and websiteContent. DSM username, password, two-factor code, selected links, destination and archive password go only to the configured NAS. No telemetry, developer endpoint, page address, referrer or history. Credentials: storage.local. Requests use redirect error; passwords and session IDs in POST bodies.

TESTING
Automated: 332/332 tests; verification: 335 OK / 0 errors. Signed Firefox/NAS checks are pending.
```

## Checklist — 1.1.6 (unreleased)

Release notes and notes to reviewer above are prepared for 1.1.6.
The published 1.1.4 history remains in CHANGELOG.md.

- [x] `manifest.json` version is `1.1.6`
- [x] `CHANGELOG.md` 1.1.6 release date set (2026-09-23)
- [x] Release notes and notes to reviewer fields each remain below 3,000 characters
- [x] Regression tests: 332/332 pass; verification: 335 OK / 0 errors
- [x] Package rebuilt and verified after the last extension edit
- [ ] Test the signed package in Firefox: fresh installation and update from 1.1.5
- [ ] With NAS access withheld or revoked, automatic work reports missing access
      without a permission prompt or repeated network requests
- [ ] Test, Save and test connection and OTP show missing access without a
      prompt; Save retains the entered details before showing the access button
- [ ] Deny and grant using Allow NAS access; then confirm the NAS connection works
- [ ] Allow NAS access closes the toolbar popup so Firefox's own permission
      dialog is visible; reopen it after granting access to connect. An extension
      tab stays open and tests the connection directly
- [ ] Try right-click downloads of a link and selected text without NAS access:
      the connection panel opens, with a tab if the popup cannot open. Granting
      access, then reopening the popup, connects but does not resend the download or change
      the Links list; unconfirmed outcomes still require checking the task list
- [ ] Without access to the source page, the context-menu entry remains visible
      for links and selections; selecting ordinary text sends nothing
- [ ] With popup and extension tab open, switch the NAS while a test or OTP
      submission is pending; the old attempt must not use the new connection
- [ ] Repeated Enter during a pending OTP submission sends the code only once;
      a newer OTP submission stops an older ordinary test still waiting to send;
      an old permission refusal does not block a newer grant
- [ ] Enable magnet capture with website access missing: Firefox's request opens
      directly and the toolbar popup closes while approval is pending
- [ ] Approval activates capture automatically even with the popup closed;
      refusal or revocation keeps the preference on but capture inactive
- [ ] Missing magnet access shows a red panel above the switch, with a working
      retry-permission button and no system notification
- [ ] Existing access enables capture directly; an existing extension tab stays
      open, and no new tab is opened by the magnet switch
- [ ] While another extension window saves a connection and the old NAS is slow
      to sign out, a magnet request still closes the toolbar popup; its choice
      is saved afterwards. A storage failure appears in the red magnet panel
- [ ] Reload a page opened before the website grant if it has no magnet capture
- [ ] Change the NAS during a task-action retry: no further request to the old
      NAS, and any unconfirmed result identifies the earlier connection.
      A partial Resume result must not start monitoring the new NAS
- [ ] Save a destination and keep typing while it finishes: the value at the
      click is saved, and later edits remain a draft, including in another view
- [ ] Start a fresh two-factor login while an earlier reset finishes: the new
      code prompt and entered values remain visible
- [ ] Inline errors have red frames, including a rejected two-factor code;
      progress and success messages do not get error frames
- [ ] Revoke access after it worked, then grant it again through the relevant
      control; verify NAS access and magnet capture separately
- [ ] Test a refused NAS certificate after permission is granted; confirm the
      full Firefox reason appears in the connection panel
- [ ] Committed, tagged `v1.1.6` and pushed
- [ ] Release notes pasted for English and German
- [ ] Notes to reviewer pasted
- [ ] Data collection in the AMO form matches the manifest: authentication
      information and website content, required, no optional categories
- [ ] Support email still empty
