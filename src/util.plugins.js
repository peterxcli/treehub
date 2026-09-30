// Add custom JS Tree Plugins here

/**
 * Plugin laying out the rows of the tree so that the sidebar doesn't cut them when it is narrow: names wrap where they
 * read well split (see breakableName), and the stats of a change go to their own line when they don't fit next to the
 * name. Rows are [icon] [name] [stats and conversations], see .treehub-node-body in github.less.
 */
(function($) {
  'use strict';
  $.jstree.defaults.wrap = $.noop;
  $.jstree.plugins.wrap = function(opts, parent) {
    this.redraw_node = function(obj, deep, callback, force_draw) {
      obj = parent.redraw_node.call(this, obj, deep, callback, force_draw);
      if (obj) {
        obj.querySelectorAll('.jstree-anchor:not(.treehub-node)').forEach(layoutRow);
      }

      return obj;
    };
  };

  function layoutRow(anchor) {
    const body = document.createElement('span');
    body.className = 'treehub-node-body';
    const name = document.createElement('span');
    name.className = 'treehub-node-name';
    const meta = document.createElement('span');
    meta.className = 'treehub-node-meta';

    for (const node of [...anchor.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        name.append(breakableName(node.textContent));
        node.remove();
      } else if (node.matches('.treehub-patch, .treehub-comments-toggle')) {
        meta.append(node);
      } else if (!node.matches('.jstree-themeicon')) {
        name.append(node);
      }
    }
    body.append(name);
    if (meta.firstChild) body.append(meta);
    anchor.append(body);
    anchor.classList.add('treehub-node');
  }
})($);

/**
 * Returns a name with opportunities to break its line where it reads well split (see splitName).
 * @param {string} text
 * @return {!DocumentFragment}
 */
function breakableName(text) {
  const fragment = document.createDocumentFragment();
  splitName(text).forEach((part, index) => {
    if (index) fragment.append(document.createElement('wbr'));
    fragment.append(part);
  });
  return fragment;
}

window.breakableName = breakableName;

/**
 * Plugin rendering the review conversations of a changed file below its node.
 * Threads are read from node.original.patch.threads and shown when node.original.commentsExpanded is set.
 * The markup is produced by the `comments.render(node)` setting.
 */
(function($) {
  'use strict';
  $.jstree.defaults.comments = {render: null};
  $.jstree.plugins.comments = function(opts, parent) {
    this.redraw_node = function(obj, deep, callback, force_draw) {
      obj = parent.redraw_node.call(this, obj, deep, callback, force_draw);
      const render = this.settings.comments.render;
      if (obj && render) {
        const node = this.get_node(obj.id);
        const original = node && node.original;
        if (original && original.commentsExpanded && original.patch && original.patch.threads) {
          $(obj).append(render(node));
        }
      }

      return obj;
    };
  };
})($);
