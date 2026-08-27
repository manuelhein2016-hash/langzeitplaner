// Build `latest.json`, the update manifest — story 22.6, ADR 003 §4.
//
//   node .github/scripts/make-update-manifest.mjs \
//     --version 2.0.0 --repo owner/repo --tag v2.0.0 \
//     --archive path/to/LangzeitPlaner.app.tar.gz \
//     --asset-name LangzeitPlaner-2.0.0-universal.app.tar.gz \
//     --out dist/latest.json [--min-client-version 2.0.0] [--notes "..."]
//
// WHY THIS EXISTS instead of letting the bundler emit the manifest.
//
// Story 22.6 is a security property: "a device installs authentic builds or
// nothing." A check that runs *after* a manifest is written can be skipped,
// reordered, or quietly made non-blocking. So the manifest is produced by a
// generator that has no code path to an unsigned entry: it reads the `.sig`
// file, verifies it against the public key baked into the app that was just
// built, and only then does it have a value to put in the `signature` field.
// Delete the verification and the field has nothing to hold — the failure mode
// is a crash, not a silently hijackable update channel.
//
// The manifest is written for a UNIVERSAL build: one archive, listed under
// darwin-universal (the key every client in this repo actually looks up) and,
// as harmless aliases, darwin-aarch64 and darwin-x86_64 — because Mom's Mac may
// be either (22.1) and a per-arch client would pick its key by the running arch.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyMinisign } from './minisign.mjs';

const argv = process.argv.slice(2);
const arg = (name, required = true) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || !argv[i + 1]) {
    if (required) die(`missing --${name}`);
    return null;
  }
  return argv[i + 1];
};
function die(msg) {
  console.error(`make-update-manifest: ${msg}`);
  process.exit(1);
}

const version = arg('version');
const repo = arg('repo');
const tag = arg('tag');
const archivePath = arg('archive');
const assetName = arg('asset-name');
const outPath = arg('out');
const minClientVersion = arg('min-client-version', false) || '0.0.0';
const notes = arg('notes', false) || `LangzeitPlaner ${version}`;
const pubkeyPath = arg('tauri-conf', false) || 'src-tauri/tauri.conf.json';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!SEMVER.test(version)) die(`--version "${version}" is not semver`);
if (!SEMVER.test(minClientVersion)) die(`--min-client-version "${minClientVersion}" is not semver`);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) die(`--repo "${repo}" is not owner/name`);

// ── the signature, or nothing ────────────────────────────────────────────────
const sigPath = `${archivePath}.sig`;
let sigContent;
try {
  sigContent = readFileSync(sigPath, 'utf8').trim();
} catch {
  die(
    `no signature at ${sigPath}. The build did not sign the update artifact — ` +
      'check that TAURI_SIGNING_PRIVATE_KEY was set and that bundle.createUpdaterArtifacts is true. ' +
      'Refusing to publish an unsigned update manifest (story 22.6).',
  );
}
if (!sigContent) die(`${sigPath} is empty. Refusing to publish an unsigned update manifest (story 22.6).`);

const archive = readFileSync(archivePath);
if (archive.length === 0) die(`${archivePath} is empty`);

// Normally the artifact is verified against the public key embedded in the app
// we just built. There is exactly one release where that is the wrong key: the
// KEY ROTATION release.
//
// An installed app verifies the update it downloads with the pubkey IT carries,
// not the one in the new build. So rotating from K1 to K2 takes two releases:
// release N ships pub(K2) inside the app but must still be SIGNED with K1, or
// no installed device can accept it; release N+1 is signed with K2 and every
// device is now carrying pub(K2). Only release N needs the override, and it is
// a repository variable so the guard is never edited out of the workflow.
// docs/v2/RELEASE.md § "Rotating the updater key" is the procedure.
const overridePubkey = arg('pubkey', false);
let pubkey;
if (overridePubkey) {
  pubkey = overridePubkey;
  console.log('::warning title=Verifying against an override key::--pubkey was supplied, so this artifact is being checked against a key other than the one embedded in the build. This is correct ONLY for a key-rotation release (docs/v2/RELEASE.md).');
} else {
  const conf = JSON.parse(readFileSync(pubkeyPath, 'utf8'));
  pubkey = conf?.plugins?.updater?.pubkey;
  if (!pubkey) die(`${pubkeyPath} has no plugins.updater.pubkey to verify against`);
}

