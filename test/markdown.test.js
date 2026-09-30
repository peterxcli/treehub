const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The source is a plain browser script; evaluate it in a sandbox to reach its functions.
const context = vm.createContext({window: {}});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/util.markdown.js'), 'utf8'), context);
const {formatMarkdown, parsePermalink} = context;

/** Applies a format like the editor does; `|` marks the selection in `before` and `after`. */
function apply(before, format, suggestion) {
  const start = before.indexOf('|');
  const end = before.indexOf('|', start + 1) - 1;
  const value = before.replace(/\|/g, '');
  const edit = formatMarkdown(value, start, end < start ? start : end, format, suggestion);
  const next = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
  const marks = [edit.selectionStart, edit.selectionEnd];
  return marks[0] === marks[1]
    ? next.slice(0, marks[0]) + '|' + next.slice(marks[0])
    : next.slice(0, marks[0]) + '|' + next.slice(marks[0], marks[1]) + '|' + next.slice(marks[1]);
}

test('bold, italic and inline code wrap the selection, and unwrap it', () => {
  assert.equal(apply('a |word| b', 'bold'), 'a **|word|** b');
  assert.equal(apply('a **|word|** b', 'bold'), 'a |word| b');
  assert.equal(apply('a |word| b', 'italic'), 'a _|word|_ b');
  assert.equal(apply('a |word| b', 'code'), 'a `|word|` b');
  // Nothing selected: the caret lands between the markers
  assert.equal(apply('a |', 'bold'), 'a **|**');
});

test('code over several lines makes a block on its own lines', () => {
  assert.equal(apply('see |x = 1\ny = 2|', 'code'), 'see \n```\n|x = 1\ny = 2|\n```');
});

test('links: text becomes the label, a URL the target', () => {
  assert.equal(apply('|docs|', 'link'), '[docs](|url|)');
  assert.equal(apply('|https://github.com|', 'link'), '[|](https://github.com)');
});

test('line formats prefix every selected line, and toggle', () => {
  assert.equal(apply('|one\ntwo|', 'unordered'), '|- one\n- two|');
  assert.equal(apply('|- one\n- two|', 'unordered'), '|one\ntwo|');
  assert.equal(apply('|one\ntwo\nthree|', 'ordered'), '|1. one\n2. two\n3. three|');
  assert.equal(apply('|one|', 'task'), '|- [ ] one|');
  assert.equal(apply('in the mi|ddle', 'quote'), '> in the middle|');
  assert.equal(apply('before\n|title|\nafter', 'heading'), 'before\n|### title|\nafter');
  // A selection ending at the start of a line doesn't take that line
  assert.equal(apply('|a\n|b', 'quote'), '|> a|\nb');
  // Task items aren't bullet items
  assert.equal(apply('|- [ ] one|', 'unordered'), '|- - [ ] one|');
});

test('mentions, references and suggestions', () => {
  assert.equal(apply('cc |', 'mention'), 'cc @|');
  assert.equal(apply('fixes |', 'reference'), 'fixes #|');
  assert.equal(apply('Maybe: |', 'suggestion', 'const x = 2;'), 'Maybe: \n```suggestion\n|const x = 2;|\n```\n');
  assert.equal(apply('|', 'suggestion', 'a\nb'), '```suggestion\n|a\nb|\n```\n');
});

test('permalinks to lines of the repository', () => {
  const repo = {username: 'apache', reponame: 'ozone'};
  const sha = '88d2060800612ea6cdc3f792ade322b191a5737d';
  const base = `https://github.com/apache/ozone/blob/${sha}/hadoop-ozone/Some%20File.java`;
  const read = (url) => JSON.parse(JSON.stringify(parsePermalink(url, repo)));
  assert.deepEqual(read(`${base}#L25-L36`), {sha, path: 'hadoop-ozone/Some File.java', start: 25, end: 36});
  assert.deepEqual(read(`${base}#L7`), {sha, path: 'hadoop-ozone/Some File.java', start: 7, end: 7});
  // Columns of GitHub's code view, reversed ranges, query strings (?plain=1 for Markdown files)
  assert.deepEqual(read(`${base}#L7C3-L9C1`), {sha, path: 'hadoop-ozone/Some File.java', start: 7, end: 9});
  assert.deepEqual(read(`${base}#L9-L7`), {sha, path: 'hadoop-ozone/Some File.java', start: 7, end: 9});
  assert.equal(read(`https://github.com/Apache/Ozone/blob/${sha}/README.md?plain=1#L1`).path, 'README.md');
  // Not snippets: other repositories, branches, no lines
  assert.equal(parsePermalink(`https://github.com/apache/hadoop/blob/${sha}/README.md#L1`, repo), null);
  assert.equal(parsePermalink('https://github.com/apache/ozone/blob/master/README.md#L1', repo), null);
  assert.equal(parsePermalink(`${base}`, repo), null);
  assert.equal(parsePermalink(`${base}#L0`, repo), null);
});
