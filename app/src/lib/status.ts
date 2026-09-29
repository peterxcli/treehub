// Review queue statuses. Each status is an independent rule evaluated on GitHub data for one pull request,
// relative to the signed-in user (their GitHub handle), e.g. "new commits since your review".
// Pure functions only (no chrome.* or fetch) so they can be unit tested with Node.

export interface PRRef {
  repo: string; // "owner/name"
  number: number;
}

export type StatusKey =
  | 'review_requested'
  | 'new_commits'
  | 'replies'
  | 'mentioned'
  | 'updated'
  | 'reviewed'
  | 'changes_requested'
  | 'approved'
  | 'approved_by_you'
  | 'checks_failing'
  | 'checks_pending'
  | 'checks_passing'
  | 'conflicts'
  | 'draft'
  | 'ready'
  | 'merged'
  | 'closed'
  | 'yours';

export type Tone = 'accent' | 'attention' | 'success' | 'danger' | 'done' | 'neutral';

export interface Status {
  key: StatusKey;
  label: string;
  tone: Tone;
  /** Whether it asks for the user's attention (counted in the toolbar badge). */
  attention: boolean;
  /** ISO time the status refers to, e.g. when the latest reply was written. */
  at?: string;
  /** Users involved, e.g. who replied. */
  users?: string[];
  /** Where to look, e.g. the latest reply. */
  url?: string;
}

export type PRStateName = 'open' | 'draft' | 'merged' | 'closed';

export interface PRState {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  state: PRStateName;
  updatedAt: string;
  statuses: Status[];
  fetchedAt: string;
  /** Set when GitHub could not return the pull request (removed, no access...). */
  error?: string;
}

/** Order in which statuses are listed. */
export const STATUS_ORDER: StatusKey[] = [
  'review_requested',
  'new_commits',
  'replies',
  'mentioned',
  'updated',
  'changes_requested',
  'approved',
  'approved_by_you',
  'reviewed',
  'checks_failing',
  'checks_pending',
  'checks_passing',
  'conflicts',
  'draft',
  'ready',
  'merged',
  'closed',
  'yours'
];

/** Labels of the status filters in the dashboard. */
export const STATUS_FILTER_LABELS: Record<StatusKey, string> = {
  review_requested: 'Review requested',
  new_commits: 'New commits since your review',
  replies: 'Replies to you',
  mentioned: 'Mentioned',
  updated: 'Updated since you looked',
  reviewed: 'Reviewed by you (not approved)',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  approved_by_you: 'Approved by you',
  checks_failing: 'Checks failing',
  checks_pending: 'Checks running',
  checks_passing: 'Checks passing',
  conflicts: 'Merge conflicts',
  draft: 'Draft',
  ready: 'Ready for review',
  merged: 'Merged',
  closed: 'Closed',
  yours: 'Your pull request'
};

// ---------- GitHub query ----------

const PR_FRAGMENT = `
fragment QueuePR on PullRequest {
  number
  title
  url
  state
  isDraft
  mergedAt
  closedAt
  updatedAt
  author { login }
  reviewDecision
  mergeable
  headRefOid
  viewerLatestReview { state submittedAt commit { oid } }
  viewerLatestReviewRequest { id }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } }
  commits(last: 100) { totalCount nodes { commit { oid committedDate } } }
  lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewThreads(last: 40) { nodes { comments(last: 20) { nodes { author { login } createdAt url } } } }
  timelineItems(last: 50, itemTypes: [MENTIONED_EVENT, READY_FOR_REVIEW_EVENT]) {
    nodes {
      __typename
      ... on MentionedEvent { createdAt actor { login } }
      ... on ReadyForReviewEvent { createdAt }
    }
  }
}`;

/** Pull requests fetched per GraphQL request. */
export const QUERY_BATCH_SIZE = 20;

/**
 * Builds one GraphQL query for several pull requests, each under the alias `pr<index>`.
 * Owners and names are validated by the backend, and JSON string syntax is valid GraphQL.
 */
export function buildQueueQuery(refs: PRRef[]): string {
  const fields = refs.map((ref, index) => {
    const [owner, name] = ref.repo.split('/');
    return `  pr${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    pullRequest(number: ${Math.floor(ref.number)}) { ...QueuePR }
  }`;
  });
  return `query TreeHubQueue {\n${fields.join('\n')}\n}\n${PR_FRAGMENT}`;
}

// ---------- Parsing ----------

interface Login {
  login: string;
}

