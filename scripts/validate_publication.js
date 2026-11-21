'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const sass = require('sass');

const root = path.resolve(__dirname, '..');
const textExtensions = new Set([
  '.conf', '.css', '.ejs', '.html', '.js', '.json', '.md', '.pug', '.scss',
  '.example', '.sh', '.template', '.txt', '.xml', '.yaml', '.yml'
]);
const textNames = new Set([
  '.gitattributes', '.gitignore', '.npmrc', '.nvmrc', 'cluster', 'instance',
  'LICENSE', 'README.md', 'UPGRADE'
]);
const forbiddenFiles = [
  /(^|\/)settings\.json$/i,
  /(^|\/)\.env(?:\.|$)/i,
  /\.(?:cookie|key|kdbx|p12|pem|pfx|seed|wallet)$/i,
  /(^|\/)wallet\.dat$/i
];
const localUserPath = /(?:^|[\s"'(=])[A-Za-z]:[\\/](?:Users|Documents|Desktop|Downloads|AppData)[\\/]/im;
const retiredRuntimeRepository = /github\.com\/team-exor\/eiquidus/i;
const fontAwesomeManifest = Object.freeze({
  'public/vendor/fontawesome/css/all.min.css': '74005d7c17d4a02f2f25404ec0655d9bc2fdaa53166874c87d7b7eec69d9088a',
  'public/vendor/fontawesome/webfonts/fa-brands-400.ttf': '808443ae6c8204395add8543da8a90a60b9376fb0f87ed8e8ea37d109596d805',
  'public/vendor/fontawesome/webfonts/fa-brands-400.woff2': 'd7236a19bf23cbb2027280e8f51dc99d6c45976a2ed60de73382b034b18a2b68',
  'public/vendor/fontawesome/webfonts/fa-regular-400.ttf': '54cf6086f7bb21f9d072ad494a19b4681fa516dd0a14cee52da01d3651a913a3',
  'public/vendor/fontawesome/webfonts/fa-regular-400.woff2': 'e3456d1283b9d75337a773dfd147bf908fd02c01b4bf48576d8603a69b13cbe5',
  'public/vendor/fontawesome/webfonts/fa-solid-900.ttf': 'd2f0593540b0e33ba6de255a54f272d466e31144806956bea8cfdbf7edffc9bd',
  'public/vendor/fontawesome/webfonts/fa-solid-900.woff2': 'aa75998623a391e61c6901794ace832e3ecdd288b56d608f21bea0411acc0b8e',
  'public/vendor/fontawesome/webfonts/fa-v4compatibility.ttf': '30f6abf6baa425825828793d6dfad1fb63765d0e5abaa7af6feafb9bfcece5a0',
  'public/vendor/fontawesome/webfonts/fa-v4compatibility.woff2': '0ce9033c69dc714f5f45ef9bf17d55e4c46bcdfad6799a4e92b38e7781bf86bd',
  'licenses/FONTAWESOME-FREE-6.7.2.txt': '9b914eae88817d63b576eab5aafde7068c7a1abae125d7cdfb034f1da43a9afc'
});

function fail(message) {
  throw new Error(message);
}

function trackedFiles() {
  const output = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  return output.split('\0')
    .filter(Boolean)
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => fs.existsSync(path.join(root, file)));
}

function isText(file) {
  return textNames.has(path.basename(file)) || textExtensions.has(path.extname(file).toLowerCase());
}

function readUtf8(file) {
  const bytes = fs.readFileSync(path.join(root, file));
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    fail(`${file} is not valid UTF-8`);
  }
}

function validateTree(files) {
  for (const file of files) {
    if (forbiddenFiles.some(pattern => pattern.test(file)))
      fail(`Sensitive runtime file is tracked: ${file}`);
    if (!isText(file)) continue;
    const content = readUtf8(file);
    if (localUserPath.test(content))
      fail(`Local user-profile path found in ${file}`);
    if (retiredRuntimeRepository.test(content))
      fail(`Retired upstream runtime link found in ${file}`);
  }
}

