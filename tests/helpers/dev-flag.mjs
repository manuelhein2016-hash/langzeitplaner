// tests/helpers/dev-flag.mjs — arms the DEV flag for the whole test process.
//
// `src/js/core/dev.js` reads `globalThis.__LZP_DEV` ONCE, at import time, on purpose: a flag that
// can flip mid-run gives you a store whose txn() captured no shadow pre-image and an undo() that
// then demands one. So the flag has to be set before the first import of any core module, which
// no test file can do for another test file — an `import` in one file runs after that file's own
// imports have been hoisted and evaluated.
//
// `node --test --import ./tests/helpers/dev-flag.mjs` is the only seam that reaches EVERY file in
// a run, which is why it lives in the npm scripts rather than in tests/helpers/env.js. env.js is
// the v1 suite's DOM shim and is imported by 14 of the test files; the op-log suites
// (core-oplog, core-registers, core-authz, core-ops, core-primitives, tests/property/*,
// tests/attack/convergence-*) do not import it at all, so putting the flag there would arm it for
// two thirds of the suite and silently leave the rest inert.
//
// WHY IT IS ARMED AT ALL — PLAN.md's risk R5: "the shadow-undo assertion turns 'did we cover
// every mutation?' into a test failure", and WP-3's exit criterion is "WP-2 stays green WITH THE
// SHADOW-UNDO ASSERTION ON". A guard that is off during the very suite it exists to protect is
// not a guard, which is what attack ATT-96 found. It stays off in the shipping app: `DEV` is
// false unless something sets this global, and nothing in src/ ever does.
globalThis.__LZP_DEV = true;