/** The subset of the GraphQL PullRequest used by the rules. */
export interface PRNode {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  author: Login | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  headRefOid: string;
  viewerLatestReview: {state: string; submittedAt: string | null; commit: {oid: string} | null} | null;
  viewerLatestReviewRequest: {id: string} | null;
  reviewRequests: {nodes: Array<{requestedReviewer: {__typename: string; login?: string} | null}>};
  commits: {totalCount: number; nodes: Array<{commit: {oid: string; committedDate: string}}>};
  lastCommit: {nodes: Array<{commit: {statusCheckRollup: {state: string} | null}}>};
  reviewThreads: {nodes: Array<{comments: {nodes: Array<{author: Login | null; createdAt: string; url: string}>}}>};
  timelineItems: {nodes: Array<{__typename: string; createdAt?: string; actor?: Login | null}>};
}

export interface QueueQueryResult {
  data?: Record<string, {pullRequest: PRNode | null} | null> | null;
  errors?: Array<{message: string; path?: Array<string | number>}>;
}

/** Splits a batched GraphQL response per pull request (same order as the refs). */
export function readQueueResult(refs: PRRef[], result: QueueQueryResult): Array<PRNode | {error: string}> {
  return refs.map((ref, index) => {
    const alias = `pr${index}`;
    const node = result.data && result.data[alias] && result.data[alias].pullRequest;
    if (node) return node;
    const error = (result.errors || []).find((e) => e.path && e.path[0] === alias);
    return {error: error ? error.message : `Could not load ${ref.repo}#${ref.number}`};
  });
}

// ---------- Rules ----------

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const after = (a: string | null | undefined, b: string | null | undefined) => !!a && (!b || Date.parse(a) > Date.parse(b));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// "Updated" ignores activity within this margin of the last visit (e.g. the visit itself).
const SEEN_MARGIN_MS = 60 * 1000;

export interface RuleContext {
  /** GitHub handle of the signed-in user. */
  me: string;
  /** When the user last opened the pull request (from the backend), if ever. */
  lastSeenAt?: string | null;
}

