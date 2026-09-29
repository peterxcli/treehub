import type {PRRef} from '../lib/status.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "3 days ago", then a date. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const elapsed = Math.max(0, now - time);
  const ago = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return ago(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return ago(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 30 * DAY) return ago(Math.floor(elapsed / DAY), 'day');
  const date = new Date(time);
  return `on ${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric'
  })}`;
}

/** Full local date and time, for tooltips. */
export function fullTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleString();
}

/** 1234 -> "1.2k" */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1}).format(value);
}

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const NAME = '[A-Za-z0-9._-]{1,100}';
const REPO_PATTERN = new RegExp(`^(${OWNER})/(${NAME})$`);
const URL_PATTERN = new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER})/(${NAME})(?:/(.*))?$`, 'i');

function cleanName(name: string): string | null {
  const clean = name.replace(/\.git$/, '');
  return clean && clean !== '.' && clean !== '..' ? clean : null;
}

/** Reads "owner/name" or a GitHub URL of a repository (or of anything in it). */
export function parseRepository(input: string): string | null {
  const text = input.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const match = text.match(URL_PATTERN) || text.match(REPO_PATTERN);
  if (!match) return null;
  const name = cleanName(match[2]);
  return name ? `${match[1]}/${name}` : null;
}

/** Reads "owner/name#123", "owner/name/pull/123" or the URL of a pull request. */
export function parsePullRequest(input: string): PRRef | null {
  const text = input.trim().replace(/[?#](?!\d+$).*$/, '');
  const short = text.match(new RegExp(`^(${OWNER})/(${NAME})#(\\d+)$`));
  if (short) {
    const name = cleanName(short[2]);
    return name ? {repo: `${short[1]}/${name}`, number: Number(short[3])} : null;
  }
  const url = text.match(URL_PATTERN) || text.match(new RegExp(`^(${OWNER})/(${NAME})/(.*)$`));
  const pull = url && url[3] && url[3].match(/^pulls?\/(\d+)(?:\/|$)/);
  if (!url || !pull) return null;
  const name = cleanName(url[2]);
  const number = Number(pull[1]);
  return name && number > 0 && number <= 2147483647 ? {repo: `${url[1]}/${name}`, number} : null;
}
