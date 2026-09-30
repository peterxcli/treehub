#!/usr/bin/env node
/**
 * Uploads a package to the Chrome Web Store and submits it for review, with the Chrome Web Store API v2 and a
 * Google Cloud service account.
 *
 *   node scripts/publish-chrome.js [dist/chrome.zip]   upload and submit for review
 *   node scripts/publish-chrome.js --upload-only [zip] upload without submitting, e.g. to fill the justifications
 *                                                      of new permissions in the Developer Dashboard first
 *   node scripts/publish-chrome.js --status            only print the status of the item (read-only)
 *   node scripts/publish-chrome.js --cancel            cancel the submission pending review, e.g. to submit a newer
 *                                                      version instead (the listing can be edited again)
 *
 * Environment:
 *   CWS_SERVICE_ACCOUNT       JSON key of the service account (or CWS_SERVICE_ACCOUNT_FILE: path to the key file)
 *   CWS_PUBLISHER_ID          publisher ID, see the Developer Dashboard
 *   CWS_EXTENSION_ID          ID of the extension
 *
 * The Chrome Web Store API must be enabled in the Google Cloud project of the service account, and the service
 * account added in the Account section of the Developer Dashboard.
 * See https://developer.chrome.com/docs/webstore/service-accounts
 */
const fs = require('fs');
const crypto = require('crypto');

const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const UPLOAD_POLL_MS = 5000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value.trim();
}

function readServiceAccount() {
  const json = process.env.CWS_SERVICE_ACCOUNT ||
    (process.env.CWS_SERVICE_ACCOUNT_FILE && fs.readFileSync(process.env.CWS_SERVICE_ACCOUNT_FILE, 'utf8'));
  if (!json) throw new Error('CWS_SERVICE_ACCOUNT (or CWS_SERVICE_ACCOUNT_FILE) is not set');

  const account = JSON.parse(json);
  if (!account.client_email || !account.private_key) {
    throw new Error('The service account key has no client_email or private_key');
  }
  return account;
}

/**
 * Exchanges a JWT signed with the service account key for an access token.
 * https://developers.google.com/identity/protocols/oauth2/service-account#httprest
 */
async function getAccessToken(account) {
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned =
    encode({alg: 'RS256', typ: 'JWT', kid: account.private_key_id}) + '.' +
    encode({iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600});
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Cannot get an access token for ${account.client_email}: ` +
      `${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

async function call(method, url, token, body, contentType) {
  const headers = {Authorization: `Bearer ${token}`};
  if (contentType) headers['Content-Type'] = contentType;

  const res = await fetch(url, {method, headers, body});
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = {message: text};
  }
  if (!res.ok) {
    const error = data.error || {};
    const message = error.message || data.message || res.statusText;
    const details = error.details && error.details.length ? `\nDetails: ${JSON.stringify(error.details)}` : '';
    throw new Error(`${method} ${url.replace(API, '')} failed (${res.status}): ${message}${details}`);
  }
  return data;
}

function describe(status) {
  const revision = (info) => {
    if (!info) return 'none';
    const channels = (info.distributionChannels || [])
      .map((channel) => `${channel.crxVersion} at ${channel.deployPercentage}%`);
    return [info.state, ...channels].join(', ');
  };
  return [
    `Item ${status.itemId}`,
    `  published: ${revision(status.publishedItemRevisionStatus)}`,
    `  submitted: ${revision(status.submittedItemRevisionStatus)}`,
    `  last upload: ${status.lastAsyncUploadState || 'none'}`,
    status.takenDown ? '  TAKEN DOWN for a policy violation' : '',
    status.warned ? '  WARNED for a policy violation' : ''
  ].filter(Boolean).join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');
  const uploadOnly = args.includes('--upload-only');
  const cancel = args.includes('--cancel');
  const zip = args.find((arg) => !arg.startsWith('--')) || 'dist/chrome.zip';

  const item = `${API}/v2/publishers/${env('CWS_PUBLISHER_ID')}/items/${env('CWS_EXTENSION_ID')}`;
  const token = await getAccessToken(readServiceAccount());
  const fetchStatus = () => call('GET', `${item}:fetchStatus`, token);

  const status = await fetchStatus();
  console.log(describe(status));
  if (statusOnly) return;

  const submitted = status.submittedItemRevisionStatus;
  const pending = submitted && submitted.state === 'PENDING_REVIEW';
  if (cancel) {
    if (!pending) throw new Error('No submission is pending review.');
    await call('POST', `${item}:cancelSubmission`, token);
    console.log('Cancelled the submission pending review.');
    console.log(describe(await fetchStatus()));
    return;
  }
  if (pending) {
    throw new Error(
      'A submission is already pending review. Cancel it (--cancel, or in the Developer Dashboard), then retry.'
    );
  }

  console.log(`Uploading ${zip}`);
  const upload = await call('POST', item.replace('/v2/', '/upload/v2/') + ':upload', token,
    fs.readFileSync(zip), 'application/zip');
  let uploadState = upload.uploadState;
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (uploadState === 'IN_PROGRESS' && Date.now() < deadline) {
    await sleep(UPLOAD_POLL_MS);
    uploadState = (await fetchStatus()).lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') {
    throw new Error(`The upload did not succeed (${uploadState}). See the item in the Developer Dashboard.`);
  }
  console.log(`Uploaded${upload.crxVersion ? ` version ${upload.crxVersion}` : ''}`);
  if (uploadOnly) {
    console.log('Not submitted: submit it in the Developer Dashboard, or run this script without --upload-only.');
    return;
  }

  const result = await call('POST', `${item}:publish`, token,
    JSON.stringify({publishType: 'DEFAULT_PUBLISH'}), 'application/json');
  console.log(`Submitted for review: ${result.state}`);
  const warnings = (result.warningInfo && result.warningInfo.warnings) || [];
  warnings.forEach((warning) => console.log(`Warning: ${warning.reason}: ${warning.description}`));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
