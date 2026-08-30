/**
 * Download Station — Content Script
 *
 * Injected into all web pages at document_start.
 * Intercepts clicks on magnet: links and forwards them to the background
 * script instead of letting the browser handle them (which would normally
 * prompt to open an external application).
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

let autoCaptureMagnets = false;

// Load the setting once on script initialisation.
browser.storage.local.get({ autoCaptureMagnets: false }).then((result) => {
  autoCaptureMagnets = result.autoCaptureMagnets;
});

// React to storage changes so we pick up updates without a page reload.
browser.storage.onChanged.addListener((changes) => {
  if ('autoCaptureMagnets' in changes) {
    autoCaptureMagnets = changes.autoCaptureMagnets.newValue;
  }
});

// Use capture phase so we see the event before any page handler.
document.addEventListener(
  'click',
  (e) => {
    const link = e.target.closest('a[href^="magnet:"]');
    if (!link) return;
    if (!autoCaptureMagnets) return;

    e.preventDefault();
    e.stopPropagation();

    browser.runtime.sendMessage({
      action: 'magnetClicked',
      url: link.href,
    });
  },
  true
);
