// Add custom JS Tree Plugins here

/**
 * Mimic logic from JSTree
 * https://github.com/vakata/jstree/blob/master/src/misc.js#L148
 *
 * Plugin truncate path name
 */
(function($) {
  'use strict';
  $.jstree.defaults.truncate = $.noop;
  $.jstree.plugins.truncate = function(opts, parent) {
    this.redraw_node = function(obj, deep, callback, force_draw) {
      obj = parent.redraw_node.call(this, obj, deep, callback, force_draw);
      if (obj) {
        $(obj)
          .find('.jstree-anchor')
          .contents()
          .filter(function() {
            // Get text node which is path name
            return this.nodeType === 3;
          })
          .wrap('<div style="overflow: hidden;text-overflow: ellipsis;"></div>')
          .end();
      }

      return obj;
    };
  };
})($);

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
