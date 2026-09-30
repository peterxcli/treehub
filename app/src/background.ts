// Background service worker: answers requests of the dashboard and the sidebar (lib/messages.ts), refreshes the
// review queue periodically and shows how many pull requests need attention on the toolbar icon.
import {REFRESH_MINUTES} from './config.ts';
import * as hub from './lib/hub.ts';
import type {Reply, Request} from './lib/messages.ts';
import {load} from './lib/storage.ts';

const ALARM = 'treehub.refresh';
const DASHBOARD = chrome.runtime.getURL('dashboard.html');

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, {periodInMinutes: REFRESH_MINUTES, delayInMinutes: 1});
  }
}

async function refreshAll(): Promise<void> {
  const {auth} = await load();
  if (!auth) return;
  await hub.sync();
  await hub.refreshStatuses();
}

/** Focuses the dashboard if it is open, else opens it. */
async function openDashboard(view?: string): Promise<void> {
  const url = view ? `${DASHBOARD}#${view}` : DASHBOARD;
  const contexts = await chrome.runtime.getContexts({contextTypes: [chrome.runtime.ContextType.TAB]});
  const open = contexts.find((context) => context.documentUrl && context.documentUrl.split('#')[0] === DASHBOARD);
  if (open && open.tabId >= 0) {
    await chrome.tabs.update(open.tabId, view ? {active: true, url} : {active: true});
    if (open.windowId >= 0) await chrome.windows.update(open.windowId, {focused: true});
  } else {
    await chrome.tabs.create({url});
  }
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'treehub:signIn':
      return hub.signIn(request.devLogin);
    case 'treehub:signOut':
      return hub.signOut(request.everywhere);
    case 'treehub:deleteAccount':
      return hub.deleteAccount();
    case 'treehub:sync':
      return hub.sync();
    case 'treehub:refresh':
      if (request.ifOlderThanMs !== undefined) return hub.refreshIfOlderThan(request.ifOlderThanMs);
      return refreshAll();
    case 'treehub:refreshRepos':
      return hub.refreshRepos(request.force);
    case 'treehub:setBookmark':
      return hub.setBookmark(request.repo, request.on);
    case 'treehub:setQueued':
      return hub.setQueued({repo: request.repo, number: request.number}, request.on, {
        title: request.title,
        seen: request.seen
      });
    case 'treehub:seen':
      return hub.markSeen({repo: request.repo, number: request.number}, request.force);
    case 'treehub:openDashboard':
      return openDashboard(request.view);
    case 'treehub:explainCredentials':
      return hub.explainResponse(request.response, request.source);
    case 'treehub:tokenAccepted':
      return hub.recordTokenAccepted(request.source, request.scopes);
    case 'treehub:dismissSigninProblem':
      return hub.dismissSigninProblem();
    case 'treehub:recordView':
      return hub.recordView({kind: request.kind, repo: request.repo, number: request.number}, request.title);
    case 'treehub:listHistory':
      return hub.listHistory({limit: request.limit, cursor: request.cursor, kind: request.kind});
    case 'treehub:deleteHistoryEntry':
      return hub.deleteHistoryEntry({kind: request.kind, repo: request.repo, number: request.number});
    case 'treehub:clearHistory':
      return hub.clearHistory();
    case 'treehub:getHistorySettings':
      return hub.getHistorySettings();
    case 'treehub:setHistorySettings':
      return hub.setHistorySettings({retentionDays: request.retentionDays, paused: request.paused});
  }
  throw new Error(`Unknown request: ${(request as {type?: string}).type}`);
}

chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse: (reply: Reply) => void) => {
  if (sender.id !== chrome.runtime.id || !request || typeof request.type !== 'string') return false;
  if (!request.type.startsWith('treehub:')) return false;
  handle(request).then(
    (result) => sendResponse({ok: true, result: result ?? null}),
    (err) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: err && err.code,
        // Why the credentials were refused, e.g. an expired session (lib/credentials.ts)
        problem: err && err.problem
      })
  );
  return true; // responds asynchronously
});

chrome.action.onClicked.addListener(() => {
  void openDashboard();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshAll().catch((err) => console.warn('[TreeHub] refresh failed:', err));
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
  void hub.updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void hub.updateBadge();
});
