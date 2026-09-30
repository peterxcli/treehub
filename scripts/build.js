#!/usr/bin/env node
/**
 * Builds the extension into ./tmp/chrome (and ./dist/chrome.zip with --dist).
 *
 *   node scripts/build.js           build once
 *   node scripts/build.js --watch   rebuild on changes in src/, libs/ and app/
 *   node scripts/build.js --dist    build and zip it into dist/chrome.zip
 *
 * The content script is a concatenation of libs/ and src/. The dashboard and the background worker (app/) are
 * built by Vite, which reads VITE_TREEHUB_API and VITE_TREEHUB_DEV_LOGIN from the environment (app/src/config.ts).
 *
 * Replaces the old gulp 3 pipeline, which no longer runs on current Node versions.
 */
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const less = require('less');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
const OUT = path.join(TMP, 'chrome');
const DIST = path.join(ROOT, 'dist');
const APP_OUT = path.join(TMP, 'app'); // outDir of app/vite.config.mts
// Where the fonts and images of the stylesheet are
const URL_PREFIX = 'chrome-extension://__MSG_@@extension_id__/';

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
  'src/util.plugins.js',
  'src/util.diff.js',
  'src/util.markdown.js',
  'src/util.icons.js',
  'src/util.context.js',
  'src/core.constants.js',
  'src/core.storage.js',
  'src/core.plugins.js',
  'src/core.api.js',
  'src/adapters/adapter.js',
  'src/adapters/github.js',
  'src/view.help.js',
  'src/view.error.js',
  'src/view.tree.js',
  'src/view.options.js',
  'src/view.pr-nav.js',
  'src/view.full-file.js',
  'src/view.hub.js',
  'src/view.credentials.js',
  'src/main.js'
];

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

async function buildCss() {
  const file = path.join(ROOT, 'src/styles/treehub.less');
  const {css} = await less.render(fs.readFileSync(file, 'utf8'), {filename: file, rewriteUrls: 'all'});
  const fileIcons = read('libs/file-icons.css').split('../fonts').join(`${URL_PREFIX}fonts`);
  const jstree = read('libs/jstree.css').replace(
    /url\("(32px\.png|40px\.png|throbber\.gif)"\)/g,
    (match, image) => `url("${URL_PREFIX}images/${image}")`
  );
  return [fileIcons, jstree, css].join('\n');
}

function buildManifest() {
  const {version} = JSON.parse(read('package.json'));
  return read('src/config/wex/manifest.json').replace('$VERSION', version);
}

async function buildApp() {
  const {build: viteBuild} = await import('vite');
  await viteBuild({configFile: path.join(ROOT, 'app/vite.config.mts'), logLevel: 'warn'});
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
  await buildApp();

  fs.mkdirSync(OUT, {recursive: true});
  copyDir(path.join(ROOT, 'icons'), path.join(OUT, 'icons'));
  copyDir(path.join(ROOT, 'libs/fonts'), path.join(OUT, 'fonts'));
  copyDir(path.join(ROOT, 'libs/images'), path.join(OUT, 'images'));
  copyDir(APP_OUT, OUT);
  fs.writeFileSync(path.join(OUT, 'content.js'), js);
  fs.writeFileSync(path.join(OUT, 'content.css'), await buildCss());
  fs.writeFileSync(path.join(OUT, 'manifest.json'), buildManifest());
  fs.rmSync(APP_OUT, {recursive: true, force: true});

  console.log(`[build] done in ${Date.now() - started}ms -> ${path.relative(ROOT, OUT)}`);
}

function zip() {
  fs.mkdirSync(DIST, {recursive: true});
  const target = path.join(DIST, 'chrome.zip');
  fs.rmSync(target, {force: true});
  execFileSync('zip', ['-qr', target, '.'], {cwd: OUT});
  console.log(`[dist] ${path.relative(ROOT, target)}`);
}

function watch() {
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((err) => console.error('[build] failed:', err.message)), 100);
  };
  for (const dir of ['src', 'libs', 'app']) {
    fs.watch(path.join(ROOT, dir), {recursive: true}, rebuild);
  }
  console.log('[watch] watching src/, libs/ and app/ for changes');
}

(async () => {
  const args = process.argv.slice(2);
  try {
    await build();
    if (args.includes('--dist')) zip();
    if (args.includes('--watch')) watch();
  } catch (err) {
    console.error('[build] failed:', err.message);
    process.exit(1);
  }
})();
