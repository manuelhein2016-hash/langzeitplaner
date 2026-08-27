// Self-test for .github/scripts/minisign.mjs — `node .github/scripts/minisign.selftest.mjs`.
//
// Runs against synthetic minisign files built here with node:crypto, in both the
// legacy ("Ed", sign the bytes) and prehashed ("ED", sign BLAKE2b-512) forms.
//
// LIMIT, stated plainly: these vectors are constructed by this file, not
// produced by `tauri signer`. The parser and both verification paths are
// exercised for real; the assumption that Tauri emits exactly this layout is
// not, and cannot be on a machine without Rust. The first real release run is
// where that assumption is tested — see docs/v2/RELEASE.md § "Known unknowns".

import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { verifyMinisign, parsePublicKey, parseSignature, decodeContainer } from './minisign.mjs';

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

function rawEd25519(keyPair) {
  // SPKI DER for Ed25519 is a fixed 12-byte prefix + the 32-byte key.
  const der = keyPair.publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

function makeKeypair(keyIdHex) {
  const kp = generateKeyPairSync('ed25519');
  return { kp, keyId: Buffer.from(keyIdHex, 'hex'), raw: rawEd25519(kp) };
}

function pubFile({ keyId, raw }) {
  const payload = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, raw]);
  const text = `untrusted comment: minisign public key ${keyId.toString('hex').toUpperCase()}\n${payload.toString('base64')}\n`;
  return Buffer.from(text, 'utf8').toString('base64'); // Tauri's outer wrapper
}

function sigFile({ kp, keyId }, data, { prehashed }) {
  const alg = prehashed ? 'ED' : 'Ed';
  const message = prehashed ? createHash('blake2b512').update(data).digest() : data;
  const sig = edSign(null, message, kp.privateKey);
  const payload = Buffer.concat([Buffer.from(alg, 'latin1'), keyId, sig]);
  const trusted = 'timestamp:1756000000\tfile:LangzeitPlaner.app.tar.gz';
  const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), kp.privateKey);
  const text =
    `untrusted comment: signature from langzeitplaner updater key\n` +
    `${payload.toString('base64')}\n` +
    `trusted comment: ${trusted}\n` +
    `${global.toString('base64')}\n`;
  return Buffer.from(text, 'utf8').toString('base64');
}

const data = Buffer.from('a pretend LangzeitPlaner.app.tar.gz, 8 KiB of it'.repeat(170), 'utf8');
const A = makeKeypair('0011223344556677');
const B = makeKeypair('8899aabbccddeeff');

// --- parsing ---------------------------------------------------------------
ok('public key parses', parsePublicKey(pubFile(A)).keyId === '0011223344556677');
ok('public key alg is Ed', parsePublicKey(pubFile(A)).alg === 'Ed');
ok('signature parses', parseSignature(sigFile(A, data, { prehashed: false })).keyId === '0011223344556677');
ok(
  'plain minisign text needs no unwrapping',
  decodeContainer(Buffer.from(pubFile(A), 'base64').toString('utf8')).startsWith('untrusted comment:'),
);

// --- verification ----------------------------------------------------------
const legacy = verifyMinisign(data, sigFile(A, data, { prehashed: false }), pubFile(A));
ok('legacy "Ed" signature verifies', legacy.ok, JSON.stringify(legacy));
ok('legacy reports its mode', legacy.mode === 'legacy');

const pre = verifyMinisign(data, sigFile(A, data, { prehashed: true }), pubFile(A));
ok('prehashed "ED" signature verifies', pre.ok, JSON.stringify(pre));
ok('prehashed reports its mode', pre.mode === 'prehashed');

// --- the failures that matter ---------------------------------------------
const wrongKey = verifyMinisign(data, sigFile(B, data, { prehashed: false }), pubFile(A));
ok('a signature from another key is rejected', !wrongKey.ok);
ok('and the reason names both key ids', /8899AABBCCDDEEFF/.test(wrongKey.reason || ''), wrongKey.reason);

// Same key id, different key material: the impersonation case the id check alone would miss.
const impostor = { kp: generateKeyPairSync('ed25519'), keyId: A.keyId };
impostor.raw = rawEd25519(impostor.kp);
const forged = verifyMinisign(data, sigFile(impostor, data, { prehashed: false }), pubFile(A));
ok('a forgery under a copied key id is rejected', !forged.ok, JSON.stringify(forged));

const tampered = verifyMinisign(Buffer.concat([data, Buffer.from('!')]), sigFile(A, data, { prehashed: false }), pubFile(A));
ok('a modified artifact is rejected', !tampered.ok);

let threw = false;
try {
  parseSignature('');
} catch {
  threw = true;
}
ok('an empty signature file throws rather than passing', threw);

let threwShort = false;
try {
  parsePublicKey(Buffer.from('untrusted comment: x\nAAAA\n', 'utf8').toString('base64'));
} catch {
  threwShort = true;
}
ok('a truncated public key throws', threwShort);

console.log(failures === 0 ? '\nminisign self-test: all green' : `\nminisign self-test: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
