# Chrome Web Store listing

Copy these into the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) for the TreeHub item.

## Package

Upload `dist/chrome.zip` (built with `npm run dist`).

## Store listing tab

**Name** (from the manifest): TreeHub

**Summary** (from the manifest): Code tree for GitHub with pull request review tools, repository bookmarks and a review queue.

**Category**: Developer Tools

**Language**: English

**Description**:

```text
TreeHub adds an IDE-like code tree and pull request review tools to GitHub.

CODE TREE
• Browse any repository as a tree, with file-type icons
• Lazy loading for huge repositories
• Pin, resize and dock the sidebar on the left or right
• Follows GitHub's light and dark themes

PULL REQUEST CHANGES
• Only the files a pull request or commit changes, with additions and deletions per file and folder
• The files you already marked as viewed
• Review conversations in the tree: author, replies, resolved and outdated states
• Click a file or a conversation to jump to it

VIEW FULL FILE
• A "View full" button on each diff shows the entire file with its changes and syntax highlighting
• Existing conversations appear next to their lines
• Select lines with a click, Shift+click or drag, then comment on them or copy their permalink
• Comment on any line or range, start a review or add to your pending review

PULL REQUEST NAVIGATION
• The repository's open pull requests, with filters: awaiting your review, reviewed by you, no reviews, changes requested, review required, approved

REVIEW QUEUE
• One click on a pull request adds it to your review queue; the icon turns bold while it is queued
• For each queued pull request, TreeHub shows what concerns you, each as its own status: review requested, new commits since your review, replies to your review comments and who wrote them, when you were last mentioned, updates since you last looked, approved, approved by you, your other reviews, changes requested, checks, merge conflicts, draft, ready for review, merged, closed
• Refreshed every 15 minutes; the toolbar icon counts the pull requests that need your attention

BOOKMARKS
• One click bookmarks the current repository; the icon turns bold once bookmarked
• Your bookmarks with their description, language, stars, open pull requests and issues

HISTORY
• The repositories and pull requests you open on GitHub, most recent first and grouped by day, so you can find them again
• Kept 30 days after your last visit by default (from 1 to 365 days); pause the recording, remove entries or clear it anytime

DASHBOARD
• The extension's own page lists your review queue, with filters by status and sorting, your bookmarks and your history
• Sign in with GitHub: your bookmarks, queue and history follow you across browsers

PRIVACY
The code tree and review tools work on public repositories without any setup or account, and talk only to GitHub. Bookmarks and the review queue need you to sign in with GitHub: the TreeHub server then keeps your GitHub handle, your bookmarks and your queued pull requests. Your GitHub token stays in your browser, statuses are computed there, and you can delete your account from the dashboard. Details: https://github.com/peterxcli/treehub/blob/main/PRIVACY.md

TreeHub is open source under the AGPL-3.0: https://github.com/peterxcli/treehub
Based on the open-source edition of Octotree. Not affiliated with or endorsed by Octotree or GitHub.
```

**Graphic assets** (in this folder):

- Store icon: `icon-128.png`
- Screenshots (1280×800): `screenshot-1.png` to `screenshot-5.png`
- Small promo tile (440×280): `promo-small.png`

**Homepage URL**: https://github.com/peterxcli/treehub

**Support URL**: https://github.com/peterxcli/treehub/issues

## Privacy tab

**Single purpose description**:

```text
TreeHub helps developers navigate and review code on GitHub: a code tree and pull request review tools (changed files, review conversations, full-file diffs, pull request navigation) on GitHub pages, plus repository bookmarks and a review queue that tracks what changed on the pull requests the user follows.
```

**Permission justifications**:

- `storage`:

  ```text
  Saves the user's settings (sidebar width, docking side, pinning, hotkeys, pull request filter), the optional GitHub access token, the sign-in session, and a local copy of the user's bookmarks and review queue with the computed statuses, so that GitHub pages and the dashboard show them without waiting.
  ```

- `identity`:

  ```text
  Runs "Sign in with GitHub" with chrome.identity.launchWebAuthFlow: the GitHub OAuth authorization page opens in a window, and the result comes back to the extension through its chromiumapp.org redirect URL. Sign-in is optional and only needed for bookmarks and the review queue.
  ```

- `alarms`:

  ```text
  Refreshes the statuses of the pull requests in the user's review queue every 15 minutes, so the count of pull requests that need attention on the toolbar icon stays current.
  ```

- Host permission (content script on `https://github.com/*`):

  ```text
  The content script shows the TreeHub sidebar on GitHub pages. It reads the current page to know which repository, branch, pull request or commit to show, and adds the "View full" buttons to pull request diffs.
  ```

**Are you using remote code?** No, I am not using remote code. (All code, including highlight.js, is bundled in the package.)

**Data usage**, check:

- **Personally identifiable information**: when the user signs in, the TreeHub server stores their GitHub handle, user ID, name and avatar URL from their GitHub profile.
- **Authentication information**: the GitHub token (from signing in, or a personal access token) stored locally and sent only to GitHub's API; the TreeHub session token stored locally and sent only to the TreeHub server.
- **Web history**: while the user is signed in, the GitHub repositories and pull requests they open (repository name, pull request number and title, first and last visit, number of visits), stored by the TreeHub server for the user's history; deleted a set number of days after the last visit (30 by default, 1 to 365), pausable and clearable in the dashboard. Also, for pull requests in the review queue, the time the user last opened them.
- **Website content**: the names of bookmarked repositories and the repository, number and title of queued pull requests, stored by the TreeHub server; review comments the user writes are sent to GitHub when the user adds them. Other page content is only read locally.

Then check all three certifications (not sold to third parties, not used for unrelated purposes, not used for creditworthiness).

**Privacy policy URL**: https://github.com/peterxcli/treehub/blob/main/PRIVACY.md

## Distribution tab

- Payments: free
- Visibility: Public
- Regions: all regions

## Test instructions (optional field for reviewers)

```text
Steps 1-5 need no account or setup.
1. Open https://github.com/apache/ozone/pull/11302/files and move the mouse over the "TreeHub" tab on the left edge of the page (or press Ctrl+Shift+S) to show the sidebar. Click the pin icon to keep it open.
2. The tree lists the files changed by the pull request, with additions/deletions. Click the speech-bubble counts to show review conversations; click a file or conversation to jump to it.
3. Click "View full" in the header of any diff to see the whole file with its changes.
4. Click the pull request icon in the sidebar header (second row) to list open pull requests and try the filters.
5. Click the sidebar icon in the sidebar footer to dock the sidebar on the right.
Bookmarks and the review queue need a GitHub account (any account works):
6. Click the TreeHub toolbar icon to open the dashboard and click "Sign in with GitHub".
7. Back on the pull request, click the review icon in the sidebar header (second row) to add it to the review queue, and the bookmark icon to bookmark the repository. Both turn bold.
8. The dashboard lists the queued pull request with its statuses, and the bookmark. The account menu has "Delete account".
```
