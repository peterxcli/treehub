// Helpers to render a whole file together with the changes from a unified diff patch.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses a unified diff patch (the `patch` field of GitHub API files) into hunks.
 * @param {string} patch
 * @return {!Array<{oldStart: number, oldLines: number, newStart: number, newLines: number,
 *   header: string, lines: !Array<{type: string, text: string}>}>}
 */
function parsePatch(patch) {
  const hunks = [];
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of (patch || '').split('\n')) {
    const match = line.match(HUNK_HEADER);
    if (match) {
      hunk = {
        oldStart: +match[1],
        oldLines: match[2] == null ? 1 : +match[2],
        newStart: +match[3],
        newLines: match[4] == null ? 1 : +match[4],
        header: match[5].trim(),
        lines: []
      };
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    const marker = line[0];
    if (marker === '+') {
      hunk.lines.push({type: 'add', text: line.slice(1)});
      newLeft--;
    } else if (marker === '-') {
      hunk.lines.push({type: 'del', text: line.slice(1)});
      oldLeft--;
    } else if (marker === ' ' || (line === '' && oldLeft > 0 && newLeft > 0)) {
      // Some tools strip the leading space of empty context lines
      hunk.lines.push({type: 'ctx', text: line.slice(1)});
      oldLeft--;
      newLeft--;
    }
    // Ignore "\ No newline at end of file" and anything else
  }

  return hunks;
}

/**
 * Merges the full content of the changed file with the hunks of its patch, producing one row per line
 * of the whole file plus the deleted lines at the positions they were removed from.
 * @param {!Array<string>} newLines lines of the file after the change
 * @param {!Array<Object>} hunks result of parsePatch()
 * @return {!Array<{type: string, oldNo: ?number, newNo: ?number, text: string, hunk: number=}>} where type is
 *   'same' (unchanged, outside of hunks), 'ctx' (unchanged, inside a hunk), 'add' or 'del', and hunk is the index
 *   of the hunk of the line (not set for 'same' lines)
 */
function mergeFileWithPatch(newLines, hunks) {
  const rows = [];
  let oldNo = 1;
  let newNo = 1;

  const pushUnchanged = (untilNewNo) => {
    while (newNo < untilNewNo && newNo <= newLines.length) {
      rows.push({type: 'same', oldNo: oldNo++, newNo, text: newLines[newNo - 1]});
      newNo++;
    }
  };

  hunks.forEach((hunk, index) => {
    // A hunk with 0 lines on one side starts *after* the given line on that side
    pushUnchanged(hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart);
    oldNo = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;

    for (const line of hunk.lines) {
      if (line.type === 'del') {
        rows.push({type: 'del', oldNo: oldNo++, newNo: null, text: line.text, hunk: index});
      } else {
        const text = newNo <= newLines.length ? newLines[newNo - 1] : line.text;
        rows.push({type: line.type, oldNo: line.type === 'ctx' ? oldNo++ : null, newNo: newNo++, text, hunk: index});
      }
    }
  });

  pushUnchanged(newLines.length + 1);
  return rows;
}

/**
 * Returns rows for the patch alone (used when the whole file can't be shown), including hunk headers.
 * @param {!Array<Object>} hunks result of parsePatch()
 */
function patchToRows(hunks) {
  const rows = [];
  hunks.forEach((hunk, index) => {
    rows.push({
      type: 'hunk',
      oldNo: null,
      newNo: null,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`.trim()
    });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      rows.push({
        type: line.type,
        oldNo: line.type === 'add' ? null : oldNo++,
        newNo: line.type === 'del' ? null : newNo++,
        text: line.text,
        hunk: index
      });
    }
  });
  return rows;
}

/**
 * Describes rows from..to (inclusive, in any order) of mergeFileWithPatch() or patchToRows(), for commenting on
 * them and linking to them.
 * @return {{
 *   comment: ?{line: number, side: string, startLine: number=, startSide: string=},
 *   newRange: ?{start: number, end: number},
 *   oldRange: ?{start: number, end: number}
 * }} comment is the target of a (multi-line) review comment, set only when all the rows are in one hunk since
 *   GitHub accepts line comments on the diff only. newRange and oldRange are the lines of the file after and
 *   before the change that the rows cover.
 */
function describeRowRange(rows, from, to) {
  const lines = rows.slice(Math.min(from, to), Math.max(from, to) + 1).filter((row) => row.type !== 'hunk');
  const span = (numbers) => (numbers.length ? {start: Math.min(...numbers), end: Math.max(...numbers)} : null);
  const newRange = span(lines.filter((row) => row.newNo).map((row) => row.newNo));
  const oldRange = span(lines.filter((row) => row.oldNo).map((row) => row.oldNo));

  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || lines.some((row) => row.hunk == null || row.hunk !== first.hunk)) {
    return {comment: null, newRange, oldRange};
  }

  // Deleted lines only exist on the left side, others are addressed on the right side, except unchanged lines
  // that start a range ending on a deleted line
  const side = last.type === 'del' ? 'LEFT' : 'RIGHT';
  const startSide = first.type === 'del' ? 'LEFT' : first.type === 'add' ? 'RIGHT' : side;
  const lineOn = (row, onSide) => (onSide === 'LEFT' ? row.oldNo : row.newNo);
  const comment = {line: lineOn(last, side), side};
  if (first !== last) Object.assign(comment, {startLine: lineOn(first, startSide), startSide});
  return {comment, newRange, oldRange};
}

/**
 * Splits text into lines, dropping the empty line produced by a trailing newline.
 * @param {string} text
 */
function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Splits highlighted HTML (spans only, text already escaped) into lines, closing and re-opening spans
 * that cross line boundaries so each line is valid HTML on its own.
 * @param {string} html
 * @return {!Array<string>}
 */
function splitHtmlLines(html) {
  const lines = [];
  const open = [];
  let current = '';
  const tokens = html.match(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g) || [];

  for (const token of tokens) {
    if (token === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (token === '</span>') {
      open.pop();
      current += token;
    } else {
      if (token.startsWith('<span')) open.push(token);
      current += token;
    }
  }

  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}
