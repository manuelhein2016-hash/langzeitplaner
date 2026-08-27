// Minisign parsing + Ed25519 verification, zero dependencies.
//
// Tauri's updater signs release artifacts with minisign (Ed25519). This module
// is the *independent* reader of that format: the release workflow uses it to
// prove, before anything is published, that
//
//   1. every update artifact carries a real signature, and
//   2. that signature was made by the key whose public half is baked into the
//      app we just built (`plugins.updater.pubkey` in tauri.conf.json).
//
// (2) is the one that matters. A build signed with the wrong key produces an
// app that will reject every future update it is ever offered — a fleet that
// can never be reached again, discovered months later. The key-id comparison
// below turns that into a failed CI job instead.
//
// Format reference (minisign):
//   public key file    untrusted comment: ...
//                      base64( alg[2] | keyId[8] | pk[32] )                = 42 bytes
//   signature file     untrusted comment: ...
//                      base64( alg[2] | keyId[8] | sig[64] )               = 74 bytes
//                      trusted comment: ...
//                      base64( globalSig[64] )   over ( sig | trustedComment )
//
//   alg "Ed" (0x45,0x64) -> signature is over the raw file bytes
//   alg "ED" (0x45,0x44) -> signature is over BLAKE2b-512(file bytes)
//
// Tauri stores both the public key (in tauri.conf.json) and each `.sig` file's
// contents base64-encoded *once more*, so `decodeContainer` peels that layer
// when it is present and passes plain minisign text through untouched.

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Peel Tauri's outer base64 wrapper if there is one. @returns {string} minisign file text */
export function decodeContainer(raw) {
  const text = String(raw).trim();
  if (text.startsWith('untrusted comment:')) return text;
  let decoded;
  try {
    decoded = Buffer.from(text, 'base64').toString('utf8');
  } catch {
    throw new Error('not base64 and not minisign text');
  }
  if (!decoded.trimStart().startsWith('untrusted comment:')) {
    throw new Error('does not decode to a minisign file (no "untrusted comment:" line)');
  }
  return decoded.trim();
}

function b64(line) {
  const buf = Buffer.from(line.trim(), 'base64');
  if (buf.length === 0) throw new Error('empty base64 payload');
  return buf;
}

/** @returns {{alg: string, keyId: string, key: Buffer}} */
export function parsePublicKey(raw) {
  const lines = decodeContainer(raw).split(/\r?\n/).filter((l) => l.trim() !== '');
  const payloadLine = lines.find((l) => !l.startsWith('untrusted comment:'));
  if (!payloadLine) throw new Error('public key has no payload line');
  const buf = b64(payloadLine);
  if (buf.length !== 42) throw new Error(`public key payload is ${buf.length} bytes, expected 42`);
  return {
    alg: buf.subarray(0, 2).toString('latin1'),
    keyId: buf.subarray(2, 10).toString('hex').toUpperCase(),
    key: buf.subarray(10, 42),
  };
}

/** @returns {{alg: string, keyId: string, sig: Buffer, trustedComment: string, globalSig: Buffer|null}} */
export function parseSignature(raw) {
  const lines = decodeContainer(raw).split(/\r?\n/);
  const payloadLine = lines.find((l) => l.trim() !== '' && !l.startsWith('untrusted comment:'));
  if (!payloadLine) throw new Error('signature has no payload line');
  const buf = b64(payloadLine);
  if (buf.length !== 74) throw new Error(`signature payload is ${buf.length} bytes, expected 74`);

  const tcLine = lines.find((l) => l.startsWith('trusted comment:'));
  const trustedComment = tcLine ? tcLine.slice('trusted comment:'.length).trim() : '';
  const tcIndex = tcLine ? lines.indexOf(tcLine) : -1;
  const globalLine = tcIndex >= 0 ? lines.slice(tcIndex + 1).find((l) => l.trim() !== '') : undefined;

  return {
    alg: buf.subarray(0, 2).toString('latin1'),
    keyId: buf.subarray(2, 10).toString('hex').toUpperCase(),
    sig: buf.subarray(10, 74),
    trustedComment,
    globalSig: globalLine ? b64(globalLine) : null,
  };
}

function keyObject(rawKey) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey]),
    format: 'der',
    type: 'spki',
  });
}

function ed25519(message, sig, rawKey) {
  return edVerify(null, message, keyObject(rawKey), sig);
}

/**
 * Verify `data` against a minisign signature and public key.
 *
 * The algorithm bytes say which form to use, but both are attempted before a
 * failure is reported: a CI gate that blocks every release because minisign
 * changed its default prehash mode would be worse than the risk it guards.
 * A forged signature still fails both.
 *
 * @returns {{ok: boolean, mode: string|null, keyId: string, reason?: string}}
 */
export function verifyMinisign(data, sigRaw, pubRaw) {
  const pub = parsePublicKey(pubRaw);
  const sig = parseSignature(sigRaw);

  if (sig.keyId !== pub.keyId) {
    return {
      ok: false,
      mode: null,
      keyId: sig.keyId,
      reason:
        `signed by key ${sig.keyId} but the app embeds key ${pub.keyId}. ` +
        'An app built this way would reject every update it is ever offered.',
    };
  }

  const prehashedFirst = sig.alg === 'ED';
  const attempts = prehashedFirst ? ['prehashed', 'legacy'] : ['legacy', 'prehashed'];

  for (const mode of attempts) {
    const message = mode === 'prehashed' ? createHash('blake2b512').update(data).digest() : data;
    if (!ed25519(message, sig.sig, pub.key)) continue;

    // The trusted comment is signed too; a mismatch means the file was edited.
    if (sig.globalSig) {
      const globalMessage = Buffer.concat([sig.sig, Buffer.from(sig.trustedComment, 'utf8')]);
      if (!ed25519(globalMessage, sig.globalSig, pub.key)) {
        return { ok: false, mode, keyId: sig.keyId, reason: 'trusted comment signature does not verify' };
      }
    }
    return { ok: true, mode, keyId: sig.keyId };
  }

  return { ok: false, mode: null, keyId: sig.keyId, reason: 'signature does not verify in either mode' };
}
