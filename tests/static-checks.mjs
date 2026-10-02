// Static sanity checks for the Nebula Player sources.
import fs from 'node:fs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const html = fs.readFileSync(`${root}/index.html`, 'utf8');
const js = fs.readFileSync(`${root}/script.js`, 'utf8');
const css = fs.readFileSync(`${root}/styles.css`, 'utf8');
const sw = fs.readFileSync(`${root}/service-worker.js`, 'utf8');

let problems = 0;
const fail = (msg) => { console.log('  ✗ ' + msg); problems++; };
const ok = (msg) => console.log('  ✓ ' + msg);

/* 1. HTML ids */
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const idSet = new Set(ids);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
console.log(`HTML: ${ids.length} ids`);
if (dupes.length) fail('duplicate ids: ' + [...new Set(dupes)].join(', '));
else ok('no duplicate ids');

/* 2. Every $('#…') / $$('#…') used in JS must exist in the HTML */
const used = new Set([...js.matchAll(/\$\$?\(\s*['"]#([\w-]+)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !idSet.has(id));
console.log(`JS: references ${used.size} element ids`);
if (missing.length) fail('missing elements: ' + missing.join(', '));
else ok('all referenced ids exist in index.html');

/* 3. Every href="#i-…" sprite reference must have a matching <symbol id> */
const symbols = new Set([...html.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]));
const refs = new Set([...html.matchAll(/href="#(i-[\w-]+)"/g)].map((m) => m[1]));
[...js.matchAll(/icon\('([\w-]+)'/g)].forEach((m) => refs.add(m[1]));
[...js.matchAll(/'(i-[\w-]+)'/g)].forEach((m) => refs.add(m[1]));
const missingIcons = [...refs].filter((r) => !symbols.has(r));
console.log(`Sprites: ${symbols.size} symbols, ${refs.size} referenced`);
if (missingIcons.length) fail('missing sprite symbols: ' + missingIcons.join(', '));
else ok('all icon references resolve');

/* 4. CSS selector classes used in HTML/JS that are never styled (informational) */
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const htmlClasses = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const unstyled = [...htmlClasses].filter((c) => c && !cssClasses.has(c));
if (unstyled.length) console.log('  ! classes in HTML without CSS rules: ' + unstyled.join(', '));
else ok('every HTML class is styled');

/* 5. Paren nesting sanity, with a real scanner (strings/templates/regex/comments) */
function scanDepth(src) {
  const REGEX_OK = /[=(,:;[!&|?{+\-*%<>~^]|^$/;
  let depth = 0, minDepth = 0, i = 0;
  let mode = 'code';
  let prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') { mode = 'line'; i += 2; continue; }
      if (two === '/*') { mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'single'; i++; continue; }
      if (c === '"') { mode = 'double'; i++; continue; }
      if (c === '`') { mode = 'template'; i++; continue; }
      if (c === '/' && REGEX_OK.test(prev)) { mode = 'regex'; i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; minDepth = Math.min(minDepth, depth); }
      if (!/\s/.test(c)) prev = c;
      i++;
      continue;
    }
    // Inside a literal: skip over it (handling escapes and character classes).
    if (c === '\\') { i += 2; continue; }
    if (mode === 'line' && c === '\n') { mode = 'code'; i++; continue; }
    if (mode === 'block' && two === '*/') { mode = 'code'; i += 2; continue; }
    if (mode === 'single' && c === "'") { mode = 'code'; i++; continue; }
    if (mode === 'double' && c === '"') { mode = 'code'; i++; continue; }
    if (mode === 'template' && c === '`') { mode = 'code'; i++; continue; }
    if (mode === 'regex' && c === '[') { while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
    if (mode === 'regex' && c === '/') { mode = 'code'; prev = '/'; i++; continue; }
    i++;
  }
  return minDepth;
}
for (const [name, src] of [['script.js', js], ['service-worker.js', sw]]) {
  const minDepth = scanDepth(src);
  if (minDepth < 0) fail(`${name}: a ')' closes without a matching '('`);
  else ok(`${name}: paren nesting is sane`);
}

/* 6. Service worker must not reference undefined top-level identifiers */
const swHandlers = ['install', 'activate', 'fetch', 'message'].filter((h) => sw.includes(`addEventListener('${h}'`));
if (swHandlers.length === 4) ok('service worker registers install/activate/fetch/message');
else fail('service worker handlers: ' + swHandlers.join(', '));

/* 7. Manifest sanity */
const manifest = JSON.parse(fs.readFileSync(`${root}/manifest.json`, 'utf8'));
for (const key of ['name', 'short_name', 'start_url', 'display', 'icons', 'scope']) {
  if (!manifest[key]) fail('manifest missing ' + key);
}
const iconFiles = manifest.icons.map((i) => i.src);
const missingIconsFiles = iconFiles.filter((f) => !fs.existsSync(`${root}/${f}`));
if (missingIconsFiles.length) fail('manifest icons missing on disk: ' + missingIconsFiles.join(', '));
else ok('manifest complete, icons present');

/* 8. Files referenced by index.html must exist */
const srcs = [...html.matchAll(/(?:src|href)="((?!https?:|#|data:)[^"]+)"/g)].map((m) => m[1]);
const missingFiles = [...new Set(srcs)].filter((s) => !fs.existsSync(`${root}/${s}`));
if (missingFiles.length) fail('missing local files: ' + missingFiles.join(', '));
else ok(`all ${new Set(srcs).size} local asset references exist`);

console.log(problems ? `\n${problems} problem(s) found` : '\nAll static checks passed');
process.exit(problems ? 1 : 0);
