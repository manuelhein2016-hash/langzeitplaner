// Assemble the web payload the app bundle ships — `node scripts/build-frontend.mjs`
//
// There is no bundler, no minifier and no dependency here, and there is not
// going to be one: the app is ~3 900 lines of plain ES modules and WKWebView
// loads them from disk. This script only decides WHICH FILES GET IN.
//
// WHY IT EXISTS. tauri.conf.json used to say `"frontendDist": "../"`, i.e.
// "ship the repository". Tauri copies that directory into the app bundle, so
// every build would have carried `.git` (3.3 MB of history), `tests/` (2.1 MB),
// `docs/`, `assets/` and `src-tauri/target/` onto the target Mac — blowing the
// story-22.1 size budget several times over, and putting the project's entire
// history on a family member's laptop. Neither is a thing you notice by
// looking at the app.
//
// The fix is an ALLOWLIST, not an ignore list. A denylist silently ships
// whatever nobody thought to exclude; this refuses everything it was not told
// about. `dist/` is gitignored and rebuilt from scratch every time.

import { cpSync, rmSync, mkdirSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

// Everything the page actually loads, and nothing else. index.html references
// ./src/css/*.css and ./src/js/boot.js; assets/ holds icon sources used by the
// bundlers, never by the page, so it does not travel.
const SHIP = ['index.html', 'src'];

// The web payload is ~750 KB today. This ceiling is not the DMG budget — it is
// a tripwire for "something large wandered into src/". If a legitimately big
// asset ever belongs in the bundle (a font, an illustration for LZP-106's
// unlock screen), raise it deliberately, in this file, with a reason.
const PAYLOAD_CEILING_BYTES = 4 * 1024 * 1024;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const entry of SHIP) {
  const from = resolve(ROOT, entry);
  try {
    statSync(from);
  } catch {
    console.error(`build-frontend: ${entry} does not exist`);
    process.exit(1);
  }
  cpSync(from, join(DIST, entry), { recursive: true, dereference: true });
}

// ── what actually landed ─────────────────────────────────────────────────────
let total = 0;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const size = statSync(p).size;
      total += size;
      files.push([relative(DIST, p), size]);
    }
  }
})(DIST);

// ── the invariants worth failing over ────────────────────────────────────────
const problems = [];

if (total > PAYLOAD_CEILING_BYTES) {
  const biggest = files.sort((a, b) => b[1] - a[1]).slice(0, 5);
  problems.push(
    `web payload is ${(total / 1024 / 1024).toFixed(2)} MiB, over the ${PAYLOAD_CEILING_BYTES / 1024 / 1024} MiB tripwire.\n` +
      biggest.map(([f, s]) => `    ${(s / 1024).toFixed(0).padStart(7)} KiB  ${f}`).join('\n'),
  );
}

// Nothing from the repository's plumbing may ride along, whatever anyone
// nests inside src/ later.
for (const [f] of files) {
  if (/(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)/.test(f)) problems.push(`${f} must not be in the bundle`);
  if (/\.(test|dom)\.js$/.test(f)) problems.push(`${f} is a test file and must not ship`);
}

// Story 13.4 / 21.5, and the CSP in index.html. The shipped page may not point
// at anything off-origin. Comments are stripped first so the (correct, useful)
// explanatory comments in index.html do not trip it.
const html = readFileSync(join(DIST, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
  if (/^(https?:)?\/\//i.test(m[1])) problems.push(`index.html loads an off-origin resource: ${m[1]}`);
}
if (!/<meta[^>]+Content-Security-Policy/i.test(html)) {
  problems.push('index.html has no Content-Security-Policy meta tag (story 13.4 / 21.5)');
}

if (problems.length) {
  console.error('build-frontend: refusing to ship this payload');
  for (const p of problems) console.error(`  FAIL ${p}`);
  process.exit(1);
}

console.log(`build-frontend: dist/ ready — ${files.length} files, ${(total / 1024).toFixed(0)} KiB`);
