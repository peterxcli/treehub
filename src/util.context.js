// After TreeHub is updated or reloaded, the content script of the pages opened before keeps running but can't use
// the extension anymore: chrome.* calls throw "Extension context invalidated". It then stops quietly and offers
// to reload the page, which runs the new version.
const CONTEXT_INVALIDATED = /Extension context invalidated/i;
let extensionContextLost = false;

/**
 * Whether this page can still use the extension (chrome.storage, chrome.runtime).
 */
function isExtensionContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

/**
 * Reports that the extension can't be reached anymore: shows (once) a notice asking to reload the page.
 */
function onExtensionContextLost() {
  if (extensionContextLost) return;
  extensionContextLost = true;

  const $notice = $(
    '<div class="treehub-reload-notice" role="status">' +
    '<span>TreeHub was updated. Reload this page to keep using it.</span>' +
    '<button type="button" class="btn btn-sm treehub-reload-notice-reload">Reload</button>' +
    `<button type="button" class="treehub-reload-notice-close" aria-label="Dismiss">${octicon('x')}</button>` +
    '</div>'
  );
  $notice
    .on('click', '.treehub-reload-notice-reload', () => location.reload())
    .on('click', '.treehub-reload-notice-close', () => $notice.remove())
    .appendTo(document.body);
}

/**
 * A promise that never settles: what extension calls return once the extension is gone, so that the code
 * waiting for them stops instead of failing.
 */
function whenExtensionContextLost() {
  onExtensionContextLost();
  return new Promise(() => {});
}

/**
 * Sends a request (app/src/lib/messages.ts) to the background worker. Resolves with its result, or rejects with
 * an Error having the code of the failure, and its explanation (`problem`) when credentials were refused.
 */
function sendToBackground(request) {
  if (!isExtensionContextValid()) return whenExtensionContextLost();
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(request, (reply) => {
        if (chrome.runtime.lastError || !reply) {
          reject(new Error('TreeHub did not respond. Please reload this page.'));
        } else if (reply.ok) {
          resolve(reply.result);
        } else {
          reject(Object.assign(new Error(reply.error), {code: reply.code, problem: reply.problem}));
        }
      });
    } catch (err) {
      // The extension was reloaded or updated just now
      whenExtensionContextLost();
    }
  });
}

// Calls that were already running when the extension went away (not errors of other extensions)
for (const type of ['unhandledrejection', 'error']) {
  window.addEventListener(type, (event) => {
    const error = type === 'error' ? event.error || event.message : event.reason;
    if (CONTEXT_INVALIDATED.test(String((error && error.message) || error)) && !isExtensionContextValid()) {
      event.preventDefault();
      onExtensionContextLost();
    }
  });
}

window.isExtensionContextValid = isExtensionContextValid;
window.whenExtensionContextLost = whenExtensionContextLost;
window.sendToBackground = sendToBackground;
