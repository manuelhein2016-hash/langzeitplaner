#!/usr/bin/env node
// LZP-108 — the invitation exists four times over (de/en x txt/html). Copy that lives
// in four files diverges in four directions, and the sentence most likely to be lost
// is the one that costs the most: the warning about the Gatekeeper wall. Under D1 that
// sentence is the entire reason an unsigned build is installable by a non-technical
// person, so it gets a test rather than a good intention.
//
// Also enforced: the e-mail carries no remote resource. A family invitation with a
// tracking pixel in it would be a betrayal of the same promise the product makes on
// its own settings screen, and it is exactly the kind of thing a "nice HTML template"
// smuggles in.
//
// Run: node .github/scripts/check-email-copy.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'docs/v2/email';
const problems = [];
const fail = (m) => problems.push(m);

const FILES = ['invitation.de.txt', 'invitation.en.txt', 'invitation.de.html', 'invitation.en.html'];
const PLACEHOLDERS = ['{{NAME}}', '{{RELEASE_URL}}', '{{EINLADUNGSCODE}}', '{{ABSENDER}}'];

// Every required idea, and the words that prove it survived translation and reformatting.
// Keyed on lowercased, tag-stripped text so markup changes never break the check.
const REQUIRED = {
  de: [
    ['the Gatekeeper warning is announced BEFORE she double-clicks (D1, story 22.2)',
     ['schadsoftware', 'keine fehlermeldung']],
    ['the unlock route is spelled out, all three stops, in macOS\'s own German words',
     // "Dennoch öffnen", not "Trotzdem öffnen": Apple's wording, and the same string
     // LZP-106's screen uses (src/js/i18n.js `unlockUiOpenAnyway`). If the e-mail and
     // the in-app screen name different buttons, one of them sends her hunting.
     ['systemeinstellungen', 'datenschutz', 'dennoch öffnen']],
    ['it warns her off the Trash button in the first dialog',
     ['papierkorb']],
    ['it says the warning does not come back',
     ['nie wieder']],
    ['the drop target is named in German (story 22.1)', ['programme']],
    ['the GitHub Releases fallback for providers that strip .dmg (story 22.1)',
     ['mail-anbieter', '.dmg']],
    ['joining is instant but content is not (D9)',
     ['noch nicht da', 'von allein']],
    ['and D9 resolves without chasing anybody',
     ['niemanden erinnern']],
    ['solo mode stays a real option (story 15.1)', ['ohne internet']],
  ],
  en: [
    ['the Gatekeeper warning is announced BEFORE she double-clicks (D1, story 22.2)',
     // macOS's own words, matching src/js/i18n.js `unlockUiAlert1/2` (LZP-106).
     ['free of malware', 'not an error message']],
    ['the unlock route is spelled out, all three stops',
     ['system settings', 'privacy', 'open anyway']],
    ['it warns her off the Trash button in the first dialog',
     ['move to trash']],
    ['it says the warning does not come back', ['never comes back']],
    ['the drop target names the German folder too (story 22.1)', ['programme']],
    ['the GitHub Releases fallback for providers that strip .dmg (story 22.1)',
     ['mail providers', '.dmg']],
    ['joining is instant but content is not (D9)',
     ["won't be there", 'on their own']],
    ['and D9 resolves without chasing anybody', ['remind anyone']],
    ['solo mode stays a real option (story 15.1)', ['no internet']],
  ],
};

// Phrasings that would break the D9 promise by making Mum responsible for someone
// else's laptop. DESIGN-DECISIONS.md § D9: "it must never tell Mom to 'ask Dad to open
// his laptop' as a requirement — it resolves itself."
const FORBIDDEN = [
  [/bitte\s+(deinen|den)\s+\w+[^.]*(laptop|mac|rechner)/i, 'asks the reader to get someone else to open a machine'],
  [/frag\s+(mal\s+)?(bitte\s+)?(papa|dad|vater)/i, 'tells the reader to go ask somebody'],
  [/ask\s+(your\s+)?(dad|father|him|her)\s+to\s+(open|start|turn)/i, 'tells the reader to go ask somebody'],
  [/sobald.{0,40}\b(eingeschaltet|angemacht)\b/i, 'makes the wait conditional on someone acting'],
];

// Typographic apostrophes and quotes are normalised away: the plain-text version uses
// ' and " because some mail clients still mangle U+2019, the HTML uses the real ones,
// and the copy is identical either way.
const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
  .replace(/\s+/g, ' ');

for (const f of FILES) {
  const path = join(ROOT, DIR, f);
  if (!existsSync(path)) { fail(`${DIR}/${f} is missing.`); continue; }
  const raw = readFileSync(path, 'utf8');
  const text = strip(raw).toLowerCase();
  const lang = f.includes('.de.') ? 'de' : 'en';

  for (const p of PLACEHOLDERS) {
    if (!raw.includes(p)) {
      fail(`${f}: no ${p}. Either the slot was filled in with a real value and committed `
         + '(never commit a real invite code — 15.5 makes them single-use and they leak), '
         + 'or the section was dropped.');
    }
  }
  for (const [what, needles] of REQUIRED[lang]) {
    const missing = needles.filter((n) => !text.includes(n));
    if (missing.length) fail(`${f}: ${what} — missing ${missing.map((m) => JSON.stringify(m)).join(', ')}.`);
  }
  for (const [re, why] of FORBIDDEN) {
    if (re.test(text)) fail(`${f}: ${why}. D9 requires the waiting state to resolve itself.`);
  }

  if (f.endsWith('.html')) {
    const body = raw.replace(/<!--[\s\S]*?-->/g, '');
    if (/<script/i.test(body)) fail(`${f}: contains a <script>. Mail clients strip it and it has no business in an e-mail.`);
    const remote = [...body.matchAll(/(?:src|background)\s*=\s*"([^"]+)"/gi)]
      .map((m) => m[1]).filter((u) => /^(https?:)?\/\//i.test(u));
    if (remote.length) {
      fail(`${f}: loads ${remote.join(', ')} from the network. One remote image in an e-mail `
         + 'is a read receipt: it tells a server when it was opened and from which IP. '
         + 'Reference the image by bare filename and let the mail client attach it.');
    }
    if (/@import|fonts\.googleapis|\.woff/i.test(body)) fail(`${f}: pulls in a web font.`);
    const imgs = [...body.matchAll(/<img\b[^>]*>/gi)];
    if (imgs.length !== 1) fail(`${f}: has ${imgs.length} <img> tags, expected exactly 1 (story 22.1: three steps, ONE screenshot).`);
    else if (!/\balt\s*=\s*"[^"]{40,}"/i.test(imgs[0][0])) {
      fail(`${f}: the screenshot has no substantial alt text. Many clients block images by `
         + 'default, and the alt text is then the whole of step 1.');
    }
  }
}

// The subject line has to exist and has to be somewhere findable.
for (const [f, marker] of [['invitation.de.txt', /^Betreff: .+/m], ['invitation.en.txt', /^Subject: .+/m],
                           ['invitation.de.html', /Subject: .+/], ['invitation.en.html', /Subject: .+/]]) {
  const path = join(ROOT, DIR, f);
  if (existsSync(path) && !marker.test(readFileSync(path, 'utf8'))) {
    fail(`${f}: no subject line. An e-mail without one gets sent with an empty subject at 11pm.`);
  }
}

if (problems.length) {
  console.error('Invitation e-mail check FAILED\n');
  for (const p of problems) console.error('  ✗ ' + p + '\n');
  process.exit(1);
}
console.log(`Invitation e-mail OK — ${FILES.length} files, both languages, every required promise present, no remote resources.`);
