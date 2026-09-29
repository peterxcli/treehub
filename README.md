# TreeHub

Browser extension that adds an IDE-like code tree and pull request review tools to GitHub.

![TreeHub showing the changes and review conversations of a pull request](store/screenshot-1.png)

## Features

- **Code tree**: browse repositories as a tree with file-type icons. Huge repositories are lazy-loaded.
- **Pull request changes**: only the files a pull request (or commit) changes, with additions and deletions per file and folder, the files you marked as viewed, and the review conversations with their author, replies and resolved/outdated state. Click a file or a conversation to jump to it.
- **View full file**: a "View full" button on each pull request diff shows the entire file with its changes, syntax highlighting and conversations. Comment on any line: GitHub only accepts line comments on lines of the diff, so comments on other lines are posted as file comments linking to the line.
- **Pull request navigation**: the open pull requests of the repository, with review filters (awaiting your review, reviewed by you, no reviews, changes requested, review required, approved).
- **Sidebar**: pin, resize and dock it on the left or right. Follows GitHub's light and dark themes.

## Access token

TreeHub uses the GitHub API. Without a token it works on public repositories, within GitHub's limit of 60 API requests per hour. Enter a [personal access token](https://github.com/settings/tokens/new?scopes=repo&description=TreeHub%20browser%20extension) in TreeHub's settings (gear icon) to:

- browse private repositories and raise the API limit,
- see viewed and resolved states everywhere, and use the "…you" pull request filters,
- add review comments from the "View full" dialog.

Use a classic token with the `repo` scope (or `public_repo` for public repositories only), or a fine-grained token with read access to contents and metadata, and read and write access to pull requests. The token is stored only in your browser and sent only to GitHub.

## Hotkeys

Pin or unpin the sidebar with <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>s</kbd> (macOS) or <kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>s</kbd>. Change them in the settings; separate several hotkeys with a comma. Supported modifiers: `⇧`, `shift`, `option`, `⌥`, `alt`, `ctrl`, `control`, `command` and `⌘`. Supported special keys: `backspace`, `tab`, `clear`, `enter`, `return`, `esc`, `escape`, `space`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `del`, `delete` and `f1` through `f19`.

## Privacy

TreeHub has no servers and collects nothing. See the [privacy policy](PRIVACY.md).

## Development

Requires Node.js 18+.

```bash
npm install
npm run build     # builds the extension into tmp/chrome, tmp/firefox and tmp/opera
npm start         # rebuilds on changes
npm test          # unit tests
npm run lint
```

Then load `tmp/chrome` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked). `npm run dist` zips each build into `dist/`; `dist/chrome.zip` is the Chrome Web Store package.

## Releasing

Publishing a [GitHub release](https://github.com/peterxcli/treehub/releases/new) with a tag like `v1.2.3` builds TreeHub with that version, attaches the package to the release and submits it to the Chrome Web Store ([workflow](.github/workflows/publish.yml)). Pre-releases are skipped. The version must be higher than the one in the store.

The workflow needs, in the repository settings:

- secret `CWS_SERVICE_ACCOUNT`: JSON key of a Google Cloud service account, with the Chrome Web Store API enabled in its project and its email added in the Account section of the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) ([guide](https://developer.chrome.com/docs/webstore/service-accounts)),
- variables `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID`.

Check the setup without publishing anything:

```bash
CWS_SERVICE_ACCOUNT_FILE=key.json CWS_PUBLISHER_ID=... CWS_EXTENSION_ID=... npm run publish:chrome -- --status
```

## License and credits

TreeHub is free software licensed under the [GNU Affero General Public License v3.0](LICENSE).

It is a modified version of the open-source edition of [Octotree](https://github.com/ovity/octotree) by Buu Nguyen and the Octotree team. Changes by peterxcli since 2026-09-29: pull request review features, sidebar docking, Manifest V3, a new build, and the TreeHub name and icon. TreeHub is not affiliated with or endorsed by Octotree or GitHub.

Bundled libraries: [jQuery](https://jquery.com), [jQuery UI](https://jqueryui.com), [jsTree](https://www.jstree.com), [keymaster](https://github.com/madrobby/keymaster), [file-icons](https://github.com/file-icons), [highlight.js](https://highlightjs.org) and [Octicons](https://primer.style/octicons), under their own licenses.
