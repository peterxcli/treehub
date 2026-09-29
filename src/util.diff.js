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
 * @return {!Array<{type: string, oldNo: ?number, newNo: ?number, text: string}>} where type is
 *   'same' (unchanged, outside of hunks), 'ctx' (unchanged, inside a hunk), 'add' or 'del'
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

  for (const hunk of hunks) {
    // A hunk with 0 lines on one side starts *after* the given line on that side
    pushUnchanged(hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart);
    oldNo = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;

    for (const line of hunk.lines) {
      if (line.type === 'del') {
        rows.push({type: 'del', oldNo: oldNo++, newNo: null, text: line.text});
      } else {
        const text = newNo <= newLines.length ? newLines[newNo - 1] : line.text;
        rows.push({type: line.type, oldNo: line.type === 'ctx' ? oldNo++ : null, newNo: newNo++, text});
      }
    }
  }

  pushUnchanged(newLines.length + 1);
  return rows;
}

/**
 * Returns rows for the patch alone (used when the whole file can't be shown), including hunk headers.
 * @param {!Array<Object>} hunks result of parsePatch()
 */
function patchToRows(hunks) {
  const rows = [];
  for (const hunk of hunks) {
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
        text: line.text
      });
    }
  }
  return rows;
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
