#!/bin/bash
# LZP-102 / 22.6 — the updater's Swift-side evidence run.
#
# Tier 1 (`npm test`) covers every decision the updater makes; tier 2 drives the
# board in real WebKit. Neither can prove the two things that exist only in
# Swift: that an update whose signature does not verify installs NOTHING, and
# that one which does verify really swaps a bundle. This script does.
#
#   ./shell-macos/updater-selftest.sh
#
# It builds shell-macos/ into a throwaway .app, generates a cross-implementation
# signature vector with node:crypto (so the format check is not CryptoKit
# marking its own homework), and runs `LangzeitPlaner --updater-selftest <dir>`,
# which prints TAP and exits non-zero on any failure.
#
# It is deliberately NOT part of tests/run-dom-tests.sh: that runner launches the
# app once per tests/tier2/*.dom.js file with no extra flags, and this mode needs
# its own. Zero npm dependencies — bash, swiftc, node.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lzp-updater.XXXXXX")"
APP="$WORK/LangzeitPlaner.app/Contents/MacOS/LangzeitPlaner"
SCRATCH="$WORK/selftest"
REAL_BOARD="$HOME/Library/Application Support/LangzeitPlaner"

cleanup() {
  if [[ -n "${KEEP_BUILD:-}" ]]; then echo "# build kept at $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# Same isolation guard as the tier-2 runner: prove afterwards that the user's
# real board directory was never touched.
fingerprint() {
  if [[ -d "$REAL_BOARD" ]]; then
    ( cd "$REAL_BOARD" && find . -type f -exec shasum {} \; 2>/dev/null | sort )
  else
    echo "absent"
  fi
}
BEFORE="$(fingerprint)"

mkdir -p "$SCRATCH"

echo "# building shell-macos → $WORK"
if ! "$REPO/shell-macos/build.sh" --dest "$WORK" >"$WORK/build.log" 2>&1; then
  echo "Bail out! build failed:"
  sed 's/^/#   /' "$WORK/build.log"
  exit 2
fi
[[ -x "$APP" ]] || { echo "Bail out! no executable at $APP"; exit 2; }

# ── cross-implementation vector ──────────────────────────────────────────────
# Node signs, CryptoKit verifies. If the two ever disagree about what an Ed25519
# signature over a byte string is, this is where it shows up rather than on
# Mom's Mac.
echo "# generating a node:crypto Ed25519 vector"
node - "$SCRATCH" <<'NODE'
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// The raw 32-byte public key is the last 32 bytes of the DER SubjectPublicKeyInfo.
const spki = publicKey.export({ type: 'spki', format: 'der' });
const raw = spki.subarray(spki.length - 32);
const payload = randomBytes(4096);
const signature = sign(null, payload, privateKey); // Ed25519: 64 raw bytes

writeFileSync(path.join(dir, 'crosscheck-pubkey.txt'), raw.toString('base64'));
writeFileSync(path.join(dir, 'crosscheck-payload.bin'), payload);
writeFileSync(path.join(dir, 'crosscheck-sig.txt'), signature.toString('base64'));
NODE
[[ $? -eq 0 ]] || { echo "Bail out! could not generate the cross-check vector"; exit 2; }

# ── run ──────────────────────────────────────────────────────────────────────
"$APP" --updater-selftest "$SCRATCH" --scratch "$WORK/bridge-scratch"
RC=$?

AFTER="$(fingerprint)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "not ok - ISOLATION VIOLATED: $REAL_BOARD changed during the run"
  RC=1
else
  echo "ok - isolation: $REAL_BOARD untouched by the run"
fi

[[ $RC -eq 0 ]] && echo "# updater selftest: PASS" || echo "# updater selftest: FAIL"
exit $RC
