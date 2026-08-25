// tests/helpers/purity.js — filesystem + source scanning for the DOM-free boundary gate.
//
// WHY THIS IS A HELPER AND NOT PART OF THE TEST FILE.
// tests/tier1/suite-integrity.test.js forbids `node:fs` inside any tier-1 *test* file, so that
// a characterization test can never reach the user's real board.json or Application Support
// directory. That rule is right and stays. The core-purity gate genuinely has to read source
// files, so the reading lives here — in a helper, confined to paths inside the repository —
// and the test file stays fs-free.
//
// Everything here is discovery-driven: it walks the directories rather than naming files, so a
// module added by a later work package is covered the moment it lands, without anyone
// remembering to add it to a list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root. Nothing in this module ever looks outside it. */
export const REPO = path.resolve(HERE, '..', '..');

/**
 * The four directories ADR 005 §2 declares DOM-free and I/O-free. Listed in full even though
 * three of them do not exist yet — they arrive in WP-6, WP-7 and WP-8 and must be covered by
 * this same gate on the day they do.
 */
export const PURE_DIRS = ['src/js/core', 'src/js/crypto', 'src/js/sync', 'server/core'];

/**
 * Which directories a file in a given pure directory may import from. The dependency direction
 * is one-way (ADR 005 §2):
 *     DOM modules -> store.js -> core/ <- crypto/ <- sync/
 *                                  ^
 *                            platform/ (may import core/, never the reverse)
 */
export const ALLOWED_IMPORT_TARGETS = {
  'src/js/core': ['src/js/core'],
  'src/js/crypto': ['src/js/crypto', 'src/js/core'],
  'src/js/sync': ['src/js/sync', 'src/js/crypto', 'src/js/core'],
  'server/core': ['server/core'],
};

/**
 * ADR 005 §2's forbidden identifier list, verbatim. Each entry is matched against source with
 * comments and string literals removed, so a mention in prose never trips the gate and a real
 * reference always does.
 */
export const FORBIDDEN = [
  { name: 'window', re: /\bwindow\b/ },
  { name: 'document', re: /\bdocument\b/ },
  { name: 'localStorage', re: /\blocalStorage\b/ },
  { name: 'indexedDB', re: /\bindexedDB\b/ },
  { name: 'navigator', re: /\bnavigator\b/ },
  { name: 'alert', re: /\balert\s*\(/ },
  { name: 'fetch', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'setTimeout', re: /\bsetTimeout\b/ },
  { name: 'setInterval', re: /\bsetInterval\b/ },
  { name: 'process.env', re: /\bprocess\s*\.\s*env\b/ },
  { name: 'Date.now', re: /\bDate\s*\.\s*now\b/ },
  { name: 'Math.random', re: /\bMath\s*\.\s*random\b/ },
];

/**
 * Module specifiers that are forbidden outright. These cannot be found by the identifier scan:
 * a specifier lives inside a string literal, and the scan deliberately blanks string literals so
 * that prose mentioning `document` does not trip the gate. So they are matched against the
 * extracted specifiers instead.
 */
export const FORBIDDEN_MODULES = [{ name: 'node:fs', re: /^node:fs(\/|$)/ }];

/** @returns {boolean} */
export function dirExists(rel) {
  return fs.existsSync(path.join(REPO, rel));
}

function walkDir(absDir, relDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) walkDir(abs, rel, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push({ abs, rel, dir: null });
  }
}

/**
 * Every .js file under the pure directories that currently exist, discovered by reading the
 * directory. Recursive, so `server/core/handlers/*` is covered too.
 * @returns {Array<{abs:string, rel:string, dir:string, src:string, url:string}>}
 */
export function pureFiles() {
  const out = [];
  for (const dir of PURE_DIRS) {
    const absDir = path.join(REPO, dir);
    if (!fs.existsSync(absDir)) continue;
    const found = [];
    walkDir(absDir, dir, found);
    for (const f of found) {
      out.push({
        abs: f.abs,
        rel: f.rel,
        dir,
        src: fs.readFileSync(f.abs, 'utf8'),
        url: pathToFileURL(f.abs).href,
      });
    }
  }
  return out;
}

/**
 * Blank out comments and string/template literals, preserving line structure so reported line
 * numbers stay true. `${...}` expressions inside template literals are NOT blanked — they are
 * code, and a `document` reference hiding in one must still be caught.
 *
 * Regex literals are recognised with the usual previous-significant-token heuristic so that a
 * pattern containing a quote character cannot open a phantom string.
 */
