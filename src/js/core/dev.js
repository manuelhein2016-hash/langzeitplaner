// src/js/core/dev.js — the DEV / shadow-assert flag.  ADR 001 §7.1, ADR 005 §1.1.
//
// There is NO build step in this project: the app is served as raw ES modules by
// dev-server.mjs and by the Swift WKURLSchemeHandler. So `DEV` cannot be a compile-time
// define. It is a module constant, read ONCE at import time from a global that tests and
// dev-server.mjs set — never the shell, never an env var (core/ may not read process.env).
//
// Read once on purpose: a flag that can flip mid-run gives you a store whose txn() captured
// no shadow pre-image and an undo() that then demands one. Set it before the first import.

/**
 * True when the shadow-undo assertion and the other DEV-only invariant checks are armed.
 * @type {boolean}
 */
export const DEV = !!globalThis.__LZP_DEV;
