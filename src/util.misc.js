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

/**
 * The JSON body of a failed response. GitHub's API answers errors in JSON, also to requests of text, which
 * jQuery doesn't parse.
 * @param {!Object} jqXHR
 * @return {*} undefined if the body isn't JSON
 */
function errorJson(jqXHR) {
  if (jqXHR.responseJSON !== undefined) return jqXHR.responseJSON;
  try {
    return JSON.parse(jqXHR.responseText);
  } catch (err) {
    return undefined;
  }
}

/**
 * Splits a file or folder name where it reads well split across lines: after the "/" of merged folders, after "_" and
 * "-", before the extension, and between the words of camelCase names (OMKeyInfo: OM, Key, Info).
 * @param {string} name
 * @return {!Array<string>}
 */
function splitName(name) {
  return name.split(/(?<=[/_-])|(?=\.)|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
}

/**
 * Whether a credential issued and expiring at these times (RFC 3339) has passed half its lifetime, when it is renewed
 * (as pastHalfLife in app/src/lib/credentials.ts).
 */
function pastHalfLife(issuedAt, expiresAt, now = Date.now()) {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  return !isNaN(issued) && !isNaN(expires) && now > issued + (expires - issued) / 2;
}

window.isValidTimeStamp = isValidTimeStamp;
window.timeAgo = timeAgo;
window.sha256Hex = sha256Hex;
window.escapeHtml = escapeHtml;
window.stripTags = stripTags;
window.errorJson = errorJson;
window.splitName = splitName;
window.pastHalfLife = pastHalfLife;
