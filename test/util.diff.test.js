const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Source files are plain browser scripts; evaluate them in a sandbox to reach their functions.
function load(...files) {
  const context = vm.createContext({window: {}, Intl, TextEncoder, crypto: globalThis.crypto});
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  }
  return context;
}

const {parsePatch, mergeFileWithPatch, patchToRows, describeRowRange, splitLines, splitHtmlLines} =
  load('src/util.diff.js');
const {timeAgo, sha256Hex} = load('src/util.misc.js');

// Values created inside the sandbox belong to another realm; copy them before deep comparisons.
const local = (value) => JSON.parse(JSON.stringify(value));
const rowsSummary = (rows) => local(rows).map((r) => `${r.type}:${r.oldNo || '-'}:${r.newNo || '-'}:${r.text}`);

test('parsePatch reads hunk headers and line types', () => {
  const hunks = parsePatch('@@ -1,3 +1,4 @@ class A\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file');
  assert.equal(hunks.length, 1);
  const [hunk] = hunks;
  assert.deepEqual(
    {oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines},
    {oldStart: 1, oldLines: 3, newStart: 1, newLines: 4}
  );
  assert.equal(hunks[0].header, 'class A');
  assert.deepEqual(local(hunks[0].lines).map((l) => l.type + l.text), ['ctxa', 'delb', 'addB', 'addC', 'ctxc']);
});

test('parsePatch defaults omitted hunk lengths to 1 and keeps empty context lines', () => {
  const hunks = parsePatch('@@ -5 +5 @@\n-x\n+y\n@@ -10,3 +10,3 @@\n a\n\n c');
  assert.equal(hunks[0].oldLines, 1);
  assert.equal(hunks[0].newLines, 1);
  assert.deepEqual(local(hunks[1].lines).map((l) => l.type), ['ctx', 'ctx', 'ctx']);
});

test('mergeFileWithPatch interleaves deletions into the whole new file', () => {
  const oldFile = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  const newFile = ['1', '2', '3', 'x', '5', '6', '7', '8', '9', '10', '11'];
  // 4 -> x, and 11 appended
  const patch = '@@ -2,5 +2,5 @@\n 2\n 3\n-4\n+x\n 5\n 6\n@@ -9,2 +9,3 @@\n 9\n 10\n+11';
  const rows = mergeFileWithPatch(newFile, parsePatch(patch));

  assert.deepEqual(rowsSummary(rows), [
    'same:1:1:1',
    'ctx:2:2:2',
    'ctx:3:3:3',
    'del:4:-:4',
    'add:-:4:x',
    'ctx:5:5:5',
    'ctx:6:6:6',
    'same:7:7:7',
    'same:8:8:8',
    'ctx:9:9:9',
    'ctx:10:10:10',
    'add:-:11:11'
  ]);
  assert.equal(rows.filter((r) => r.type !== 'del').length, newFile.length);
  assert.equal(rows.filter((r) => r.type !== 'add').length, oldFile.length);
});

test('mergeFileWithPatch handles hunks with an empty side', () => {
  // Delete lines 3-4 of a 5-line file: new side is empty and starts after line 2
  const rows = mergeFileWithPatch(['1', '2', '5'], parsePatch('@@ -3,2 +2,0 @@\n-3\n-4'));
  assert.deepEqual(rowsSummary(rows), ['same:1:1:1', 'same:2:2:2', 'del:3:-:3', 'del:4:-:4', 'same:5:3:5']);

  // Insert two lines after line 1: old side is empty and starts after line 1
  const inserted = mergeFileWithPatch(['1', 'a', 'b', '2'], parsePatch('@@ -1,0 +2,2 @@\n+a\n+b'));
  assert.deepEqual(rowsSummary(inserted), ['same:1:1:1', 'add:-:2:a', 'add:-:3:b', 'same:2:4:2']);
});

test('mergeFileWithPatch renders an added file entirely as additions', () => {
  const rows = mergeFileWithPatch(['a', 'b'], parsePatch('@@ -0,0 +1,2 @@\n+a\n+b'));
  assert.deepEqual(rowsSummary(rows), ['add:-:1:a', 'add:-:2:b']);
});

test('patchToRows keeps hunk headers and line numbers', () => {
  const rows = patchToRows(parsePatch('@@ -7,2 +7,2 @@ fn()\n-a\n+b\n c'));
  assert.deepEqual(rowsSummary(rows), ['hunk:-:-:@@ -7,2 +7,2 @@ fn()', 'del:7:-:a', 'add:-:7:b', 'ctx:8:8:c']);
});

