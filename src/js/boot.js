// The page's entry point, and nothing else.
//
// ADR 005 §1.5 asked for `main.js`'s boot IIFE to become `export function boot()`, so that
// importing `main.js` no longer starts the app as a side effect of the module graph being
// evaluated. Something still has to start it, and it cannot be an inline `<script>`: index.html
// ships `Content-Security-Policy: default-src 'self'` with no `unsafe-inline`, so an inline module
// is refused outright by WKWebView and by every browser. This file is that one line, as a real
// same-origin module.
import { boot } from './main.js';

boot();
