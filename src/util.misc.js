function isSafari() {
  return typeof safari !== 'undefined' && safari.self && typeof safari.self.addEventListener === 'function';
}

function isValidTimeStamp(timestamp) {
  return !isNaN(parseFloat(timestamp)) && isFinite(timestamp);
}

/**
 * Formats a date relative to now, e.g. "3 months ago".
 * @param {string|number|Date} date
 * @param {number=} now
 */
function timeAgo(date, now = Date.now()) {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  if (isNaN(seconds)) return '';
  if (Math.abs(seconds) < 45) return 'just now';

  const units = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['week', 7 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60]
  ];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) || units[units.length - 1];
  const value = Math.round(seconds / size) || -1;
  return new Intl.RelativeTimeFormat('en', {numeric: 'auto'}).format(value, unit);
}

/**
 * Returns the hex-encoded SHA-256 of a string. GitHub uses it to build diff anchors (#diff-<sha256(path)>).
 * @param {string} str
 * @return {Promise<string>}
 */
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Escapes text to be inserted in HTML.
 * @param {string} text
 */
function escapeHtml(text) {
  const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'};
  return String(text).replace(/[&<>"']/g, (char) => entities[char]);
}

/**
 * Removes HTML tags from a string, e.g. to show an error message as text.
 * @param {string} html
 */
function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '');
}

window.isSafari = isSafari;
window.isValidTimeStamp = isValidTimeStamp;
window.timeAgo = timeAgo;
window.sha256Hex = sha256Hex;
window.escapeHtml = escapeHtml;
window.stripTags = stripTags;