/** Computes the independent statuses of a pull request for the signed-in user. */
export function computeStatuses(pr: PRNode, {me, lastSeenAt}: RuleContext): Status[] {
  const statuses: Status[] = [];
  const open = pr.state === 'OPEN';
  const mine = same(pr.author && pr.author.login, me);
  const add = (status: Status) => statuses.push(status);

  // Review requested from me, directly or through a team
  const requested =
    !!pr.viewerLatestReviewRequest ||
    pr.reviewRequests.nodes.some((node) => node.requestedReviewer && same(node.requestedReviewer.login, me));
  if (open && requested) {
    add({key: 'review_requested', label: 'Review requested', tone: 'accent', attention: true});
  }

  // My latest review (an approval is its own status), and commits pushed after it
  const review = pr.viewerLatestReview;
  if (review && !mine) {
    const at = review.submittedAt || undefined;
    if (review.state === 'APPROVED') {
      add({key: 'approved_by_you', label: 'Approved by you', tone: 'success', attention: false, at});
    } else {
      const labels: Record<string, [string, Tone]> = {
        CHANGES_REQUESTED: ['You requested changes', 'danger'],
        COMMENTED: ['You commented', 'neutral'],
        DISMISSED: ['Your review was dismissed', 'neutral']
      };
      const [label, tone] = labels[review.state] || ['You reviewed', 'neutral'];
      add({key: 'reviewed', label, tone, attention: false, at});
    }

    const reviewedOid = review.commit && review.commit.oid;
    if (open && reviewedOid && reviewedOid !== pr.headRefOid) {
      const commits = pr.commits.nodes;
      const index = commits.findIndex((node) => node.commit.oid === reviewedOid);
      const latest = commits.length ? commits[commits.length - 1].commit.committedDate : undefined;
      add({
        key: 'new_commits',
        // The reviewed commit is missing from the history after a force push
        label: index >= 0 ? `${plural(commits.length - index - 1, 'new commit')} since your review` : 'New commits since your review',
        tone: 'attention',
        attention: true,
        at: latest
      });
    }
  }

  // Replies after my last comment in each review thread I took part in
  const repliers = new Map<string, {at: string; url: string}>();
  for (const thread of pr.reviewThreads.nodes) {
    const comments = thread.comments.nodes;
    let myLast = -1;
    comments.forEach((comment, index) => {
      if (comment.author && same(comment.author.login, me)) myLast = index;
    });
    if (myLast < 0) continue;
    for (const comment of comments.slice(myLast + 1)) {
      if (!comment.author || same(comment.author.login, me)) continue;
      const known = repliers.get(comment.author.login);
      if (!known || after(comment.createdAt, known.at)) {
        repliers.set(comment.author.login, {at: comment.createdAt, url: comment.url});
      }
    }
  }
  if (repliers.size) {
    const replies = Array.from(repliers.entries()).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
    const [, latest] = replies[0];
    add({
      key: 'replies',
      label: `Replies from ${replies.map(([login]) => '@' + login).join(', ')}`,
      tone: 'attention',
      attention: after(latest.at, lastSeenAt),
      at: latest.at,
      users: replies.map(([login]) => login),
      url: latest.url
    });
  }

  // Last time I was @mentioned
  const mentions = pr.timelineItems.nodes
    .filter((item) => item.__typename === 'MentionedEvent' && item.actor && same(item.actor.login, me))
    .map((item) => item.createdAt as string)
    .sort();
  if (mentions.length) {
    const at = mentions[mentions.length - 1];
    add({key: 'mentioned', label: 'Mentioned you', tone: 'attention', attention: after(at, lastSeenAt), at});
  }

  // Activity since my last visit
  if (open && lastSeenAt && Date.parse(pr.updatedAt) > Date.parse(lastSeenAt) + SEEN_MARGIN_MS) {
    add({key: 'updated', label: 'Updated since you looked', tone: 'accent', attention: true, at: pr.updatedAt});
  }

  // Review decision, whoever reviewed
  if (open && pr.reviewDecision === 'CHANGES_REQUESTED') {
    add({key: 'changes_requested', label: 'Changes requested', tone: 'danger', attention: false});
  } else if (open && pr.reviewDecision === 'APPROVED') {
    add({key: 'approved', label: 'Approved', tone: 'success', attention: false});
  }

  // Checks of the head commit
  const lastCommit = pr.lastCommit.nodes[0];
  const checks = lastCommit && lastCommit.commit.statusCheckRollup && lastCommit.commit.statusCheckRollup.state;
  if (open && (checks === 'FAILURE' || checks === 'ERROR')) {
    add({key: 'checks_failing', label: 'Checks failing', tone: 'danger', attention: false});
  } else if (open && (checks === 'PENDING' || checks === 'EXPECTED')) {
    add({key: 'checks_pending', label: 'Checks running', tone: 'neutral', attention: false});
  } else if (open && checks === 'SUCCESS') {
    add({key: 'checks_passing', label: 'Checks passing', tone: 'success', attention: false});
  }

  if (open && pr.mergeable === 'CONFLICTING') {
    add({key: 'conflicts', label: 'Merge conflicts', tone: 'danger', attention: false});
  }

  // Lifecycle
  if (pr.state === 'MERGED') {
    add({key: 'merged', label: 'Merged', tone: 'done', attention: false, at: pr.mergedAt || undefined});
  } else if (pr.state === 'CLOSED') {
    add({key: 'closed', label: 'Closed', tone: 'danger', attention: false, at: pr.closedAt || undefined});
  } else if (pr.isDraft) {
    add({key: 'draft', label: 'Draft', tone: 'neutral', attention: false});
  } else {
    const ready = pr.timelineItems.nodes.filter((item) => item.__typename === 'ReadyForReviewEvent');
    const at = ready.length ? ready[ready.length - 1].createdAt : undefined;
    add({key: 'ready', label: 'Ready for review', tone: 'success', attention: false, at});
  }

  if (mine) add({key: 'yours', label: 'Your pull request', tone: 'neutral', attention: false});

  return statuses.sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key));
}

export function stateOf(pr: PRNode): PRStateName {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

/** Builds the displayable state of a queued pull request. */
export function toPRState(ref: PRRef, node: PRNode | {error: string}, context: RuleContext, now: string): PRState {
  if ('error' in node) {
    return {
      repo: ref.repo,
      number: ref.number,
      title: '',
      url: `https://github.com/${ref.repo}/pull/${ref.number}`,
      author: null,
      state: 'open',
      updatedAt: now,
      statuses: [],
      fetchedAt: now,
      error: node.error
    };
  }
  return {
    repo: ref.repo,
    number: ref.number,
    title: node.title,
    url: node.url,
    author: node.author ? node.author.login : null,
    state: stateOf(node),
    updatedAt: node.updatedAt,
    statuses: computeStatuses(node, context),
    fetchedAt: now
  };
}

/** Whether an open pull request needs the user's attention. Merged and closed ones never do. */
export function needsAttention(state: PRState): boolean {
  return (state.state === 'open' || state.state === 'draft') && state.statuses.some((status) => status.attention);
}

/** Key of a pull request in caches: "owner/name#number", lowercased. */
export function prKey(ref: PRRef): string {
  return `${ref.repo.toLowerCase()}#${ref.number}`;
}