test('rows remember their hunk, unchanged lines outside hunks have none', () => {
  const patch = '@@ -2,5 +2,5 @@\n 2\n 3\n-4\n+x\n 5\n 6\n@@ -9,2 +9,3 @@\n 9\n 10\n+11';
  const newFile = ['1', '2', '3', 'x', '5', '6', '7', '8', '9', '10', '11'];
  const hunks = (rows) => local(rows).map((r) => (r.hunk == null ? '-' : r.hunk)).join('');
  assert.equal(hunks(mergeFileWithPatch(newFile, parsePatch(patch))), '-000000--111');
  assert.equal(hunks(patchToRows(parsePatch(patch))), '-000000-111');
});

test('describeRowRange: lines of one hunk make a (multi-line) review comment', () => {
  // 1 | 2 | 3 | -4 | +x | +y | 5 | 6 | 7 (outside the hunk)
  const rows = mergeFileWithPatch(
    ['1', '2', '3', 'x', 'y', '5', '6', '7'],
    parsePatch('@@ -2,5 +2,6 @@\n 2\n 3\n-4\n+x\n+y\n 5\n 6')
  );
  const describe = (from, to) => local(describeRowRange(rows, from, to));

  // One added line
  assert.deepEqual(describe(4, 4).comment, {line: 4, side: 'RIGHT'});
  // From the deleted line to the added ones: starts on the left side, ends on the right side
  assert.deepEqual(describe(3, 5), {
    comment: {line: 5, side: 'RIGHT', startLine: 4, startSide: 'LEFT'},
    newRange: {start: 4, end: 5},
    oldRange: {start: 4, end: 4}
  });
  // Selected upwards: same range
  assert.deepEqual(describe(5, 3), describe(3, 5));
  // Unchanged lines before a deleted line are addressed on the left side, like it
  assert.deepEqual(describe(1, 3).comment, {line: 4, side: 'LEFT', startLine: 2, startSide: 'LEFT'});
  // ... and on the right side otherwise
  assert.deepEqual(describe(2, 6).comment, {line: 6, side: 'RIGHT', startLine: 3, startSide: 'RIGHT'});
  // Deleted lines only exist in the file before the change
  assert.deepEqual(describe(3, 3), {comment: {line: 4, side: 'LEFT'}, newRange: null, oldRange: {start: 4, end: 4}});
});

test('describeRowRange: lines outside the diff or across hunks cannot take a line comment', () => {
  const rows = mergeFileWithPatch(['1', '2', 'x', '4'], parsePatch('@@ -2,2 +2,2 @@\n 2\n-3\n+x'));
  // 1 is outside the hunk
  assert.deepEqual(local(describeRowRange(rows, 0, 2)), {
    comment: null,
    newRange: {start: 1, end: 2},
    oldRange: {start: 1, end: 3}
  });
  assert.equal(describeRowRange(rows, 4, 4).comment, null);

  // Hunk headers are skipped; the range spans two hunks
  const patchRows = patchToRows(parsePatch('@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d'));
  const range = local(describeRowRange(patchRows, 1, 5));
  assert.equal(range.comment, null);
  assert.deepEqual(range.newRange, {start: 1, end: 9});
  assert.deepEqual(local(describeRowRange(patchRows, 0, 2)).comment,
    {line: 1, side: 'RIGHT', startLine: 1, startSide: 'LEFT'});
});

test('splitLines drops the trailing newline only', () => {
  assert.deepEqual(local(splitLines('a\r\nb\n')), ['a', 'b']);
  assert.deepEqual(local(splitLines('a\n\n')), ['a', '']);
  assert.deepEqual(local(splitLines('')), []);
});

test('splitHtmlLines re-opens spans that cross lines', () => {
  const html = 'x <span class="c">/* a\nb */</span> <span class="k">if</span>\ny';
  assert.deepEqual(local(splitHtmlLines(html)), [
    'x <span class="c">/* a</span>',
    '<span class="c">b */</span> <span class="k">if</span>',
    'y'
  ]);
});

test('timeAgo formats relative dates', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(timeAgo('2026-09-29T11:59:50Z', now), 'just now');
  assert.equal(timeAgo('2026-09-29T11:00:00Z', now), '1 hour ago');
  assert.equal(timeAgo('2026-09-26T12:00:00Z', now), '3 days ago');
  assert.equal(timeAgo('2026-05-29T12:00:00Z', now), '4 months ago');
});

test('sha256Hex matches GitHub diff anchors', async () => {
  assert.equal(
    await sha256Hex('hadoop-hdds/client/src/main/java/org/apache/hadoop/hdds/scm/storage/StreamBlockInputStream.java'),
    'd1f908358e9741b009f4337b2a511ce101e237891dc56ea8041516775c1a1e54'
  );
});
