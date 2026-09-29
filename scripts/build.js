#!/usr/bin/env node
/**
 * Builds the extension into ./tmp/<browser> (and ./dist/*.zip with --dist).
 *
 *   node scripts/build.js           build once
 *   node scripts/build.js --watch   rebuild on changes in src/ and libs/
 *   node scripts/build.js --dist    build and zip each browser folder into dist/
 *
 * Replaces the old gulp 3 pipeline, which no longer runs on current Node versions.
 */
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const less = require('less');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
const DIST = path.join(ROOT, 'dist');

const LIB_FILES = [
  'libs/file-icons.js',
  'libs/jquery.js',
  'libs/jquery-ui.js',
  'libs/jstree.js',
  'libs/keymaster.js'
];

// Order matters: files are concatenated into a single scope.
const SRC_FILES = [
  'src/util.module.js',
  'src/util.async.js',
  'src/util.misc.js',
  'src/util.deXss.js',
  'src/util.plugins.js',
  'src/util.diff.js',
  'src/util.icons.js',
  'src/core.constants.js',
  'src/core.storage.js',
  'src/core.plugins.js',
  'src/core.api.js',
  'src/adapters/adapter.js',
  'src/adapters/pjax.js',
  'src/adapters/github.js',
  'src/view.help.js',
  'src/view.error.js',
  'src/view.tree.js',
  'src/view.options.js',
  'src/view.pr-nav.js',
  'src/view.full-file.js',
  'src/main.js'
];

const BROWSERS = {
  chrome: 'chrome-extension://__MSG_@@extension_id__/',
  opera: 'chrome-extension://__MSG_@@extension_id__/',
  firefox: 'moz-extension://__MSG_@@extension_id__/'
};

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function buildTemplate() {
  const escaped = read('src/template.html')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\\'')
    .replace(/\r?\n/g, '\\n\' +\n    \'');
  return `const TEMPLATE = '${escaped}';\n`;
}

function buildOnDemandLibs() {
  const dir = path.join(ROOT, 'libs/ondemand');
  return fs
    .readdirSync(dir)
    .sort()
    .map((file) => `window['${file}'] = function () {\n${fs.readFileSync(path.join(dir, file), 'utf8')}\n};\n`)
    .join('');
}

function buildJs() {
  const extension = [buildTemplate(), ...SRC_FILES.map(read)].join('\n');
  return [...LIB_FILES.map(read), buildOnDemandLibs(), extension]
    .map((code) => `(function(){\n${code}\n})();`)
    .join('\n');
}

async function buildCss(urlPrefix) {
  const file = path.join(ROOT, 'src/styles/treehub.less');
  const {css} = await less.render(fs.readFileSync(file, 'utf8'), {filename: file, rewriteUrls: 'all'});
  const fileIcons = read('libs/file-icons.css').split('../fonts').join(`${urlPrefix}fonts`);
  const jstree = read('libs/jstree.css').replace(
    /url\("(32px\.png|40px\.png|throbber\.gif)"\)/g,
    (match, image) => `url("${urlPrefix}images/${image}")`
  );
  return [fileIcons, jstree, css].join('\n');
}

function buildManifest() {
  const {version} = JSON.parse(read('package.json'));
  return read('src/config/wex/manifest.json').replace('$VERSION', version);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, {recursive: true});
  for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function build() {
  const started = Date.now();
  fs.rmSync(TMP, {recursive: true, force: true});

  const js = buildJs();
  const manifest = buildManifest();

  for (const [browser, urlPrefix] of Object.entries(BROWSERS)) {
    const out = path.join(TMP, browser);
    fs.mkdirSync(out, {recursive: true});
    copyDir(path.join(ROOT, 'icons'), path.join(out, 'icons'));
    copyDir(path.join(ROOT, 'libs/fonts'), path.join(out, 'fonts'));
    copyDir(path.join(ROOT, 'libs/images'), path.join(out, 'images'));
    fs.writeFileSync(path.join(out, 'content.js'), js);
    fs.writeFileSync(path.join(out, 'content.css'), await buildCss(urlPrefix));
    fs.writeFileSync(path.join(out, 'manifest.json'), manifest);
  }

  console.log(`[build] done in ${Date.now() - started}ms -> ${path.relative(ROOT, TMP)}/{${Object.keys(BROWSERS)}}`);
}

function zipAll() {
  fs.mkdirSync(DIST, {recursive: true});
  for (const browser of Object.keys(BROWSERS)) {
    const target = path.join(DIST, browser === 'opera' ? 'opera.nex' : `${browser}.zip`);
    fs.rmSync(target, {force: true});
    execFileSync('zip', ['-qr', target, '.'], {cwd: path.join(TMP, browser)});
    console.log(`[dist] ${path.relative(ROOT, target)}`);
  }
}

function watch() {
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((err) => console.error('[build] failed:', err.message)), 100);
  };
  for (const dir of ['src', 'libs']) {
    fs.watch(path.join(ROOT, dir), {recursive: true}, rebuild);
  }
  console.log('[watch] watching src/ and libs/ for changes');
}

(async () => {
  const args = process.argv.slice(2);
  try {
    await build();
    if (args.includes('--dist')) zipAll();
    if (args.includes('--watch')) watch();
  } catch (err) {
    console.error('[build] failed:', err.message);
    process.exit(1);
  }
})();