const result = verifyMinisign(archive, sigContent, pubkey);
if (!result.ok) {
  die(
    `update artifact signature did NOT verify against the public key embedded in this build.\n` +
      `  reason: ${result.reason}\n` +
      `  This build would ship an app that cannot accept any update signed by the release key.\n` +
      `  See docs/v2/RELEASE.md § "The updater key".`,
  );
}
console.log(`signature verified (${result.mode} mode, key ${result.keyId}) over ${archive.length} bytes of ${assetName}`);

// Integration note (E1 review). The CI verifier accepts both minisign
// algorithms; the Swift reference shell deliberately refuses `ED` (prehashed
// BLAKE2b-512) because CryptoKit has no BLAKE2b and mis-verifying was not an
// option. Tauri's own updater handles both, so a prehashed signature does not
// break the shipping shell — but it does mean the Swift shell can never install
// this build, which is worth one loud line rather than a silent divergence.
if (result.mode === 'prehashed') {
  console.log(
    '::warning title=Prehashed updater signature::The release signer emitted a PREHASHED (ED) minisign signature. ' +
      'tauri-plugin-updater verifies it; the Swift reference shell (shell-macos/) refuses it by design. ' +
      'See docs/v2/E1-VERIFICATION.md § "Signature format".',
  );
}

// ── the manifest ─────────────────────────────────────────────────────────────
const url = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
const platform = { signature: sigContent, url };

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  // Story 22.7 / ADR 003 §4: the updater enforces the minimum client version
  // first, the server's 426 is only the backstop. LZP-104 reads this field.
  // "0.0.0" means "no gate", which is the normal case.
  //
  // Integration fix (E1 review). This used to be written as `minClientVersion`,
  // which NO client reads: src/js/platform/updater.js accepts `minimum_version`
  // or `minimumVersion` and nothing else, so 22.7's minimum-client gate would
  // have been silently dead in every shipped build. The client's spelling wins —
  // it is the one with 21 tier-1 tests behind it and the one Tauri's own manifest
  // vocabulary uses. The CLI flag keeps its name.
  minimum_version: minClientVersion,
  // Integration fix (E1 review). A universal build's updater target key is
  // `darwin-universal` — that is the string all three clients look up
  // (src/js/platform/updater.js TARGET, shell-macos/main.swift UPDATE_TARGET,
  // src-tauri/src/lib.rs UPDATE_TARGET). Publishing only the two per-arch keys
  // meant every client would have reported `unsupported-platform` and no Mac
  // would ever have updated. The per-arch aliases stay: they cost nothing, they
  // point at the same universal archive, and they keep a per-arch build honest
  // if the pipeline ever stops fusing slices.
  platforms: {
    'darwin-universal': platform,
    'darwin-aarch64': platform,
    'darwin-x86_64': platform,
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

// ── read back what we actually wrote ─────────────────────────────────────────
// Cheap, and it means the assertion is about the published bytes rather than
// about the object we intended to publish.
const written = JSON.parse(readFileSync(outPath, 'utf8'));
for (const [key, entry] of Object.entries(written.platforms)) {
  if (!entry.signature || entry.signature.length < 64) die(`platform ${key} has no usable signature in the written manifest`);
  if (!entry.url.startsWith('https://')) die(`platform ${key} url is not https`);
}
// The universal key is the one every client actually looks up. Asserting it by
// name — rather than counting keys — is what stops a future edit from shipping a
// manifest that parses, publishes, and updates nobody.
for (const required of ['darwin-universal', 'darwin-aarch64', 'darwin-x86_64']) {
  if (!written.platforms[required]) die(`manifest is missing the ${required} platform entry`);
}
if (!SEMVER.test(written.minimum_version || '')) die('manifest has no usable minimum_version');

console.log(`wrote ${outPath} (${statSync(outPath).size} bytes)`);
console.log(`  version          ${written.version}`);
console.log(`  minimum_version  ${written.minimum_version}`);
console.log(`  platforms        ${Object.keys(written.platforms).join(', ')}`);
console.log(`  url              ${url}`);
