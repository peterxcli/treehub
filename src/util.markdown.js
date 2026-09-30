// Markdown formatting of the comment editor (view.full-file.js), like the toolbar of GitHub's comment boxes.

// Formats that prefix each selected line
const MARKDOWN_LINE_PREFIXES = {
  heading: () => '### ',
  quote: () => '> ',
  unordered: () => '- ',
  ordered: (index) => `${index + 1}. `,
  task: () => '- [ ] '
};
const MARKDOWN_LINE_PREFIX_PATTERNS = {
  heading: /^#{1,6} /,
  quote: /^> ?/,
  unordered: /^[-*] (?!\[[ x]\] )/,
  ordered: /^\d+\. /,
  task: /^[-*] \[[ x]\] /
};

/**
 * Applies a format to the selection of a textarea.
 * @param {string} value the text
 * @param {number} start start of the selection
 * @param {number} end end of the selection
 * @param {string} format bold, italic, code, link, heading, quote, unordered, ordered, task, mention, reference or
 *   suggestion
 * @param {string=} suggestion for the "suggestion" format: the lines it suggests to change
 * @return {{from: number, to: number, text: string, selectionStart: number, selectionEnd: number}} replace
 *   value[from, to) by text, then select [selectionStart, selectionEnd) of the new value
 */
function formatMarkdown(value, start, end, format, suggestion = '') {
  const selected = value.slice(start, end);
  const replace = (from, to, text, selectionStart, selectionEnd = selectionStart) =>
    ({from, to, text, selectionStart, selectionEnd});

  switch (format) {
    case 'bold':
      return wrapMarkdown(value, start, end, '**');
    case 'italic':
      return wrapMarkdown(value, start, end, '_');
    case 'code': {
      if (!selected.includes('\n')) return wrapMarkdown(value, start, end, '`');
      // A block starts on its own line
      const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
      const text = `${before}\`\`\`\n${selected}\n\`\`\``;
      return replace(start, end, text, start + before.length + 4, start + before.length + 4 + selected.length);
    }
    case 'link': {
      // A selected URL becomes the target, other text the label
      if (/^https?:\/\/\S+$/.test(selected)) return replace(start, end, `[](${selected})`, start + 1);
      const text = `[${selected}](url)`;
      return replace(start, end, text, start + selected.length + 3, start + selected.length + 6);
    }
    case 'mention':
      return replace(start, end, `@${selected}`, start + 1 + selected.length);
    case 'reference':
      return replace(start, end, `#${selected}`, start + 1 + selected.length);
    case 'suggestion': {
      const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
      const text = `${before}\`\`\`suggestion\n${suggestion}\n\`\`\`\n`;
      // The suggested lines are selected, ready to be edited
      const linesStart = start + before.length + 14;
      return replace(start, end, text, linesStart, linesStart + suggestion.length);
    }
  }

  if (!MARKDOWN_LINE_PREFIXES[format]) throw new Error(`Unknown format: ${format}`);
  // The whole lines of the selection
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = value.indexOf('\n', Math.max(end - (end > start && value[end - 1] === '\n' ? 1 : 0), start));
  const to = lineEnd === -1 ? value.length : lineEnd;
  const lines = value.slice(from, to).split('\n');
  const pattern = MARKDOWN_LINE_PREFIX_PATTERNS[format];
  // Toggles: removes the prefix when every line has it
  const text = lines.every((line) => pattern.test(line))
    ? lines.map((line) => line.replace(pattern, '')).join('\n')
    : lines.map((line, index) => MARKDOWN_LINE_PREFIXES[format](index) + line).join('\n');
  return start === end && lines.length === 1
    ? replace(from, to, text, from + text.length)
    : replace(from, to, text, from, from + text.length);
}

/** Wraps the selection in a marker, or removes the marker around it. */
function wrapMarkdown(value, start, end, marker) {
  const size = marker.length;
  if (value.slice(start - size, start) === marker && value.slice(end, end + size) === marker) {
    return {
      from: start - size,
      to: end + size,
      text: value.slice(start, end),
      selectionStart: start - size,
      selectionEnd: end - size
    };
  }
  return {
    from: start,
    to: end,
    text: marker + value.slice(start, end) + marker,
    selectionStart: start + size,
    selectionEnd: end + size
  };
}

// https://github.com/<owner>/<name>/blob/<commit SHA>/<path>[?query]#L<start>[C<column>][-L<end>[C<column>]]
const MARKDOWN_PERMALINK_PATTERN = new RegExp(
  '^https://github\\.com/([^/]+)/([^/]+)/blob/([0-9a-f]{40})/([^?#]+)(?:\\?[^#]*)?' +
  '#L(\\d+)(?:C\\d+)?(?:-L(\\d+)(?:C\\d+)?)?$'
);

/**
 * Reads a permalink to lines of a file in a repository, which GitHub shows as a snippet of the code in the comments
 * of that repository: a link to lines of the file at a commit, e.g.
 * https://github.com/owner/repo/blob/<commit SHA>/path/to/file#L10-L20.
 * @param {string} url
 * @param {{username: string, reponame: string}} repo
 * @return {?{sha: string, path: string, start: number, end: number}} null for another link, or another repository
 */
function parsePermalink(url, repo) {
  const match = MARKDOWN_PERMALINK_PATTERN.exec(url);
  if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== `${repo.username}/${repo.reponame}`.toLowerCase()) {
    return null;
  }
  let path;
  try {
    path = match[4].split('/').map(decodeURIComponent).join('/');
  } catch (err) {
    return null;
  }
  const [start, end] = [+match[5], match[6] ? +match[6] : +match[5]].sort((a, b) => a - b);
  return start ? {sha: match[3], path, start, end} : null;
}

window.formatMarkdown = formatMarkdown;
window.parsePermalink = parsePermalink;
