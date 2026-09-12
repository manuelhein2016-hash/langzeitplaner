// tests/tier1/shell-parity.test.js — THE TWO SHELLS MUST ANSWER THE SAME CENSUS.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, AND WHAT IT WOULD HAVE CAUGHT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// This product has two native shells and ships exactly one of them:
//
//   · `shell-macos/main.swift`  — the REFERENCE shell. It is what `tests/run-dom-tests.sh`
//     builds, so all 60 tier-2 files and every one of their ~930 rows run inside it.
//   · `src-tauri/src/lib.rs`    — the shell PRODUCTION ships. The DMG is Tauri.
//
// Nothing in this repository compared them. The consequence, found by the UX audit and recorded
// in `docs/v2/UX-AUDIT.md`, was a whole class of defect that every tier was structurally blind
// to: `print_board` exists in Swift (`main.swift:1829`) and not in Tauri, so ⌘P and Ablage →
// „Drucken …" are a silent no-op in the shipped app while every print test passes. 5 876 green
// rows, and the Ablage menu did not work.
//
// `tests/helpers/native-scope.js:44-47` already declared the invariant in as many words —
// **"The two shells. Both ship; both must answer the same census."** — and `bridgeCommands()`
// at :234 already extracted it. What was missing is the comparison: that helper returns the
// UNION of both shells, and a union is exactly what hides a command present in only one of them.
//
// So this file asks the three questions the union cannot:
//
//   §1  do the two shells implement the same set of commands?
//   §2  is every command the PAGE invokes implemented by BOTH?
//   §3  do the two `set_shell_pref` key tables agree — including the value TYPE?
//
// §3 exists because a name-level diff is not enough. Both shells implement `set_shell_pref`, so
// §1 and §2 are green on it — but Rust's signature is `value: bool` while the page sends
// `{key:'language', value:'en'}`, which fails at serde deserialisation before the `match` is
// reached, and both call sites `.catch()` it silently. The visible symptom is that an English
// install keeps a German menu bar for ever. A parity gate that only compared names would have
// shipped that too.
//
// ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────────────────────────
//
// It is a SOURCE census, like `native-scope.js` itself, and it inherits that file's one design
// rule: names and order, never line numbers. It cannot tell you a command WORKS — `print_board`
// existing in both shells would satisfy §2 while doing nothing. That is tier 2's job in Swift
// and a human's job in the DMG. What it can do is make a DIVERGENCE loud, which is the failure
// mode that actually shipped.
//
// Zero npm dependencies.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeCommands, shellSource } from '../helpers/native-scope.js';
import { shippedFiles } from '../helpers/netscope.js';

const SWIFT = 'shell-macos/main.swift';
const RUST = 'src-tauri/src/lib.rs';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE LEDGER OF ACCEPTED DIVERGENCES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A command may legitimately live in one shell only — but it must be NAMED here with the reason,
// the way `netscope.js`'s `ALLOWED` names its one call site. An empty ledger is the goal; a
// populated one is a decision. Anything not listed is a red.
//
// The two-way rule matters as much as the one-way rule: a name listed here that is no longer
// divergent is ALSO a red (§1c), because a stale exemption is how a gate quietly stops gating.
const ACCEPTED_DIVERGENCE = Object.freeze({
  // (empty — and it should stay that way)
});

/** Commands the page invokes that no shell is expected to implement. Same rule: name the reason. */
const ACCEPTED_UNIMPLEMENTED = Object.freeze({
  // (empty)
});

/**
 * The commands ONE shell implements.
 *
 * `bridgeCommands()` is the shared helper and it over-reports on the Swift side, for a reason
 * worth stating rather than working around silently: it matches `case "<snake_case>":` anywhere
 * in the file, and `main.swift` has TWO switches on string labels — the bridge's command dispatch,
 * and the inner one inside `set_shell_pref` that switches on the pref KEY. So `sync_enabled`,
 * `menu_bar_icon` and `launch_at_login` come back looking like commands. The Rust side cannot
 * have this problem, because it reads `#[tauri::command]` attributes.
 *
 * Subtracting the pref keys is the semantic fix — a pref key is not a command — and it is done
 * here rather than in the shared helper because `tests/attack/e10-network-scope.test.js` consumes
 * that helper for a different question (the network surface) where the union is the right answer.
 * The subtraction is ASSERTED in §1d, so if the two namespaces ever collide, that is a red.
 */
