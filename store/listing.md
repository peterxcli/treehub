# Chrome Web Store listing

Copy these into the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) for the TreeHub item.

## Package

Upload `dist/chrome.zip` (built with `npm run dist`).

## Store listing tab

**Name** (from the manifest): TreeHub

**Summary** (from the manifest): Code tree for GitHub with pull request review tools: changed files, review threads, full-file diffs and PR navigation.

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
• Comment on any line, start a review or add to your pending review

PULL REQUEST NAVIGATION
• The repository's open pull requests, with filters: awaiting your review, reviewed by you, no reviews, changes requested, review required, approved

PRIVACY
TreeHub has no servers and collects nothing. It works on public repositories without any setup. To browse private repositories, see viewed and resolved states everywhere and add comments, enter a GitHub personal access token in TreeHub's settings: it stays in your browser and is sent only to GitHub.

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
TreeHub adds a code tree and pull request review tools (changed files, review conversations, full-file diffs and pull request navigation) to GitHub pages.
```

**Permission justifications**:

- `storage`:

  ```text
  Saves the user's settings (sidebar width, docking side, pinning, hotkeys, pull request filter) and the optional GitHub access token locally in the browser.
  ```

- Host permission (content script on `https://github.com/*`):

  ```text
  The content script shows the TreeHub sidebar on GitHub pages. It reads the current page to know which repository, branch, pull request or commit to show, and adds the "View full" buttons to pull request diffs.
  ```

**Are you using remote code?** No, I am not using remote code. (All code, including highlight.js, is bundled in the package.)

**Data usage**, check:

- **Authentication information**: the optional GitHub personal access token, stored locally and sent only to GitHub's API.
- **Website content**: review comments the user writes are sent to GitHub when the user adds them. Page content is only read locally.

Then check all three certifications (not sold to third parties, not used for unrelated purposes, not used for creditworthiness).

**Privacy policy URL**: https://github.com/peterxcli/treehub/blob/main/PRIVACY.md

## Distribution tab

- Payments: free
- Visibility: Public
- Regions: all regions

## Test instructions (optional field for reviewers)

```text
No account or setup is needed.
1. Open https://github.com/apache/ozone/pull/11302/files and move the mouse over the "TreeHub" tab on the left edge of the page (or press Ctrl+Shift+S) to show the sidebar. Click the pin icon to keep it open.
2. The tree lists the files changed by the pull request, with additions/deletions. Click the speech-bubble counts to show review conversations; click a file or conversation to jump to it.
3. Click "View full" in the header of any diff to see the whole file with its changes.
4. Click the pull request icon in the sidebar header (second row) to list open pull requests and try the filters.
5. Click the sidebar icon in the sidebar footer to dock the sidebar on the right.
Filters marked "…you", viewed/resolved states on other pages and commenting require a GitHub personal access token entered in the settings (gear icon).
```