function validateProjectIdentity() {
  const publicUrl = 'https://github.com/NitoNetwork/Elquidus-Nito-explorer.git';
  const packageData = JSON.parse(readUtf8('package.json'));
  if (packageData.repository?.url !== `git+${publicUrl}`)
    fail('package.json does not identify the public repository');
  if (!readUtf8('README.md').includes(`git clone ${publicUrl}`))
    fail('README.md does not use the public clone URL');
  if (!readUtf8('lib/provenance.js').includes(publicUrl.replace(/\.git$/, '')))
    fail('Runtime source provenance does not identify the public repository');
  if (!readUtf8('views/layout.pug').includes('includes/provenance.pug'))
    fail('The shared layout does not render verified source provenance');
}

function validateMarkdownLinks(files) {
  const markdown = files.filter(file => path.extname(file).toLowerCase() === '.md');
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of markdown) {
    const content = readUtf8(file);
    for (const match of content.matchAll(linkPattern)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, '');
      if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget))
        continue;
      const target = decodeURIComponent(rawTarget.split('#', 1)[0].split('?', 1)[0]);
      if (!target) continue;
      const resolved = path.resolve(path.dirname(path.join(root, file)), target);
      if (!resolved.startsWith(root + path.sep) && resolved !== root)
        fail(`Markdown link escapes the repository in ${file}: ${rawTarget}`);
      if (!fs.existsSync(resolved))
        fail(`Broken local Markdown link in ${file}: ${rawTarget}`);
    }
  }
}

function validateCdnIntegrity() {
  const templates = ['views/layout.pug', 'views/includes/common.pug'];
  for (const file of templates) {
    const lines = readUtf8(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes('https://') || !/\b(?:link|script)\(/.test(line)) return;
      if (/google\.com\/recaptcha|js\.hcaptcha\.com/.test(line)) return;
      if (!line.includes('integrity='))
        fail(`External browser asset lacks SRI in ${file}:${index + 1}`);
      if (!line.includes("crossorigin='anonymous'") && !line.includes('crossorigin="anonymous"'))
        fail(`External browser asset lacks anonymous CORS in ${file}:${index + 1}`);
    });
  }
}

function validateBundledFontAwesome() {
  const layout = readUtf8('views/layout.pug');
  const stylesheet = readUtf8('public/vendor/fontawesome/css/all.min.css');
  if (!layout.includes("href='/vendor/fontawesome/css/all.min.css'"))
    fail('The shared layout does not load the bundled Font Awesome stylesheet');
  if (/use\.fontawesome\.com/i.test(layout))
    fail('The shared layout still loads Font Awesome from a third party');

  for (const [file, expectedHash] of Object.entries(fontAwesomeManifest)) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) fail(`Bundled Font Awesome asset is missing: ${file}`);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (actualHash !== expectedHash) fail(`Bundled Font Awesome asset hash mismatch: ${file}`);
  }

  for (const file of Object.keys(fontAwesomeManifest).filter(file => file.includes('/webfonts/'))) {
    const basename = path.basename(file);
    if (!stylesheet.includes(`../webfonts/${basename}`))
      fail(`Bundled Font Awesome stylesheet does not reference ${basename}`);
  }
}

function validateThemes() {
  const cssRoot = path.join(root, 'public', 'css');
  const stylePath = path.join(cssRoot, 'style.scss');
  const source = fs.readFileSync(stylePath, 'utf8');
  const themes = fs.readdirSync(path.join(cssRoot, 'themes'), {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (themes.length !== 26) fail(`Expected 26 distributed themes, found ${themes.length}`);

  for (const theme of themes) {
    const warnings = [];
    const themedSource = source
      .replace("@use 'theme-selector' as theme-selector;", `$publication-theme-name: "${theme}";`)
      .replaceAll('theme-selector.$theme-name', '$publication-theme-name');
    const result = sass.compileString(themedSource, {
      loadPaths: [cssRoot],
      logger: {warn: warning => warnings.push(warning)},
      style: 'compressed',
      url: pathToFileURL(stylePath)
    });
    if (warnings.length) fail(`${theme} emitted ${warnings.length} Sass warning(s)`);
    if (!result.css.includes('.nito-supply-row'))
      fail(`${theme} output is missing the NITO supply styles`);
  }
}

function main() {
  const files = trackedFiles();
  validateTree(files);
  validateProjectIdentity();
  validateMarkdownLinks(files);
  validateBundledFontAwesome();
  validateCdnIntegrity();
  validateThemes();
  console.log(`Publication validation passed: ${files.length} tracked files, 26 themes.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
