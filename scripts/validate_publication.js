'use strict';

const fs = require('node:fs');
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
  }
}

function validateProjectIdentity() {
  const publicUrl = 'https://github.com/NitoNetwork/Elquidus-Nito-explorer.git';
  const packageData = JSON.parse(readUtf8('package.json'));
  if (packageData.repository?.url !== `git+${publicUrl}`)
    fail('package.json does not identify the public repository');
  if (!readUtf8('README.md').includes(`git clone ${publicUrl}`))
    fail('README.md does not use the public clone URL');
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
