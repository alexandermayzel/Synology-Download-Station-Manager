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
// The area check matters: this listener runs in every frame of every tab, and
// session storage changes on every keystroke in the popup's draft fields.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('autoCaptureMagnets' in changes) {
    // Cleared by "reset all settings", where undefined means back to the
    // default — which is off.
    autoCaptureMagnets = changes.autoCaptureMagnets.newValue === true;
  }
});

/**
 * Whether an anchor points at a magnet link.
 *
 * Read from the anchor's own parsed protocol rather than matched against the
 * attribute text: "MAGNET:?xt=…" is the same link to the browser, and an
 * attribute selector for "magnet:" walks straight past it. The attribute is
 * the fallback for anything that never got parsed.
 */
function isMagnetLink(anchor) {
  const protocol = typeof anchor.protocol === 'string' ? anchor.protocol : '';
  if (protocol) return protocol.toLowerCase() === 'magnet:';
  return /^\s*magnet:/i.test(anchor.getAttribute?.('href') ?? '');
}

/** The magnet link a click landed on, anywhere along its path, or null. */
function findMagnetLink(nodes) {
  for (const node of nodes) {
    if (!(node instanceof Element) || typeof node.closest !== 'function') continue;
    const anchor = node.closest('a[href]');
    if (anchor && isMagnetLink(anchor)) return anchor;
  }
  return null;
}

// Use capture phase so we see the event before any page handler.
document.addEventListener(
  'click',
  (e) => {
    // Cheapest test first: with the option off this listener does nothing at
    // all, and it is attached to every page on the web.
    if (!autoCaptureMagnets) return;
    // A page can call link.click() or dispatch a click event of its own, and
    // both reach this listener just like a real one. Only a click the user
    // actually made may send anything to their NAS.
    if (!e.isTrusted) return;
    // A link inside an open shadow tree cannot be reached from e.target with
    // closest() — the composed path passes through the hosts, so it can. Not
    // every click target is an Element either, which findMagnetLink guards.
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const link = findMagnetLink(path.length ? path : [e.target]);
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    browser.runtime.sendMessage({
      // The literal, not ACTIONS.MAGNET_CLICKED: this script is injected into
      // every page on the web, and loading actions.js beside it would put a
      // second file there for the sake of one string. Kept in step by hand —
      // actions.js says so at the other end.
      action: 'magnetClicked',
      url: link.href,
    }).catch(() => {
      // The background is gone or still starting. Nothing useful to do about it
      // from someone else's page, and leaving the rejection unhandled would
      // print an error in that page's console.
    });
  },
  true
);
