// tests/helpers/importgraph.js — "what can this entry point actually reach?"
//
// WHY THIS EXISTS.
// Principle 7 and story 15.1 say solo mode must not get one instruction heavier because family
// mode exists, and ADR 002 §1/§2.4 turn that into a specific, checkable claim:
//
//     First run mints only a memberId and a deviceShort. NO KEYGEN, NO PROBE, NO NETWORK.
//     Key generation happens at the family opt-in moment and nowhere else.
//
// That is a statement about the MODULE GRAPH, not about a code path: an `import` of
// `src/js/crypto/…` from a boot module is evaluated on first run whether or not anybody calls the
// function, and the honest form of "solo mode generates nothing" is "solo mode cannot even reach
// the generator". A comment cannot enforce that and a reviewer will not notice the day someone
// adds a convenience import; a walk of the graph will.
//
// It lives in a helper because `tests/tier1/suite-integrity.test.js` forbids `node:fs` inside any
// tier-1 TEST file — a rule that protects the user's real board.json and stays. The reading is
// confined to paths inside the repository.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** Static `import … from '…'`, `export … from '…'`, and dynamic `import('…')`. */
const SPEC_RE = /(?:\bimport\s*\(|\bfrom\s+|\bimport\s+)(['"])([^'"]+)\1/g;

/** Strip line and block comments so a specifier named only in prose is not counted as an edge. */
function decomment(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every repo-relative module reachable from `entryRel` by following relative import specifiers,
 * transitively. Bare and `node:` specifiers are ignored (there are none in `src/`, and
 * `core-purity.test.js` is what enforces that).
 *
 * @param {string} entryRel e.g. `'src/js/boot.js'`
 * @returns {{reached:string[], edges:Array<{from:string, to:string}>}} `reached` includes the
 *          entry itself, sorted; `edges` is every import that was followed, so a failing test can
 *          print the actual path rather than just the destination.
 */
export function reachableFrom(entryRel) {
  const seen = new Set();
  const edges = [];
  const queue = [entryRel];

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);

    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    const src = decomment(fs.readFileSync(abs, 'utf8'));

    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(src))) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue;
      const to = path
        .relative(REPO, path.resolve(path.dirname(abs), spec))
        .split(path.sep)
        .join('/');
      edges.push({ from: rel, to });
      queue.push(to);
    }
  }

  return { reached: [...seen].sort(), edges };
}

/**
 * The shortest import chain from `entryRel` to the first module under `prefix`, or `null`.
 * Returned as a path so a failure message can say `boot.js -> main.js -> settings.js -> crypto/…`
 * instead of leaving someone to find it.
 *
 * @param {string} entryRel
 * @param {string} prefix e.g. `'src/js/crypto/'`
 * @returns {string[]|null}
 */
export function pathToPrefix(entryRel, prefix) {
  const { edges } = reachableFrom(entryRel);
  const out = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  const queue = [[entryRel]];
  const seen = new Set([entryRel]);
  while (queue.length) {
    const chain = queue.shift();
    const node = chain[chain.length - 1];
    if (node.startsWith(prefix)) return chain;
    for (const next of out.get(node) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}
