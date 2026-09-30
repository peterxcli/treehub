# TreeHub privacy policy

Effective date: September 30, 2026

TreeHub is a browser extension that adds a code tree, pull request review tools, repository bookmarks, a pull request review queue and a history of the repositories and pull requests you open to github.com. Bookmarks, the review queue and the history are optional and need you to sign in with GitHub; they are kept by the TreeHub server, a Cloudflare Worker operated by TreeHub's developer. TreeHub does not sell or share your data with any third party.

## Without signing in

- **GitHub access token (optional).** If you enter a personal access token in TreeHub's settings, it is stored in your browser's extension storage on your device. It is sent only to GitHub (`api.github.com`), to authenticate the requests TreeHub makes on your behalf.
- **Settings.** Your preferences (for example the sidebar width, docking side, hotkeys and pull request filter) are stored in your browser's extension storage on your device.
- **GitHub page content.** TreeHub reads the GitHub page you are viewing, inside your browser, to know which repository, branch, pull request or commit to show and which files you marked as viewed. It is not sent anywhere.
- **Requests to GitHub.** To show the code tree, pull request changes, review conversations, file contents and the list of pull requests, TreeHub requests them from GitHub, directly from your browser. Review comments you write in TreeHub are sent to GitHub only when you click a button to preview or add them. GitHub's handling of these requests is covered by the [GitHub General Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

Nothing is sent to the TreeHub server until you sign in.

## When you sign in with GitHub

- **Signing in.** You authorize the TreeHub OAuth app on GitHub, which gives the TreeHub server a one-time code. The server exchanges it for a GitHub access token (with the `repo` scope), reads your public GitHub profile with it, and passes the token back to your browser. The server does not store or log the token.
- **Your GitHub token** is stored in your browser's extension storage and sent only to GitHub, like a personal access token. TreeHub uses it for the features above and to read the pull requests of your review queue and the repositories you bookmarked.
- **Your TreeHub session** is a signed token stored in your browser's extension storage and sent only to the TreeHub server. It expires after 30 days.
- **What the TreeHub server stores** (in a Cloudflare D1 database):
  - your GitHub handle, which identifies you, and your GitHub user ID, name and avatar URL, from your GitHub profile;
  - when you created your TreeHub account and when you last signed in;
  - your bookmarks: the names of the repositories you bookmarked, and when;
  - your review queue: the repository, number and title of each pull request you added, when you added it, and when you last opened it. TreeHub records that time when you open a queued pull request on github.com, and only for queued pull requests;
  - your history: the repositories and pull requests you open on github.com while signed in (the repository name, the pull request number and title), when you first and last opened each, and how many times. An entry is deleted a set number of days after you last opened it: 30 by default, from 1 to 365 in the History tab of the dashboard, where you can also pause the recording, remove entries or clear the history;
  - your history settings: how many days entries are kept, and whether the recording is paused.
- **Statuses** of queued pull requests (review requests, new commits, replies, mentions, checks and so on) are computed in your browser from GitHub's data. They are not sent to the TreeHub server.
- **Hosting.** Cloudflare, which hosts the TreeHub server, processes its requests, including your IP address, and keeps request logs for a short time, as described in [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).

## What TreeHub does not do

- It has no analytics, tracking, advertising or remotely hosted code.
- It does not sell or transfer your data to third parties, and does not use it for any purpose other than TreeHub's single purpose: adding a code tree, pull request review tools, bookmarks and a review queue to GitHub.
- It does not use your data to determine creditworthiness or for lending purposes.

TreeHub's use of data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Removing your data

- **Delete your account**: in the TreeHub dashboard, open the account menu and choose "Delete account". This deletes your account, bookmarks, review queue and history from the TreeHub server and signs you out.
- **History**: in the History tab of the dashboard, remove entries, clear the whole history, pause the recording, or choose how many days entries are kept.
- **Sign out** (dashboard or sidebar settings) deletes your GitHub token and session from your browser. "Sign out everywhere" also ends your sessions in your other browsers.
- **Revoke the GitHub authorization** of TreeHub in your [GitHub settings](https://github.com/settings/applications).
- Clear the token field in TreeHub's settings to delete a personal access token. Uninstalling TreeHub deletes everything it stored in your browser.

## Changes to this policy

If TreeHub's handling of data changes, this policy will be updated before the change is released, and the change will be announced in the release notes of the extension.

## Contact

Questions and requests: [open an issue](https://github.com/peterxcli/treehub/issues).