export function stripCommentsAndStrings(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < src.length; i++) if (src[i] !== '\n') out[i] = ' ';
  };

  // A `/` starts a regex literal (rather than a division) only after one of these tokens.
  // Without the heuristic, a pattern containing a quote character would open a phantom string
  // and swallow the rest of the file.
  const REGEX_OK_AFTER = '(,=:[!&|?{};+-*%<>~^';

  const stack = ['code']; // 'code' | 'template'
  const braces = [0]; // brace depth inside the current code context
  let i = 0;
  let lastSignificant = '';

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (stack[stack.length - 1] === 'template') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { stack.pop(); lastSignificant = 'x'; i++; continue; }
      if (c === '$' && n === '{') { stack.push('code'); braces.push(0); lastSignificant = '{'; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }

    if (c === '/' && n === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && n === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, src.length));
      i = j + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      lastSignificant = 'x';
      i = j + 1;
      continue;
    }
    if (c === '`') {
      stack.push('template');
      i++;
      continue;
    }
    if (c === '{') {
      braces[braces.length - 1]++;
    } else if (c === '}') {
      if (braces[braces.length - 1] === 0 && stack.length > 1) {
        // closes a `${ }` expression: back into the template literal
        stack.pop();
        braces.pop();
        lastSignificant = 'x';
        i++;
        continue;
      }
      braces[braces.length - 1]--;
    }
    if (c === '/' && (lastSignificant === '' || REGEX_OK_AFTER.includes(lastSignificant))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '\n') break;
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
      }
      if (closed) {
        blank(i + 1, j);
        lastSignificant = 'x';
        i = j + 1;
        continue;
      }
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out.join('');
}

/**
 * @param {{rel:string, src:string}} file
 * @returns {Array<{file:string, line:number, ident:string, text:string}>}
 */
export function scanForbidden(file) {
  const cleaned = stripCommentsAndStrings(file.src);
  const hits = [];
  cleaned.split('\n').forEach((line, idx) => {
    for (const f of FORBIDDEN) {
      if (f.re.test(line)) {
        hits.push({ file: file.rel, line: idx + 1, ident: f.name, text: file.src.split('\n')[idx].trim() });
      }
    }
  });
  for (const { spec, line } of importSpecifiers(file)) {
    for (const m of FORBIDDEN_MODULES) {
      if (m.re.test(spec)) {
        hits.push({ file: file.rel, line, ident: m.name, text: spec });
      }
    }
  }
  hits.sort((a, b) => a.line - b.line);
  return hits;
}

/** Every static and dynamic import specifier in a file, with its line number. */
export function importSpecifiers(file) {
  const cleaned = stripCommentsAndStrings(file.src);
  // The specifier text itself was blanked, so read it back out of the ORIGINAL source at the
  // same offsets. Simpler: re-scan the original but only on lines the cleaned source agrees
  // carry an import/export-from/dynamic-import token.
  const lines = file.src.split('\n');
  const cleanedLines = cleaned.split('\n');
  const out = [];
  const re = /(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s+|\bimport\s+)(['"])([^'"]+)\1/g;
  cleanedLines.forEach((cl, idx) => {
    if (!/\b(import|from|require)\b/.test(cl)) return;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[idx]))) out.push({ spec: m[2], line: idx + 1 });
  });
  return out;
}

/**
 * @param {{rel:string, dir:string, src:string}} file
 * @returns {Array<{file:string, line:number, spec:string, why:string}>}
 */
export function scanImportDirection(file) {
  const allowed = ALLOWED_IMPORT_TARGETS[file.dir] || [];
  const bad = [];
  for (const { spec, line } of importSpecifiers(file)) {
    if (spec.startsWith('.')) {
      const target = path
        .relative(REPO, path.resolve(path.dirname(path.join(REPO, file.rel)), spec))
        .split(path.sep)
        .join('/');
      if (!allowed.some((a) => target === a || target.startsWith(a + '/'))) {
        bad.push({ file: file.rel, line, spec, why: `resolves to ${target}, outside [${allowed.join(', ')}]` });
      }
      continue;
    }
    if (spec.startsWith('node:')) {
      if (file.dir.startsWith('src/js/')) {
        bad.push({ file: file.rel, line, spec, why: 'client core/crypto/sync must run in a browser: no node: builtins' });
      }
      continue;
    }
    bad.push({ file: file.rel, line, spec, why: 'bare specifier — zero npm dependencies (ADR 005 header)' });
  }
  return bad;
}