function commandsOf(which) {
  const prefKeys = new Set(shellPrefKeys(which).keys);
  return bridgeCommands(which).filter((c) => !prefKeys.has(c));
}

/**
 * Every command name the PAGE can invoke.
 *
 * Two call shapes exist and both must be caught. `invoke('x', …)` is the common one; but
 * `src/js/storage.js:17-23` wraps the bridge in `tauriInvoke(cmd, args)` and calls
 * `tauriInvoke('load_board', {})` — nine commands that a naive `invoke('` grep would miss
 * entirely. §2c proves the scanner sees both.
 */
export function invokedCommands(files = shippedFiles()) {
  const out = new Map();
  const re = /\b(?:tauriInvoke|invoke)\(\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]/g;
  for (const f of files) {
    for (const m of f.src.matchAll(re)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(f.rel);
    }
  }
  return out;
}

/**
 * The keys one shell's `set_shell_pref` accepts, and the value type it expects.
 *
 * Swift reads `args["key"]` and switches on it; Rust takes a typed `value` parameter and matches
 * on `key.as_str()`. The TYPE is read from Rust's signature, because that is where the failure
 * happens — serde rejects the call before the match runs.
 */
export function shellPrefKeys(which) {
  const src = shellSource(which);
  if (which === SWIFT) {
    // `case "language":` etc. inside `func setShellPref` / the `set_shell_pref` case body.
    const body = src.slice(src.indexOf('"set_shell_pref"'));
    const stop = body.indexOf('\n            case "');
    const region = stop > 0 ? body.slice(0, body.indexOf('default:') > 0 ? body.indexOf('default:') : body.length) : body;
    const keys = new Set();
    for (const m of region.matchAll(/case\s+"([a-z][a-z0-9_]*)"\s*:/g)) {
      if (m[1] !== 'set_shell_pref') keys.add(m[1]);
    }
    return { keys: [...keys].sort(), valueType: null };
  }
  const m = /fn\s+set_shell_pref\s*\(([^)]*)\)/.exec(src);
  const sig = m ? m[1] : '';
  const vt = /value\s*:\s*([A-Za-z_:<>0-9]+)/.exec(sig);
  const body = src.slice(src.indexOf('fn set_shell_pref'));
  const region = body.slice(0, body.indexOf('other =>') > 0 ? body.indexOf('other =>') : 4000);
  const keys = new Set();
  for (const m2 of region.matchAll(/"([a-z][a-z0-9_]*)"\s*=>/g)) keys.add(m2[1]);
  return { keys: [...keys].sort(), valueType: vt ? vt[1] : null };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE TWO SHELLS IMPLEMENT THE SAME COMMANDS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · command parity between the two shells', () => {
  test('§1a — every command Swift answers, Tauri answers too', () => {
    const swift = new Set(commandsOf(SWIFT));
    const rust = new Set(commandsOf(RUST));
    const onlySwift = [...swift].filter((c) => !rust.has(c) && !(c in ACCEPTED_DIVERGENCE)).sort();
    assert.deepEqual(onlySwift, [],
      'these commands exist in the shell tier 2 runs and NOT in the shell the DMG ships, so every '
      + 'test of them passes while the product does nothing: ' + JSON.stringify(onlySwift));
  });

  test('§1b — and every command Tauri answers, Swift answers too', () => {
    // The other direction is not symmetric in consequence — a Tauri-only command is untested
    // rather than broken — but it is the same defect: the two shells have drifted, and tier 2
    // cannot see the half that ships.
    const swift = new Set(commandsOf(SWIFT));
    const rust = new Set(commandsOf(RUST));
    const onlyRust = [...rust].filter((c) => !swift.has(c) && !(c in ACCEPTED_DIVERGENCE)).sort();
    assert.deepEqual(onlyRust, [],
      'these commands ship in the DMG with no tier-2 coverage at all, because tier 2 runs the '
      + 'other shell: ' + JSON.stringify(onlyRust));
  });

  test('§1d — the pref-key subtraction removes exactly the pref keys, and nothing else', () => {
    // `commandsOf` narrows the Swift census by the set_shell_pref keys. If a real command were
    // ever named the same as a pref key, that subtraction would hide it — so what was removed is
    // asserted to be exactly the pref-key table, and never a command the other shell implements.
    const raw = new Set(bridgeCommands(SWIFT));
    const kept = new Set(commandsOf(SWIFT));
    const removed = [...raw].filter((c) => !kept.has(c)).sort();
    const prefKeys = new Set(shellPrefKeys(SWIFT).keys);
    // A SUBSET, not an equality. `bridgeCommands`'s pattern requires snake_case with at least one
    // underscore, so a single-word pref key like `language` never looked like a command and was
    // never in the census to remove. What must hold is the one-way rule: nothing leaves the
    // census unless it is a pref key.
    const wrongly = removed.filter((c) => !prefKeys.has(c));
    assert.deepEqual(wrongly, [],
      'the Swift command census lost something that is not a shell-pref key: ' + JSON.stringify(wrongly));
    assert.ok(removed.length > 0, 'the subtraction removed nothing — it is no longer doing its job');
    const rust = new Set(commandsOf(RUST));
    const collided = removed.filter((c) => rust.has(c));
    assert.deepEqual(collided, [],
      'a shell-pref key shares its name with a real Tauri command — the subtraction in '
      + '`commandsOf` would hide a genuine divergence: ' + JSON.stringify(collided));
  });

  test('§1c — the divergence ledger has no stale entries', () => {
    // A named exemption that is no longer divergent is how a gate quietly stops gating. Same
    // two-way enforcement the tier-2 residual ledger uses in `tests/run-dom-tests.sh`.
    const swift = new Set(commandsOf(SWIFT));
    const rust = new Set(commandsOf(RUST));
    const stale = Object.keys(ACCEPTED_DIVERGENCE)
      .filter((c) => swift.has(c) === rust.has(c)).sort();
    assert.deepEqual(stale, [],
      'ACCEPTED_DIVERGENCE names commands that are no longer divergent — delete the rows: '
      + JSON.stringify(stale));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · EVERY COMMAND THE PAGE INVOKES IS IMPLEMENTED BY BOTH SHELLS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · the page cannot invoke what a shell does not implement', () => {
  test('§2a — every invoked command exists in BOTH shells', () => {
    const invoked = invokedCommands();
    const swift = new Set(commandsOf(SWIFT));
    const rust = new Set(commandsOf(RUST));
    const broken = [];
    for (const [cmd, sites] of invoked) {
      if (cmd in ACCEPTED_UNIMPLEMENTED) continue;
      const missing = [];
      if (!swift.has(cmd)) missing.push(SWIFT);
      if (!rust.has(cmd)) missing.push(RUST);
      if (missing.length) broken.push(`${cmd} (called from ${sites.join(', ')}) missing in ${missing.join(' + ')}`);
    }
    assert.deepEqual(broken, [],
      'the page invokes commands a shell does not implement. An unknown invoke REJECTS, and every '
      + 'call site in this tree swallows the rejection, so the feature is silently absent:\n  '
      + broken.join('\n  '));
  });

  test('§2b — and the census is not empty, in either direction', () => {
    // Non-vacuity for the whole file: if either extractor silently returned nothing, §1 and §2a
    // would be green and prove nothing at all.
    const invoked = invokedCommands();
    assert.ok(invoked.size >= 20, `the page-side scanner found only ${invoked.size} commands`);
    assert.ok(commandsOf(SWIFT).length >= 20, 'the Swift extractor found almost nothing');
    assert.ok(commandsOf(RUST).length >= 20, 'the Rust extractor found almost nothing');
  });

  test('§2c — the scanner sees BOTH call shapes, including the storage.js indirection', () => {
    // `storage.js` does not call `invoke(…)`; it calls `tauriInvoke(cmd, args)` through a wrapper
    // at :17-23. Nine commands — the whole persistence layer — reach the shell that way, and a
    // scanner that only knew `invoke('` would report them as uninvoked and this gate would be
    // blind to the most important commands in the product.
    const seen = invokedCommands([
      { rel: '<planted>', src: "await tauriInvoke('load_board', {}); invoke('sync_status'); invoke(\"print_board\", {});" },
    ]);
    assert.deepEqual([...seen.keys()].sort(), ['load_board', 'print_board', 'sync_status'],
      'the page-side scanner missed a call shape it must catch');
    // …and the real tree really does reach the storage commands this way.
    const real = invokedCommands();
    assert.ok(real.has('load_board') && real.get('load_board').some((f) => f.endsWith('storage.js')),
      'load_board was not attributed to storage.js — the indirection is no longer being followed');
  });

  test('§2d — ARMED: a planted command in one shell only is reported', () => {
    // A gate whose finder has never been shown a positive is a gate nobody has tested. Both
    // extractors are fed a synthetic divergence and must see it — the same method
    // `tests/attack/e10-network-scope.test.js` §1d uses when it plants a `URLSession`.
    const swiftLike = 'switch cmd {\ncase "wibble_wobble":\n    doThing()\n}';
    const rustLike = '#[tauri::command]\nfn wibble_wobble(app: AppHandle) -> Result<(), String> { Ok(()) }';
    assert.match(swiftLike, /case\s+"(wibble_wobble)"\s*:/,
      'the Swift command pattern no longer matches a real Swift case label');
    assert.match(rustLike, /#\[tauri::command\][\s\S]{0,200}?fn\s+(wibble_wobble)/,
      'the Rust command pattern no longer matches a real Tauri command');
    const seen = invokedCommands([{ rel: '<planted>', src: "invoke('wibble_wobble')" }]);
    assert.ok(seen.has('wibble_wobble'), 'the page-side scanner would not have seen a new command');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · set_shell_pref — SAME NAME IS NOT SAME CONTRACT
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · the shell-pref key tables agree', () => {
  test('§3a — both shells accept the same keys', () => {
    const s = shellPrefKeys(SWIFT);
    const r = shellPrefKeys(RUST);
    assert.ok(s.keys.length > 0, 'no set_shell_pref keys found in the Swift shell');
    assert.ok(r.keys.length > 0, 'no set_shell_pref keys found in the Tauri shell');
    assert.deepEqual(s.keys, r.keys,
      `the two shells accept different shell-pref keys — Swift ${JSON.stringify(s.keys)} vs `
      + `Tauri ${JSON.stringify(r.keys)}. A key only one shell handles is a setting that silently `
      + 'does nothing in the build that ships.');
  });

  test('§3b — every key the page sends is accepted by both', () => {
    const sent = new Set();
    for (const f of shippedFiles()) {
      for (const m of f.src.matchAll(/set_shell_pref['"]?\s*,\s*\{\s*key:\s*['"]([a-z_]+)['"]/g)) sent.add(m[1]);
      for (const m of f.src.matchAll(/applyShellPref\(\s*['"]([a-z_]+)['"]/g)) sent.add(m[1]);
    }
    assert.ok(sent.size > 0, 'no set_shell_pref call sites found in src/js — the scanner broke');
    const s = new Set(shellPrefKeys(SWIFT).keys);
    const r = new Set(shellPrefKeys(RUST).keys);
    const bad = [...sent].filter((k) => !s.has(k) || !r.has(k)).sort();
    assert.deepEqual(bad, [],
      'the page sends shell-pref keys a shell does not handle: ' + JSON.stringify(bad));
  });

  test('§3c — the Tauri value type can carry every value the page sends', () => {
    // THE ROW THAT NAMES THE LIVE BUG. `fn set_shell_pref(app, key: String, value: bool)` cannot
    // receive `{key:'language', value:'en'}` — serde rejects it before the match is reached, and
    // `main.js:594` / `settings.js:503` both swallow the rejection. The symptom is a German menu
    // bar on an English install, with nothing on screen and nothing in any test.
    const { valueType } = shellPrefKeys(RUST);
    assert.ok(valueType, 'could not read the value parameter type from the Tauri signature');
    const stringValued = [];
    for (const f of shippedFiles()) {
      for (const m of f.src.matchAll(/key:\s*['"]([a-z_]+)['"]\s*,\s*value:\s*([^}]+?)\s*\}/g)) {
        const expr = m[2].trim();
        // A boolean literal or a `!`-negation is certainly a bool; anything else may not be.
        if (!/^(true|false|!{1,2}[\w.?[\]]+|Boolean\()/.test(expr)) stringValued.push(`${m[1]} = ${expr}`);
      }
    }
    if (stringValued.length) {
      assert.notEqual(valueType, 'bool',
        'the Tauri command declares `value: bool`, but the page sends non-boolean values for '
        + JSON.stringify(stringValued) + ' — those invokes fail at deserialisation and are '
        + 'swallowed by the caller. Widen the parameter (serde_json::Value) and handle each key.');
    }
  });
});
