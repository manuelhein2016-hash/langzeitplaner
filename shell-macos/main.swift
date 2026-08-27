// Native macOS shell — a hand-built .app bundle, no installer, no Electron.
//
// This is a stand-in for src-tauri/ (which needs a Rust toolchain). It gives the
// board what the spec asks for: one chromeless window, the §9 menu bar, ⌘W
// hiding rather than quitting, an optional menu-bar icon, and real storage in
// ~/Library/Application Support/LangzeitPlaner/board.json written atomically.
//
// The frontend is unchanged: this shim exposes the same `window.__TAURI__`
// surface storage.js and main.js already talk to, so the identical web layer
// runs under either shell.

import Cocoa
import WebKit
import ServiceManagement
import CryptoKit

let APP_SCHEME = "app"
let APP_HOST = "localhost"

// ── headless modes ───────────────────────────────────────────────────────────
//
//   --smoke                 load the board, print one line of what it rendered
//   --test <file.js>        load the board, run <file.js> against the live DOM,
//                           print TAP, exit non-zero on any failure
//   --scratch <dir>         where the bridge's files — board.json, snapshots.json,
//                           ops.jsonl, checkpoint.json — go in a headless run
//                           (default: a per-mode temp dir)
//
// Both headless modes are HERMETIC: every bridge write is redirected into a
// scratch directory, so a test run can never reach the user's real board. That
// is enforced by `resolveScratchDir()` below, which aborts rather than fall
// back to Application Support, and by `dataFile()`, which re-checks the
// resolved FILE — so the guard covers board.json, snapshots.json and the two
// LZP-402 op-log files alike, and covers any file added later by construction.

private func argValue(_ flag: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: flag), i + 1 < a.count else { return nil }
    let v = a[i + 1]
    return v.hasPrefix("--") ? nil : v
}

let isSmokeRun = CommandLine.arguments.contains("--smoke")
let testFilePath: String? = CommandLine.arguments.contains("--test") ? argValue("--test") : nil
let isTestRun = testFilePath != nil
// --updater-selftest <dir>  exercises the LZP-102 signature + apply path against a
// scratch directory and exits. It is headless for the same reason the other two
// are: it must never resolve a path inside the user's real board directory.
let selftestDir: String? = CommandLine.arguments.contains("--updater-selftest")
    ? argValue("--updater-selftest") : nil
let isSelftestRun = selftestDir != nil
let isHeadless = isSmokeRun || isTestRun || isSelftestRun

// ── paths ────────────────────────────────────────────────────────────────────

/// The real, user-owned board directory. Only ever used by a normal launch.
private func realAppSupportDir() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("LangzeitPlaner", isDirectory: true)
}

/// Scratch directory for headless runs. `--scratch` wins; otherwise a fixed
/// per-mode temp dir. The guard is the point: if this ever resolved to the real
/// board directory we abort the process instead of writing there.
private func resolveScratchDir() -> URL {
    let dir: URL
    if let override = argValue("--scratch") {
        dir = URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
    } else {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(
            isTestRun ? "LangzeitPlaner-test" : "LangzeitPlaner-smoke", isDirectory: true)
    }
    let resolved = dir.standardizedFileURL.path
    let real = realAppSupportDir().standardizedFileURL.path
    if resolved == real || resolved.hasPrefix(real + "/") {
        FileHandle.standardError.write(Data(
            "FATAL: headless scratch dir resolved inside the real board directory (\(resolved)). Refusing to run.\n"
                .utf8))
        exit(70)
    }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func appSupportDir() -> URL {
    if isHeadless { return resolveScratchDir() }
    let dir = realAppSupportDir()
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

// ── the four files the bridge owns ───────────────────────────────────────────
//
//   board.json       v1's materialized board — in solo mode it IS the checkpoint
//   snapshots.json   the daily snapshot ring (11.5)
//   ops.jsonl        LZP-402's op log, one op per line, APPEND-ONLY (ADR 001 §9)
//   checkpoint.json  the serialized RegisterMap + cursors + seqs + parked lines
//
// ADR 001 §9/§11: the bottom two do not exist until a family space is created.
// The read commands are pure — they create nothing — so `opsLogExists()` stays
// an honest predicate.

let BOARD_FILE = "board.json"
let SNAPSHOT_FILE = "snapshots.json"
let OPS_FILE = "ops.jsonl"
let CHECKPOINT_FILE = "checkpoint.json"

/// Every path the bridge touches is built here, and nowhere else.
///
/// This is the second half of the headless scratch guard. `resolveScratchDir()`
/// proves the *directory* is outside the user's board dir; this proves the
/// *file* that was resolved inside it is too. One is redundant given the other
/// today — deliberately: the redundancy is what makes adding a fifth file safe
/// without anyone having to remember the guard exists.
func dataFile(_ name: String) -> URL {
    let url = appSupportDir().appendingPathComponent(name).standardizedFileURL
    guard isHeadless else { return url }
    let real = realAppSupportDir().standardizedFileURL.path
    if url.path == real || url.path.hasPrefix(real + "/") {
        FileHandle.standardError.write(Data(
            "FATAL: headless run resolved \(name) inside the real board directory (\(url.path)). Refusing to write.\n"
                .utf8))
        exit(70)
    }
    return url
}

/// 11.4 — temp file + rename, so a crash mid-save cannot corrupt the board.
func writeAtomic(_ url: URL, _ contents: String) throws {
    let tmp = url.appendingPathExtension("tmp")
    try contents.write(to: tmp, atomically: false, encoding: .utf8)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
}

/// ADR 001 §9 — the log is APPENDED, never rewritten. `writeAtomic` would make
/// every append O(file), and therefore the whole log O(n²) to write. Seek to the
/// end and write the new bytes; `synchronize()` puts them on the platter before
/// the reply goes back, which is what makes an append durable enough to be the
/// source of truth. Partial-write risk is bounded by the reader: `parseJSONL`
/// drops a torn trailing line and keeps the rest.
func appendToFile(_ url: URL, _ contents: String) throws {
    guard !contents.isEmpty else { return }
    let data = Data(contents.utf8)
    let fm = FileManager.default
    if !fm.fileExists(atPath: url.path) {
        guard fm.createFile(atPath: url.path, contents: nil) else {
            throw NSError(domain: "LZP", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "cannot create \(url.lastPathComponent)"])
        }
    }
    let fh = try FileHandle(forWritingTo: url)
    defer { try? fh.close() }
    try fh.seekToEnd()
    try fh.write(contentsOf: data)
    try fh.synchronize()
}

func readIfExists(_ url: URL) -> String? {
    try? String(contentsOf: url, encoding: .utf8)
}

/// Split a JSONL blob the way `storage.js`'s `parseJSONL` does — blank lines and
/// unparseable lines skipped — so a line index computed from what `load_ops`
/// returned means the same thing on this side. That equivalence is the whole
/// contract of `truncate_ops(keepFromLine:)`.
func jsonlLines(_ txt: String) -> [String] {
    var out: [String] = []
    for raw in txt.split(separator: "\n", omittingEmptySubsequences: false) {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { continue }
        guard let d = s.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])) != nil
        else { continue }
        out.append(s)
    }
    return out
}

// ═══════════════════════════════════════════════════════════════════════════
// F22 · UPDATES — LZP-102 (auto-updater) + LZP-104 (minimum version)
// Stories 22.3, 22.5, 22.6, 22.7.  Amendment A11 (Ferien data rides this channel).
// ═══════════════════════════════════════════════════════════════════════════
//
// DIVISION OF LABOUR. Every *decision* — is a check due, is this manifest
// well-formed, is the offered build newer, is this client below the declared
// minimum — lives in `src/js/platform/updater.js`, which is DOM-free and covered
// by `tests/tier1/platform-updater.test.js`. This file does only what JavaScript
// cannot: one HTTPS GET from OUTSIDE the WebView, an Ed25519 signature check
// over the downloaded bytes, and the bundle swap. Four commands, no cleverness.
//
// 21.5 — WHY THE REQUEST IS MADE HERE AND NOT IN THE PAGE. Story 21.5 says the
// app makes zero network requests in solo mode; 22.3 says it checks for updates
// daily. The reading implemented across these two files: the BOARD still makes
// zero requests — its CSP stays `default-src 'self'`, the navigation gate below
// still cancels every non-`app:` scheme, and no `fetch` exists in the web layer.
// The SHELL makes exactly one: an unauthenticated GET of one static manifest on
// one pinned host, with no cookies, no query string, no identifiers and no board
// content. And it does not happen at all until `disclosed` is true — set once by
// LZP-106's first-run screen, which is the one screen every unsigned install
// must pass through anyway. This is flagged to the PO in the ticket report; it
// is a spec tension, not an engineering preference.
//
// 22.6 — VERIFY BEFORE INSTALL, TWICE. The signature is checked when the bytes
// arrive AND again at apply time, immediately before the swap, because a
// verifier that ran days ago on a file that has been sitting on disk since is
// not a verifier. An artifact that fails either check is deleted and NOTHING is
// installed.

/// 22.5 — one channel for every device. Mirrors `CHANNEL` in updater.js.
let UPDATE_CHANNEL = "stable"
/// Mirrors `TARGET` in updater.js and Tauri's target triple naming, so ONE
/// manifest file serves both shells.
let UPDATE_TARGET = "darwin-universal"

/// PLACEHOLDER — there is no GitHub repository yet (PLAN.md §4: "the project is
/// not yet a git repo; D3's GitHub repo is a separate, PO-owned step"). LZP-101
/// owns the real slug. The placeholder marker below is checked at runtime and
/// the fetch REFUSES rather than resolving some unrelated host.
let UPDATE_MANIFEST_URL =
    "https://github.com/OWNER-PLACEHOLDER/langzeitplaner/releases/latest/download/latest.json"

/// PLACEHOLDER — the updater key does not exist yet either. Empty means the
/// updater refuses to download anything at all, which is the correct failure
/// mode: no key, no installs. Replace with the base64 of the 32-byte Ed25519
/// public key (a minisign `.pub` line is also accepted).
let UPDATER_PUBLIC_KEY_B64 = ""

let UPDATER_PREFS_FILE = "updater.json"
let UPDATER_STAGED_FILE = "staged-update.tar.gz"

/// A manifest is a few hundred bytes. Anything larger is a mistake or a denial
/// of service, and either way we are not reading it.
let UPDATE_MANIFEST_MAX_BYTES = 256 * 1024
/// 22.1 puts the DMG at ~15 MB. 200 MB is generous headroom and still a bound.
let UPDATE_ARTIFACT_MAX_BYTES = 200 * 1024 * 1024

/// Headless-only overrides, gated exactly like `--scratch`: they exist so the
/// selftest can drive a real key and a real artifact, and they are unreachable
/// in a normal launch. A production build that honoured an `--updater-pubkey`
/// flag would have a trivially hijackable update path, which is the one thing
/// 22.6 exists to prevent.
func updaterPublicKeyB64() -> String {
    if isHeadless, let k = argValue("--updater-pubkey") { return k }
    return UPDATER_PUBLIC_KEY_B64
}
func updateManifestURLString() -> String {
    if isHeadless, let u = argValue("--updater-manifest-url") { return u }
    return UPDATE_MANIFEST_URL
}

// ── the updater's own tiny preference file ───────────────────────────────────
//
// Deliberately NOT in board.json: 22.7 says updates never touch user data, and
// the cheapest way to keep that true is for the updater to have no reason to
// open the user's files at all. `dataFile()` routes this through the same
// headless scratch guard as everything else.

struct UpdaterPrefs {
    /// The settings switch (22.4's quiet family — the user can always turn it off).
    var enabled = true
    /// 21.5 — has the first-run screen told the user this happens? No check of
    /// any kind runs until this is true. Defaults to FALSE: a fresh install is
    /// silent until someone has been told.
    var disclosed = false
    /// Epoch milliseconds, to match JavaScript's clock without conversion.
    var lastCheckAt: Double = 0
    var stagedVersion: String?
    var stagedSignature: String?

    static func load() -> UpdaterPrefs {
        var p = UpdaterPrefs()
        guard let txt = readIfExists(dataFile(UPDATER_PREFS_FILE)),
              let d = txt.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        else { return p }
        if let v = o["enabled"] as? Bool { p.enabled = v }
        if let v = o["disclosed"] as? Bool { p.disclosed = v }
        if let v = o["lastCheckAt"] as? Double { p.lastCheckAt = v }
        p.stagedVersion = o["stagedVersion"] as? String
        p.stagedSignature = o["stagedSignature"] as? String
        return p
    }

    func save() {
        var o: [String: Any] = [
            "enabled": enabled, "disclosed": disclosed, "lastCheckAt": lastCheckAt,
        ]
        o["stagedVersion"] = stagedVersion ?? NSNull()
        o["stagedSignature"] = stagedSignature ?? NSNull()
        if let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted]),
           let s = String(data: d, encoding: .utf8) {
            try? writeAtomic(dataFile(UPDATER_PREFS_FILE), s)
        }
    }
}

/// `CFBundleShortVersionString`. If it is missing the updater reports null and
/// the JS side lands in its error state — which is right: a build that does not
/// know its own version must not be comparing itself to anything.
func installedVersion() -> String? {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
}

// ── 22.6 · Ed25519 verification ──────────────────────────────────────────────

enum UpdaterError: String, Error {
    case noKey = "no-updater-key"
    case noReleaseHost = "no-release-host"
    case badKey = "bad-updater-key"
    case badSignatureFormat = "signature-format"
    case prehashedUnsupported = "signature-format-prehashed"
    case signature = "signature"
    case tooLarge = "too-large"
    case sizeMismatch = "size-mismatch"
    case badURL = "bad-url"
    case http = "http"
    case io = "io"
    case extractFailed = "extract-failed"
    case notAnApp = "not-an-app"
    case nothingStaged = "nothing-staged"
}

/// Accepts either the base64 of a raw 32-byte Ed25519 public key, or a minisign
/// `.pub` (2-byte algorithm + 8-byte key id + 32-byte key), with or without its
/// `untrusted comment:` line.
func parseUpdaterPublicKey(_ raw: String) -> Curve25519.Signing.PublicKey? {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    var candidates: [String] = []
    for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
        let l = line.trimmingCharacters(in: .whitespaces)
        if l.isEmpty || l.lowercased().hasPrefix("untrusted comment:") { continue }
        candidates.append(l)
    }
    for c in candidates {
        guard let d = Data(base64Encoded: c) else { continue }
        if d.count == 32, let k = try? Curve25519.Signing.PublicKey(rawRepresentation: d) { return k }
        if d.count == 42, d.prefix(2) == Data("Ed".utf8),
           let k = try? Curve25519.Signing.PublicKey(rawRepresentation: d.suffix(32)) {
            return k
        }
    }
    return nil
}

/// Pull the 64 raw signature bytes out of whatever the manifest carried.
///
/// Three shapes are accepted, in this order:
///   1. base64 of exactly 64 bytes — the plain Ed25519 signature (our own shape),
///   2. base64 of a minisign `.sig` FILE (that is what Tauri's manifests carry),
///   3. the minisign `.sig` file text, unwrapped.
///
/// A minisign signature whose algorithm is `ED` is PREHASHED (BLAKE2b-512 of the
/// file, then Ed25519 over the digest). CryptoKit has no BLAKE2b, so that shape
/// is REFUSED with its own error rather than mis-verified. See the ticket report:
/// the release job (LZP-101) must be pinned to a shape this can verify, and that
/// pinning is an open item because no release job exists yet.
func extractEd25519Signature(_ raw: String) -> Result<Data, UpdaterError> {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return .failure(.badSignatureFormat) }

    func fromMinisignText(_ t: String) -> Result<Data, UpdaterError>? {
        for line in t.split(separator: "\n", omittingEmptySubsequences: true) {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.isEmpty || l.lowercased().hasPrefix("untrusted comment:") { continue }
            if l.lowercased().hasPrefix("trusted comment:") { continue }
            guard let d = Data(base64Encoded: l), d.count == 74 else { continue }
            let alg = d.prefix(2)
            if alg == Data("ED".utf8) { return .failure(.prehashedUnsupported) }
            if alg == Data("Ed".utf8) { return .success(d.suffix(64)) }
            return .failure(.badSignatureFormat)
        }
        return nil
    }

    if text.lowercased().contains("untrusted comment:") {
        if let r = fromMinisignText(text) { return r }
        return .failure(.badSignatureFormat)
    }
    guard let outer = Data(base64Encoded: text) else { return .failure(.badSignatureFormat) }
    if outer.count == 64 { return .success(outer) }
    if let inner = String(data: outer, encoding: .utf8), let r = fromMinisignText(inner) { return r }
    return .failure(.badSignatureFormat)
}

/// The whole of 22.6 in one function: these bytes, this signature, this key.
/// Nothing else in this file is allowed to decide that an artifact is authentic.
func verifyArtifact(_ bytes: Data, signature raw: String, publicKey pubB64: String)
    -> Result<Void, UpdaterError>
{
    guard !pubB64.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return .failure(.noKey)
    }
    guard let key = parseUpdaterPublicKey(pubB64) else { return .failure(.badKey) }
    let sig: Data
    switch extractEd25519Signature(raw) {
    case .success(let s): sig = s
    case .failure(let e): return .failure(e)
    }
    return key.isValidSignature(sig, for: bytes) ? .success(()) : .failure(.signature)
}

// ── the swap ─────────────────────────────────────────────────────────────────

/// Replace `installedApp` with the verified contents of `artifact`.
///
/// The signature is re-checked HERE, over the bytes as they are on disk right
/// now, immediately before anything is unpacked. The artifact may have been
/// sitting in Application Support since yesterday; whatever we proved about it
/// then says nothing about it now.
///
/// Written as a free function taking both paths so the selftest can drive the
/// real code against a scratch bundle instead of against `/Applications`.
@discardableResult
func applyStagedUpdate(artifact: URL, signature: String, publicKey: String, installedApp: URL)
    -> Result<String, UpdaterError>
{
    guard let bytes = try? Data(contentsOf: artifact) else { return .failure(.io) }
    if case .failure(let e) = verifyArtifact(bytes, signature: signature, publicKey: publicKey) {
        // Verification failed at apply time. Delete the artifact — a build that
        // cannot be proven authentic is never retried, it is thrown away — and
        // install NOTHING.
        try? FileManager.default.removeItem(at: artifact)
        return .failure(e)
    }

    let work = FileManager.default.temporaryDirectory
        .appendingPathComponent("LangzeitPlaner-apply-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: work) }
    do { try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true) }
    catch { return .failure(.io) }

    // /usr/bin/tar rather than a Swift archive library: zero dependencies is a
    // project-wide rule, and this is the same tar every macOS ships.
    let tar = Process()
    tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
    tar.arguments = ["-xzf", artifact.path, "-C", work.path]
    tar.standardOutput = FileHandle.nullDevice
    tar.standardError = FileHandle.nullDevice
    do {
        try tar.run()
        tar.waitUntilExit()
    } catch {
        return .failure(.extractFailed)
    }
    guard tar.terminationStatus == 0 else { return .failure(.extractFailed) }

    // Exactly one .app at the top level, and it must actually contain an
    // executable. An archive that unpacks to something else is not a build.
    let entries = (try? FileManager.default.contentsOfDirectory(
        at: work, includingPropertiesForKeys: nil)) ?? []
    guard let newApp = entries.first(where: { $0.pathExtension == "app" }) else {
        return .failure(.notAnApp)
    }
    let macos = newApp.appendingPathComponent("Contents/MacOS", isDirectory: true)
    let execs = (try? FileManager.default.contentsOfDirectory(atPath: macos.path)) ?? []
    guard !execs.isEmpty else { return .failure(.notAnApp) }

    // replaceItemAt is the atomic swap: the old bundle is moved aside and the new
    // one put in its place, or nothing happens at all.
    do {
        if FileManager.default.fileExists(atPath: installedApp.path) {
            _ = try FileManager.default.replaceItemAt(installedApp, withItemAt: newApp)
        } else {
            try FileManager.default.moveItem(at: newApp, to: installedApp)
        }
    } catch {
        return .failure(.io)
    }
    return .success(installedApp.path)
}

/// Quit and come back. `open -n` starts the (possibly just-replaced) bundle and
/// this process exits, so the two never overlap. Guarded because both the flush
/// callback and its 2 s watchdog can reach it, and two `open -n` calls would
/// leave two LangzeitPlaners on screen.
private var relaunchStarted = false
func relaunchSelf() {
    if relaunchStarted { return }
    relaunchStarted = true
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-n", Bundle.main.bundleURL.path]
    try? p.run()
    exit(0)
}

/// 22.3 — "applies on the next start". Called once at launch, before the window
/// exists, so the user never sees a half-swapped app. Never in a headless run.
func applyStagedUpdateAtLaunch() {
    guard !isHeadless else { return }
    var prefs = UpdaterPrefs.load()
    guard let version = prefs.stagedVersion, let sig = prefs.stagedSignature else { return }
    let artifact = dataFile(UPDATER_STAGED_FILE)
    guard FileManager.default.fileExists(atPath: artifact.path) else {
        prefs.stagedVersion = nil; prefs.stagedSignature = nil; prefs.save()
        return
    }
    let result = applyStagedUpdate(
        artifact: artifact, signature: sig,
        publicKey: updaterPublicKeyB64(), installedApp: Bundle.main.bundleURL)

    // The staged slot is cleared either way: on success it has been consumed, on
    // failure it is poison. 22.7 — nothing in this path reads or writes
    // board.json, ops.jsonl, checkpoint.json or snapshots.json. Schema
    // migrations (11.6) run at the next boot of the NEW binary, after the swap,
    // exactly as they do for any other version change.
    prefs.stagedVersion = nil
    prefs.stagedSignature = nil
    prefs.save()
    try? FileManager.default.removeItem(at: artifact)

    switch result {
    case .success:
        relaunchSelf()
    case .failure(let e):
        FileHandle.standardError.write(Data(
            "LZP updater: staged \(version) NOT installed (\(e.rawValue)); the running build is unchanged.\n".utf8))
    }
}

// ── the four bridge commands ─────────────────────────────────────────────────

/// Serialise a reply for the web layer. The JS side parses with `JSON.parse`, so
/// everything crossing this boundary is a JSON string, never a dictionary — one
/// shape for both shells.
func updaterJSON(_ o: [String: Any]) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8)
    else { return "{\"ok\":false,\"error\":\"encode\"}" }
    return s
}

func updaterStatusJSON() -> String {
    let p = UpdaterPrefs.load()
    return updaterJSON([
        "currentVersion": installedVersion() ?? NSNull(),
        "channel": UPDATE_CHANNEL,
        "target": UPDATE_TARGET,
        "enabled": p.enabled,
        "disclosed": p.disclosed,
        "lastCheckAt": p.lastCheckAt,
        "stagedVersion": p.stagedVersion ?? NSNull(),
    ])
}

/// The one network request in the whole product's solo mode, and the reason the
/// 21.5 flag exists. Both gates are re-checked HERE — not only in JavaScript —
/// because a bridge command is reachable from any page script and the guarantee
/// must not depend on the caller being polite.
func updaterFetchManifest(_ done: @escaping (String) -> Void) {
    let prefs = UpdaterPrefs.load()
    guard prefs.disclosed, prefs.enabled else {
        done(updaterJSON(["ok": false, "error": "disabled"]))
        return
    }
    let urlString = updateManifestURLString()
    guard !urlString.contains("OWNER-PLACEHOLDER") else {
        // No repository exists yet (PLAN.md §4). Refusing beats resolving some
        // unrelated host that happens to answer.
        done(updaterJSON(["ok": false, "error": UpdaterError.noReleaseHost.rawValue]))
        return
    }
    guard let url = URL(string: urlString), url.scheme == "https", url.host != nil else {
        done(updaterJSON(["ok": false, "error": UpdaterError.badURL.rawValue]))
        return
    }

    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.timeoutInterval = 20
    // No cookies, no credentials, no cache identity, no custom headers: the
    // request carries nothing about this machine or this family beyond the fact
    // that someone asked for a public file.
    req.httpShouldHandleCookies = false
    req.cachePolicy = .reloadIgnoringLocalCacheData
    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpCookieAcceptPolicy = .never
    cfg.httpShouldSetCookies = false
    let session = URLSession(configuration: cfg)
    session.dataTask(with: req) { data, response, error in
        let reply: String
        if let error = error {
            reply = updaterJSON(["ok": false, "error": "network", "detail": error.localizedDescription])
        } else if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            reply = updaterJSON(["ok": false, "error": UpdaterError.http.rawValue, "status": http.statusCode])
        } else if let data = data, data.count > UPDATE_MANIFEST_MAX_BYTES {
            reply = updaterJSON(["ok": false, "error": UpdaterError.tooLarge.rawValue])
        } else if let data = data, let text = String(data: data, encoding: .utf8) {
            // The RAW text goes to JavaScript. This side has no opinion about
            // what a manifest means — `parseManifest` in updater.js does, and it
            // is the tested one.
            reply = updaterJSON(["ok": true, "manifest": text])
        } else {
            reply = updaterJSON(["ok": false, "error": UpdaterError.io.rawValue])
        }
        DispatchQueue.main.async { done(reply) }
    }.resume()
}

/// Download, VERIFY, stage. In that order, and the staging never happens without
/// the verifying. Nothing is installed here — 22.3 says the update applies at the
/// next start, which is `applyStagedUpdateAtLaunch()` above.
func updaterDownload(version: String, urlString: String, signature: String, expectedSize: Int,
                     _ done: @escaping (String) -> Void)
{
    let prefs = UpdaterPrefs.load()
    guard prefs.disclosed, prefs.enabled else {
        done(updaterJSON(["ok": false, "error": "disabled"]))
        return
    }
    let pub = updaterPublicKeyB64()
    guard !pub.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        // No key, no installs. The correct behaviour for an unsigned build with
        // no updater key is to be un-updatable, not to be updatable by anyone.
        done(updaterJSON(["ok": false, "error": UpdaterError.noKey.rawValue]))
        return
    }
    guard let url = URL(string: urlString), url.scheme == "https", url.host != nil else {
        done(updaterJSON(["ok": false, "error": UpdaterError.badURL.rawValue]))
        return
    }

    var req = URLRequest(url: url)
    req.timeoutInterval = 300
    req.httpShouldHandleCookies = false
    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpCookieAcceptPolicy = .never
    let session = URLSession(configuration: cfg)
    session.downloadTask(with: req) { tmp, response, error in
        func reply(_ o: [String: Any]) { DispatchQueue.main.async { done(updaterJSON(o)) } }
        if let error = error {
            reply(["ok": false, "error": "network", "detail": error.localizedDescription]); return
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            reply(["ok": false, "error": UpdaterError.http.rawValue, "status": http.statusCode]); return
        }
        guard let tmp = tmp, let bytes = try? Data(contentsOf: tmp) else {
            reply(["ok": false, "error": UpdaterError.io.rawValue]); return
        }
        if bytes.count > UPDATE_ARTIFACT_MAX_BYTES {
            reply(["ok": false, "error": UpdaterError.tooLarge.rawValue]); return
        }
        if expectedSize > 0 && bytes.count != expectedSize {
            reply(["ok": false, "error": UpdaterError.sizeMismatch.rawValue]); return
        }
        if case .failure(let e) = verifyArtifact(bytes, signature: signature, publicKey: pub) {
            // 22.6. The bytes arrived and were refused. Nothing is written to the
            // staging slot, nothing is installed, and the running app is
            // untouched. updater.js turns this into the visible error state.
            reply(["ok": false, "error": e.rawValue]); return
        }
        let dest = dataFile(UPDATER_STAGED_FILE)
        do {
            try? FileManager.default.removeItem(at: dest)
            try bytes.write(to: dest, options: [.atomic])
        } catch {
            reply(["ok": false, "error": UpdaterError.io.rawValue]); return
        }
        var p = UpdaterPrefs.load()
        p.stagedVersion = version
        p.stagedSignature = signature
        p.save()
        reply(["ok": true, "staged": true, "version": version, "bytes": bytes.count])
    }.resume()
}

// ── serving the web bundle over a custom scheme ──────────────────────────────
// A custom scheme (rather than file://) gives the page a real origin, so ES
// modules load normally — the same reason the browser build needs a dev server.

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(URLError(.badURL)); return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let target = root.appendingPathComponent(path).standardizedFileURL

        guard target.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: target) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let resp = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime(target.pathExtension),
                           "Cache-Control": "no-store"])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// ── web view ─────────────────────────────────────────────────────────────────
// WKWebView on macOS builds its own right-click menu at the AppKit level; the
// DOM contextmenu event's preventDefault never reaches it. The board owns
// right-click (it opens the day popover, story 9.1), so: keep WebKit's menu
// only when it is an *editing* menu (Cut/Paste present — i.e. the click was in
// a text field, where Paste and spellcheck are genuinely useful), suppress it
// everywhere else and hand the click point to the page instead.

final class BoardWebView: WKWebView {
    private var lastRightClick = NSPoint.zero

    override func rightMouseDown(with event: NSEvent) {
        // WKWebView is flipped, so view coordinates are CSS pixels.
        lastRightClick = convert(event.locationInWindow, from: nil)
        super.rightMouseDown(with: event)
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        let editing = menu.items.contains {
            let id = $0.identifier?.rawValue ?? ""
            return id == "WKMenuItemIdentifierPaste" || id == "WKMenuItemIdentifierCut"
        }
        if !editing {
            menu.removeAllItems() // AppKit shows no menu for an empty item list
            evaluateJavaScript(
                "window.__lzpContextMenu && window.__lzpContextMenu(\(lastRightClick.x), \(lastRightClick.y))",
                completionHandler: nil)
        }
    }
}

// ── the __TAURI__ bridge ─────────────────────────────────────────────────────

final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var window: NSWindow?
    var printAction: (() -> Void)?
    var relabelMenu: ((String) -> Void)?
    /// 22.4 (LZP-103) — the quiet hint's App-menu half. `nil` removes the item;
    /// a version string adds it. The web layer decides *whether* there is a
    /// hint (one predicate, in update-ui.js); the shell only draws it.
    var setUpdateHint: ((String?) -> Void)?
    /// 22.4 — "one click restarts into the new version". Quit and relaunch; the
    /// staged build is swapped in by `applyStagedUpdateAtLaunch()` on the way up.
    var restartForUpdate: (() -> Void)?

    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any],
              let cmd = body["cmd"] as? String else {
            replyHandler(nil, "malformed invoke"); return
        }
        let args = body["args"] as? [String: Any] ?? [:]

        do {
            switch cmd {
            case "load_board":
                replyHandler(readIfExists(dataFile(BOARD_FILE)) ?? NSNull(), nil)

            case "save_board":
                try writeAtomic(dataFile(BOARD_FILE), args["contents"] as? String ?? "")
                replyHandler(NSNull(), nil)

            case "load_snapshots":
                replyHandler(readIfExists(dataFile(SNAPSHOT_FILE)) ?? NSNull(), nil)

            case "save_snapshots":
                try writeAtomic(dataFile(SNAPSHOT_FILE), args["contents"] as? String ?? "")
                replyHandler(NSNull(), nil)

            // ── LZP-402 · the op log (ADR 001 §9, ADR 005 §2.3) ──────────────
            //
            // `storage.js` calls these five. They are dormant in solo mode:
            // ADR 001 §9/§11 keep both files out of existence until a family
            // space exists, and `store-persistence.test.js` pins that a persist
            // touches exactly the two v1 slots. The two READS create nothing,
            // so they stay safe to call at any time.

            case "load_ops":
                // "" — not null — when the log does not exist yet. `parseJSONL`
                // turns both into [], but "" is what the published contract says
                // and what an existing-but-empty file returns, so the two cases
                // are indistinguishable to the caller, as they should be.
                replyHandler(readIfExists(dataFile(OPS_FILE)) ?? "", nil)

            case "append_ops":
                // APPEND. See appendToFile: not writeAtomic, on purpose.
                try appendToFile(dataFile(OPS_FILE), args["contents"] as? String ?? "")
                replyHandler(NSNull(), nil)

            case "truncate_ops":
                // The one whole-file rewrite the log gets, after a compaction
                // has folded its head into the checkpoint (ADR 001 §7.2). Rare
                // by construction, and atomic because a half-written log after a
                // compaction would lose ops the checkpoint had not absorbed yet.
                let keep = max(0, (args["keepFromLine"] as? Int)
                    ?? ((args["keepFromLine"] as? NSNumber)?.intValue ?? 0))
                let url = dataFile(OPS_FILE)
                let kept = jsonlLines(readIfExists(url) ?? "").dropFirst(keep)
                if kept.isEmpty {
                    try? FileManager.default.removeItem(at: url)
                } else {
                    try writeAtomic(url, kept.joined(separator: "\n") + "\n")
                }
                replyHandler(NSNull(), nil)

            case "load_checkpoint":
                replyHandler(readIfExists(dataFile(CHECKPOINT_FILE)) ?? "", nil)

            case "save_checkpoint":
                // Atomic, like save_board — and for a stronger reason. A torn
                // board.json can be rebuilt by replaying the log; a torn
                // checkpoint is the one file nothing else can re-derive.
                try writeAtomic(dataFile(CHECKPOINT_FILE), args["contents"] as? String ?? "")
                replyHandler(NSNull(), nil)

            case "export_board":
                // 11.7 — native save dialog, dated default name.
                let panel = NSSavePanel()
                panel.nameFieldStringValue = args["suggestedName"] as? String ?? "LangzeitPlaner.json"
                panel.allowedContentTypes = [.json]
                let ok = panel.runModal() == .OK
                if ok, let url = panel.url {
                    try (args["contents"] as? String ?? "").write(to: url, atomically: true, encoding: .utf8)
                }
                replyHandler(ok, nil)

            case "import_board":
                let panel = NSOpenPanel()
                panel.allowedContentTypes = [.json]
                panel.allowsMultipleSelection = false
                if panel.runModal() == .OK, let url = panel.url {
                    replyHandler(try String(contentsOf: url, encoding: .utf8), nil)
                } else {
                    replyHandler(NSNull(), nil)
                }

            // ── F22 · the updater port (LZP-102 / LZP-104) ───────────────────
            //
            // Exactly the four commands `bridgePort()` in src/js/platform/updater.js
            // sends, plus the two switches LZP-103's settings panel and LZP-106's
            // first-run screen need. Every reply is a JSON STRING, so the Tauri
            // shell can answer identically without a shared serde type.
            //
            // Nothing in this group can read or write board.json, ops.jsonl,
            // checkpoint.json or snapshots.json. That is 22.7 ("updates never
            // touch user data") enforced by the size of the surface rather than
            // by discipline.

            case "update_status":
                replyHandler(updaterStatusJSON(), nil)

            case "update_set_disclosed":
                // 21.5 — set ONCE by the first-run screen, after it has said in
                // one line that the app asks about updates. Nothing checks
                // anything before this is true.
                var p1 = UpdaterPrefs.load()
                p1.disclosed = args["value"] as? Bool ?? true
                p1.save()
                replyHandler(updaterStatusJSON(), nil)

            case "update_set_enabled":
                var p2 = UpdaterPrefs.load()
                p2.enabled = args["value"] as? Bool ?? true
                p2.save()
                replyHandler(updaterStatusJSON(), nil)

            case "update_note_check":
                // Written BEFORE the request goes out (updater.js does it in that
                // order), so a host that hangs cannot leave the device retrying
                // on every launch forever.
                var p3 = UpdaterPrefs.load()
                p3.lastCheckAt = (args["at"] as? Double)
                    ?? ((args["at"] as? NSNumber)?.doubleValue ?? 0)
                p3.save()
                replyHandler(NSNull(), nil)

            case "update_fetch_manifest":
                updaterFetchManifest { replyHandler($0, nil) }

            case "update_download":
                let size = (args["size"] as? Int) ?? ((args["size"] as? NSNumber)?.intValue ?? 0)
                updaterDownload(
                    version: args["version"] as? String ?? "",
                    urlString: args["url"] as? String ?? "",
                    signature: args["signature"] as? String ?? "",
                    expectedSize: size
                ) { replyHandler($0, nil) }

            case "update_clear_staged":
                var p4 = UpdaterPrefs.load()
                p4.stagedVersion = nil
                p4.stagedSignature = nil
                p4.save()
                try? FileManager.default.removeItem(at: dataFile(UPDATER_STAGED_FILE))
                replyHandler(updaterStatusJSON(), nil)

            case "update_menu_hint":
                // 22.4 — the App-menu half of the quiet hint. The web layer owns
                // the predicate (one function, in update-ui.js); the shell only
                // draws it. An empty string means "no hint": JSON `null` and an
                // absent argument are not distinguishable across both bridges.
                let hint = args["version"] as? String ?? ""
                setUpdateHint?(hint.isEmpty ? nil : hint)
                replyHandler(NSNull(), nil)

            case "update_restart":
                // 22.4 — the ONE click. Refuses unless a verified build is
                // actually staged: restarting into the same version would be a
                // rude no-op, and it is the kind of no-op a user reads as "the
                // button is broken". Refuses in a headless run too, so a tier-2
                // test that exercises this path cannot terminate its own runner.
                let sp = UpdaterPrefs.load()
                if isHeadless {
                    replyHandler(updaterJSON(["ok": false, "error": "headless"]), nil)
                } else if sp.stagedVersion == nil {
                    replyHandler(updaterJSON(["ok": false, "error": "nothing-staged"]), nil)
                } else {
                    // Reply BEFORE relaunching; the web layer never sees it, but
                    // an unanswered reply handler is a WebKit assertion failure.
                    replyHandler(updaterJSON(["ok": true, "restarting": true]), nil)
                    restartForUpdate?()
                }

            case "print_board":
                printAction?()
                replyHandler(NSNull(), nil)

            case "set_shell_pref":
                switch args["key"] as? String {
                case "menu_bar_icon":
                    StatusItemController.shared.setVisible(args["value"] as? Bool ?? false)
                    replyHandler(NSNull(), nil)
                case "launch_at_login":
                    // 13.3 — SMAppService registers the app itself as a login
                    // item; per-user, revocable in System Settings.
                    let on = args["value"] as? Bool ?? false
                    do {
                        if on { try SMAppService.mainApp.register() }
                        else if SMAppService.mainApp.status == .enabled {
                            try SMAppService.mainApp.unregister()
                        }
                        replyHandler(NSNull(), nil)
                    } catch {
                        replyHandler(nil, "launch_at_login: \(error.localizedDescription)")
                    }
                case "language":
                    relabelMenu?(args["value"] as? String ?? "de")
                    replyHandler(NSNull(), nil)
                // (`update_menu_hint` is its own command, below — `set_shell_pref`
                //  carries booleans and a version string is not one.)
                default:
                    replyHandler(nil, "unknown shell pref")
                }

            default:
                replyHandler(nil, "unknown command: \(cmd)")
            }
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }
}

// ── menu-bar icon (13.2) ─────────────────────────────────────────────────────

final class StatusItemController {
    static let shared = StatusItemController()
    private var item: NSStatusItem?
    weak var window: NSWindow?

    func setVisible(_ visible: Bool) {
        if visible {
            guard item == nil else { return }
            let it = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            // Template glyph: monochrome, light/dark aware.
            it.button?.image = NSImage(systemSymbolName: "calendar",
                                       accessibilityDescription: "LangzeitPlaner")
            it.button?.image?.isTemplate = true
            it.button?.target = self
            it.button?.action = #selector(focusWindow)
            item = it
        } else if let it = item {
            NSStatusBar.system.removeStatusItem(it)
            item = nil
        }
    }

    @objc func focusWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

// ── app ──────────────────────────────────────────────────────────────────────

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let bridge = Bridge()

    func applicationDidFinishLaunching(_ note: Notification) {
        // 22.3 — "applies on the next start". Before the window, before the web
        // view, before anything can be half-swapped under a running board. If a
        // verified build is staged this call does not return: it swaps the
        // bundle and relaunches into it.
        applyStagedUpdateAtLaunch()

        let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)

        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(BundleSchemeHandler(root: webRoot), forURLScheme: APP_SCHEME)
        cfg.userContentController.addScriptMessageHandler(
            bridge, contentWorld: .page, name: "lzp")

        // The shim the web layer already expects. Injected before any module
        // runs, so storage.js sees a Tauri-shaped host from the first line.
        let shim = """
        window.__TAURI__ = {
          core: {
            invoke: (cmd, args) =>
              window.webkit.messageHandlers.lzp.postMessage({ cmd, args: args || {} })
          },
          event: {
            listen: (name, cb) => {
              window.__lzpListeners = window.__lzpListeners || {};
              (window.__lzpListeners[name] = window.__lzpListeners[name] || []).push(cb);
              return Promise.resolve(() => {});
            }
          }
        };
        window.__lzpEmit = (name, payload) =>
          (window.__lzpListeners?.[name] || []).forEach(cb => cb({ payload }));
        window.__lzpErrors = [];
        window.addEventListener('error', e => window.__lzpErrors.push(String(e.message)));
        window.addEventListener('unhandledrejection', e => window.__lzpErrors.push('rejection: ' + e.reason));
        """

        // WP-3: arm the R5 shadow-undo assertion for headless runs, and ONLY for those.
        //
        // `src/js/core/dev.js` reads `globalThis.__LZP_DEV` exactly ONCE, at import time — a flag
        // that can flip mid-run gives you a store whose txn() captured no shadow pre-image and an
        // undo() that then demands one. `atDocumentStart` is the only place in this host that runs
        // before the first module, which makes it the tier-2 equivalent of
        // `node --test --import tests/helpers/dev-flag.mjs`.
        //
        // WHY IT MATTERS HERE. WP-3's exit criterion is "the v1 suite stays green WITH THE
        // SHADOW-UNDO ASSERTION ON". Tier 1, the attack suite and the property suite all arm it
        // through the npm scripts; tier 2 did not, so the ONE suite that drives the retrofitted
        // store through real gestures — the mutation paths the assertion exists to guard — was
        // running with the guard off. That is attack ATT-96's finding, one tier further down.
        //
        // It is gated on `testFilePath` so the shipping app never carries it: `DEV` stays false
        // for every user, and the assertion cannot throw in anyone's face.
        let devArm = testFilePath != nil ? "window.__LZP_DEV = true;\n" : ""

        cfg.userContentController.addUserScript(
            WKUserScript(source: devArm + shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = BoardWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "LangzeitPlaner"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 900, height: 640)
        window.contentView = webView
        window.delegate = self
        // 13.1 — remember size and position across launches. Center only on
        // the very first launch: an unconditional center() would overwrite the
        // frame that setFrameUsingName just restored.
        let hadSavedFrame = window.setFrameUsingName("LangzeitPlanerMain")
        window.setFrameAutosaveName("LangzeitPlanerMain")
        if !hadSavedFrame { window.center() }
        window.makeKeyAndOrderFront(nil)

        bridge.window = window
        bridge.printAction = { [weak self] in self?.printBoard(nil) }
        bridge.relabelMenu = { [weak self] lang in
            guard let self else { return }
            self.menuLang = lang
            NSApp.mainMenu = self.buildMenu()
        }
        // 22.4 — the hint appears and disappears by rebuilding the menu, the
        // same mechanism 13.7's language switch already uses.
        bridge.setUpdateHint = { [weak self] version in
            guard let self, self.updateHintVersion != version else { return }
            self.updateHintVersion = version
            NSApp.mainMenu = self.buildMenu()
        }
        bridge.restartForUpdate = { [weak self] in
            guard let self else { return }
            // 11.1 — never quit over an unflushed 700 ms save debounce, not even
            // for an update. Ask the page to persist, then relaunch; the staged
            // build is swapped in by applyStagedUpdateAtLaunch() on the way up.
            // 22.7 is unaffected either way: the swap touches no board file.
            self.webView.callAsyncJavaScript(
                "if (window.__lzpFlush) { await window.__lzpFlush(); } return true;",
                in: nil, in: .page) { _ in relaunchSelf() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { relaunchSelf() }
        }
        StatusItemController.shared.window = window
        // 13.2 — visibility follows the stored preference, which the web layer
        // pushes through set_shell_pref right after boot; no icon until then.

        NSApp.mainMenu = buildMenu()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        webView.load(URLRequest(url: URL(string: "\(APP_SCHEME)://\(APP_HOST)/index.html")!))
    }

    /// 13.4 — zero network as an enforced property, not a habit: the web view
    /// may navigate only within its own bundle scheme.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme ?? ""
        decisionHandler(scheme == APP_SCHEME || scheme == "about" ? .allow : .cancel)
    }

    /// `LangzeitPlaner --smoke` loads the board headlessly, reports what it
    /// rendered and whether the __TAURI__ bridge round-trips, then exits. It is
    /// how this shell is tested without a screen.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if isTestRun { runTestFile(webView); return }
        guard isSmokeRun else { return }
        let probe = """
        // boot() awaits store.init(), which awaits a bridge round-trip, so the
        // board is not on screen yet when the navigation finishes.
        for (let i = 0; i < 60 && !document.querySelector('.board .col'); i++) {
          await new Promise(r => setTimeout(r, 50));
        }
        const cols = document.querySelectorAll('.board .col').length;
        const days = document.querySelectorAll('.board .day[data-date]').length;
        const hol  = document.querySelectorAll('.board .d-hol').length;
        const pads = document.querySelectorAll('.board .pad textarea').length;
        const head = [...document.querySelectorAll('.col-head')].slice(0, 3).map(n => n.textContent);
        let bridge = 'no';
        try {
          await window.__TAURI__.core.invoke('save_board', { contents: '{"smoke":true}' });
          const back = await window.__TAURI__.core.invoke('load_board', {});
          bridge = (back && back.includes('smoke')) ? 'roundtrip-ok' : 'roundtrip-bad:' + back;
        } catch (e) { bridge = 'error: ' + e; }
        return JSON.stringify({ cols, days, hol, pads, head, bridge,
          tauriDetected: document.body.classList.contains('in-tauri'),
          title: document.title, errors: window.__lzpErrors || [] });
        """
        webView.callAsyncJavaScript(probe, in: nil, in: .page) { [weak self] result in
            switch result {
            case .success(let v): print("SMOKE \(v)")
            case .failure(let e): print("SMOKE FAILED \(e)")
            }
            // 22.4 (LZP-103) — the App menu is the quiet hint's other half, and
            // an NSMenu cannot be read from JavaScript. Dumping it here is the
            // only way to verify without a screen that the hint item appears
            // only when something is staged, that it is absent otherwise, and
            // that both it and „Auf Updates prüfen …“ follow 13.7's language
            // switch. Diagnostic output on a `--smoke` run only.
            if let self {
                let dump = { (NSApp.mainMenu?.items.first?.submenu?.items ?? []).map { $0.title } }
                for lang in ["de", "en"] {
                    self.menuLang = lang
                    self.updateHintVersion = nil
                    NSApp.mainMenu = self.buildMenu()
                    print("SMOKE MENU \(lang) quiet \(dump())")
                    self.updateHintVersion = "1.1.0"
                    NSApp.mainMenu = self.buildMenu()
                    print("SMOKE MENU \(lang) staged \(dump())")
                }
            }
            NSApp.terminate(nil)
        }
    }

    // ── --test: a real-browser assertion runner ──────────────────────────────
    //
    // `LangzeitPlaner --test <file.js>` boots the identical board in the same
    // WKWebView the shipping app uses, evaluates <file.js> against the LIVE
    // DOM, prints TAP 13 and exits 0/1. Storage is redirected to a scratch dir
    // (see resolveScratchDir) so nothing a test does can reach the real board.
    //
    // Test files are plain scripts, NOT modules — they are spliced into an
    // async function body, so top-level `await` works but `import` statements
    // and top-level `return` do not. Use `await importApp('layout.js')` to
    // reach a real ES module from inside the page.

    /// Globals a DOM test file may use. Kept small on purpose: the value of
    /// tier 2 is the real engine, not a large bespoke API.
    private static let harnessJS = """
    const __tests = [];
    const test = (name, fn) => { __tests.push({ name, fn }); };
    // A test may stand down when the thing it characterizes is genuinely not
    // present in this run — the bundled Schulferien table expiring is the only
    // real case. It must NOT then print a bare `ok`: a suite that silently
    // stops testing something is exactly the failure mode this suite exists to
    // prevent. skip() reports TAP `# SKIP`, which is visible in the output and
    // counted separately by run-dom-tests.sh.
    class SkipSignal extends Error {}
    const skip = (reason) => { throw new SkipSignal(reason || 'no reason given'); };
    // Every assert() bumps this. A test that finishes having asserted nothing
    // is reported as `not ok` — see the runner below.
    let __asserts = 0;
    // Anything a test wants on stdout. Printed as TAP `#` comments, which is
    // also where console.log inside the page is forwarded — WKWebView's console
    // otherwise goes nowhere a CI job can read.
    const __diag = [];
    const diag = (...a) => __diag.push(
      a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' '));
    console.log = (...a) => diag(...a);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const $  = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    /// Import one of the app's real ES modules, resolved against the bundle.
    const importApp = (p) => import(new URL('./src/js/' + p, location.href).href);
    async function waitFor(fn, { timeout = 4000, interval = 25, what = 'condition' } = {}) {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error('waitFor timed out: ' + what);
        await sleep(interval);
      }
    }
    const __show = (v) => {
      try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); }
      catch { return String(v); }
    };
    const __deep = (a, b) => {
      if (a === b) return true;
      if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every(k => __deep(a[k], b[k]));
    };
    class AssertionError extends Error {}
    const __assert = {
      ok(v, msg) { if (!v) throw new AssertionError(msg || ('expected truthy, got ' + __show(v))); },
      equal(a, b, msg) { if (a !== b) throw new AssertionError(msg || (__show(a) + ' !== ' + __show(b))); },
      notEqual(a, b, msg) { if (a === b) throw new AssertionError(msg || ('expected not ' + __show(b))); },
      deepEqual(a, b, msg) { if (!__deep(a, b)) throw new AssertionError(msg || (__show(a) + ' deep!== ' + __show(b))); },
      match(s, re, msg) { if (!re.test(String(s))) throw new AssertionError(msg || (__show(s) + ' does not match ' + re)); },
      includes(hay, needle, msg) {
        if (!(hay && hay.includes && hay.includes(needle)))
          throw new AssertionError(msg || (__show(hay) + ' does not include ' + __show(needle)));
      },
      fail(msg) { throw new AssertionError(msg || 'failed'); },
    };
    // Same API, but every call is counted so the runner can catch a test body
    // that asserted nothing at all.
    const assert = Object.fromEntries(Object.entries(__assert).map(([k, fn]) =>
      [k, (...a) => { __asserts++; return fn(...a); }]));
    // boot() awaits store.init(), which awaits a bridge round-trip, so the
    // board is not on screen yet when the navigation finishes.
    await waitFor(() => document.querySelector('.board .col'),
                  { timeout: 8000, what: 'the board to render' });
    """

    private static let runnerJS = """
    const __results = [];
    for (const t of __tests) {
      const t0 = Date.now();
      const __before = __asserts;
      try {
        await t.fn();
        if (__asserts === __before) {
          // Green with nothing asserted is worse than red: it looks like
          // coverage and is not. Either assert something or skip() explicitly.
          __results.push({
            name: t.name, ok: false, ms: Date.now() - t0,
            error: 'VACUOUS: the test body ran to completion without asserting anything. '
                 + 'Assert something, or call skip(reason) to stand down visibly.',
            stack: '',
          });
        } else {
          __results.push({ name: t.name, ok: true, ms: Date.now() - t0,
                           asserts: __asserts - __before });
        }
      } catch (e) {
        if (e instanceof SkipSignal) {
          __results.push({ name: t.name, ok: true, skip: String(e.message),
                           ms: Date.now() - t0 });
        } else {
          __results.push({
            name: t.name, ok: false, ms: Date.now() - t0,
            error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)),
            stack: e && e.stack ? String(e.stack).split('\\n').slice(0, 6).join('\\n') : '',
          });
        }
      }
    }
    return JSON.stringify({ results: __results, diag: __diag,
                            pageErrors: window.__lzpErrors || [] });
    """

    private func runTestFile(_ webView: WKWebView) {
        guard let path = testFilePath else { return }
        guard let source = try? String(contentsOfFile: path, encoding: .utf8) else {
            print("Bail out! cannot read test file: \(path)")
            fflush(stdout)
            exit(2)
        }
        let name = (path as NSString).lastPathComponent
        let body = AppDelegate.harnessJS + "\n// ── \(name) ──\n" + source + "\n" + AppDelegate.runnerJS

        webView.callAsyncJavaScript(body, in: nil, in: .page) { result in
            var failed = 0
            var skipped = 0
            print("TAP version 13")
            print("# \(path)")
            print("# storage scratch: \(appSupportDir().path)")

            switch result {
            case .failure(let e):
                // A syntax error or a throw outside any test() — the whole file
                // is unrunnable, which TAP calls a bail-out.
                print("Bail out! \(name): \(e.localizedDescription)")
                failed = 1

            case .success(let value):
                guard
                    let json = value as? String,
                    let data = json.data(using: .utf8),
                    let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let results = top["results"] as? [[String: Any]]
                else {
                    print("Bail out! \(name): runner returned an unreadable payload")
                    failed = 1
                    break
                }

                for line in (top["diag"] as? [String] ?? []) {
                    for sub in line.split(separator: "\n", omittingEmptySubsequences: false) {
                        print("# \(sub)")
                    }
                }
                print("1..\(results.count)")
                for (i, r) in results.enumerated() {
                    let title = r["name"] as? String ?? "?"
                    let ms = r["ms"] as? Int ?? 0
                    if let reason = r["skip"] as? String {
                        skipped += 1
                        print("ok \(i + 1) - \(title) # SKIP \(reason)")
                    } else if r["ok"] as? Bool == true {
                        print("ok \(i + 1) - \(title) # \(ms)ms")
                    } else {
                        failed += 1
                        print("not ok \(i + 1) - \(title) # \(ms)ms")
                        print("  ---")
                        print("  message: \((r["error"] as? String ?? "").replacingOccurrences(of: "\n", with: " "))")
                        if let st = r["stack"] as? String, !st.isEmpty {
                            print("  stack: |")
                            for line in st.split(separator: "\n") { print("    \(line)") }
                        }
                        print("  ...")
                    }
                }
                // Uncaught page errors are a failure even if every assert
                // passed — v1 booting with an exception is a regression.
                if let errs = top["pageErrors"] as? [String], !errs.isEmpty {
                    failed += errs.count
                    for e in errs { print("not ok - uncaught page error: \(e)") }
                }
                let passed = results.filter { $0["ok"] as? Bool == true && $0["skip"] == nil }.count
                print("# pass \(passed)")
                print("# fail \(failed)")
                if skipped > 0 { print("# skip \(skipped)") }
            }
            fflush(stdout)
            exit(failed == 0 ? 0 : 1)
        }
    }

    // 11.1 — a quit must not race the 700 ms save debounce. Ask the page to
    // flush, then quit; a 2 s watchdog keeps a hung page from blocking ⌘Q.
    private var terminateReplied = false
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        terminateReplied = false
        let replyOnce: () -> Void = { [weak self] in
            guard let self, !self.terminateReplied else { return }
            self.terminateReplied = true
            sender.reply(toApplicationShouldTerminate: true)
        }
        webView.callAsyncJavaScript(
            "if (window.__lzpFlush) { await window.__lzpFlush(); } return true;",
            in: nil, in: .page) { _ in replyOnce() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { replyOnce() }
        return .terminateLater
    }

    // 13.5 — ⌘W and the red button hide; the app keeps running.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    // ── menu ─────────────────────────────────────────────────────────────────

    // 13.7 — the menu bar is UI too; it follows the language setting via the
    // 'language' shell pref rather than staying hard-coded German.
    var menuLang = "de"
    private func L(_ de: String, _ en: String) -> String { menuLang == "en" ? en : de }

    /// 22.4 — the staged version, or nil. `nil` is the normal state and the item
    /// simply does not exist then: no greyed-out row, no "no updates available"
    /// to click. The menu shows the update or shows nothing about updates.
    var updateHintVersion: String?

    @objc func emitMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        let escaped = id.replacingOccurrences(of: "'", with: "\\'")
        webView.evaluateJavaScript("window.__lzpEmit('menu', '\(escaped)')")
    }

    /// 12.4 — the real macOS print dialog, so "Als PDF sichern", paper size and
    /// scale-to-fit come free. The page builds its print header/legend first.
    @objc func printBoard(_ sender: Any?) {
        webView.evaluateJavaScript("window.dispatchEvent(new Event('beforeprint'))") { [weak self] _, _ in
            guard let self else { return }
            let info = NSPrintInfo.shared.copy() as! NSPrintInfo
            info.orientation = .landscape
            info.topMargin = 12; info.bottomMargin = 12
            info.leftMargin = 12; info.rightMargin = 12
            info.isHorizontallyCentered = true
            info.isVerticallyCentered = false
            info.horizontalPagination = .fit
            info.verticalPagination = .fit
            let op = self.webView.printOperation(with: info)
            // WKWebView quirk: without an explicit frame on the print view the
            // operation renders a blank page.
            op.view?.frame = NSRect(origin: .zero, size: info.paperSize)
            op.showsPrintPanel = true
            op.showsProgressPanel = true
            op.runModal(for: self.window, delegate: nil, didRun: nil, contextInfo: nil)
        }
    }

    @objc func hideWindow(_ sender: Any?) { window.orderOut(nil) }

    private func item(_ title: String, _ id: String, _ key: String,
                      _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: #selector(emitMenu(_:)), keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        it.representedObject = id
        it.target = self
        return it
    }

    private func buildMenu() -> NSMenu {
        let root = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L("Über LangzeitPlaner", "About LangzeitPlaner"),
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        // ── 22.4 · the quiet hint, half one ──────────────────────────────────
        // The hint item exists ONLY while a verified build is staged, and it is
        // the whole announcement: no modal, no toast, no dock badge, no red
        // anything. If the user never opens this menu they still get the update
        // — quitting applies it. Placed where macOS users look for it (directly
        // under About), and above „Auf Updates prüfen …“ so the answer sits
        // above the question.
        if let v = updateHintVersion {
            appMenu.addItem(item(L("Update verfügbar (\(v)) — neu starten",
                                   "Update available (\(v)) — Restart"), "update-restart", ""))
        }
        appMenu.addItem(item(L("Auf Updates prüfen …", "Check for Updates …"), "check-updates", ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item(L("Einstellungen …", "Settings …"), "settings", ","))
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L("LangzeitPlaner ausblenden", "Hide LangzeitPlaner"),
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: L("Beenden", "Quit LangzeitPlaner"),
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        root.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: L("Ablage", "File"))
        fileMenu.addItem(item(L("Exportieren …", "Export …"), "export", "e", [.command, .shift]))
        fileMenu.addItem(item(L("Importieren …", "Import …"), "import", "i", [.command, .shift]))
        fileMenu.addItem(.separator())
        let printItem = NSMenuItem(title: L("Drucken …", "Print …"),
                                   action: #selector(printBoard(_:)), keyEquivalent: "p")
        printItem.target = self
        fileMenu.addItem(printItem)
        fileMenu.addItem(.separator())
        let closeItem = NSMenuItem(title: L("Fenster schließen", "Close Window"),
                                   action: #selector(hideWindow(_:)), keyEquivalent: "w")
        closeItem.target = self
        fileMenu.addItem(closeItem)
        fileItem.submenu = fileMenu
        root.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: L("Bearbeiten", "Edit"))
        editMenu.addItem(item(L("Widerrufen", "Undo"), "undo", "z"))
        editMenu.addItem(item(L("Wiederholen", "Redo"), "redo", "z", [.command, .shift]))
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: L("Ausschneiden", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: L("Kopieren", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: L("Einsetzen", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: L("Alles auswählen", "Select All"),
                         action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        editMenu.addItem(item(L("Suchen", "Find"), "find", "f"))
        editItem.submenu = editMenu
        root.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: L("Darstellung", "View"))
        viewMenu.addItem(item(L("Heute", "Today"), "today", "t"))
        viewMenu.addItem(.separator())
        viewMenu.addItem(item(L("Feiertage", "Public Holidays"), "layer-feiertage", "1"))
        viewMenu.addItem(item(L("Schulferien", "School Holidays"), "layer-ferien", "2"))
        viewMenu.addItem(.separator())
        viewMenu.addItem(item(L("Modus rollierend / fixiert", "Mode: rolling / pinned"), "mode-toggle", ""))
        viewItem.submenu = viewMenu
        root.addItem(viewItem)

        // §9 — "Fenster/Hilfe: standard". Registering it as NSApp.windowsMenu
        // gets the system-managed window list for free.
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: L("Fenster", "Window"))
        windowMenu.addItem(withTitle: L("Im Dock ablegen", "Minimize"),
                           action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: L("Zoomen", "Zoom"),
                           action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: L("Alle nach vorne bringen", "Bring All to Front"),
                           action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        root.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        return root
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// --updater-selftest <dir> — the LZP-102 evidence run
// ═══════════════════════════════════════════════════════════════════════════
//
// Tier 1 covers the updater's decisions; tier 2 drives the board in WebKit.
// Neither can prove the two things that only exist in Swift: that a bad
// signature installs NOTHING, and that a good one really does swap a bundle.
// This mode does, against a scratch directory, using the shipping code paths —
// `verifyArtifact` and `applyStagedUpdate` are the same functions the bridge
// commands call.
//
// It is not wired into `tests/run-dom-tests.sh` on purpose: that runner builds
// the app and launches it once per `tests/tier2/*.dom.js` file with no extra
// flags, and this mode needs a key on the command line. Run it with
// `./shell-macos/updater-selftest.sh`, which also generates cross-implementation
// vectors (signed by Node's `crypto`, verified here) so the format check is not
// CryptoKit marking its own homework.

func runUpdaterSelftest(_ dirPath: String) -> Never {
    let fm = FileManager.default
    let work = URL(fileURLWithPath: (dirPath as NSString).expandingTildeInPath, isDirectory: true)
    try? fm.createDirectory(at: work, withIntermediateDirectories: true)

    var n = 0
    var failed = 0
    var lines: [String] = []
    func ok(_ cond: Bool, _ name: String, _ detail: String = "") {
        n += 1
        if cond {
            lines.append("ok \(n) - \(name)")
        } else {
            failed += 1
            lines.append("not ok \(n) - \(name)")
            if !detail.isEmpty { lines.append("  ---\n  message: \(detail)\n  ...") }
        }
    }

    // ── fixtures ─────────────────────────────────────────────────────────────
    let priv = Curve25519.Signing.PrivateKey()
    let pubB64 = priv.publicKey.rawRepresentation.base64EncodedString()
    let otherPubB64 = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()

    /// A minimal but structurally real .app: the apply path insists on
    /// `Contents/MacOS/<something>`, so a tarball of anything else must fail.
    func makeBundle(at parent: URL, marker: String) -> URL {
        let appURL = parent.appendingPathComponent("LangzeitPlaner.app", isDirectory: true)
        let macos = appURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try? fm.createDirectory(at: macos, withIntermediateDirectories: true)
        try? marker.write(to: macos.appendingPathComponent("LangzeitPlaner"),
                          atomically: true, encoding: .utf8)
        try? "<plist/>".write(to: appURL.appendingPathComponent("Contents/Info.plist"),
                              atomically: true, encoding: .utf8)
        return appURL
    }
    func markerOf(_ appURL: URL) -> String {
        (try? String(contentsOf: appURL.appendingPathComponent("Contents/MacOS/LangzeitPlaner"),
                     encoding: .utf8)) ?? "<missing>"
    }
    func tar(_ dir: URL, _ member: String, to out: URL) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        p.arguments = ["-czf", out.path, "-C", dir.path, member]
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    let newDir = work.appendingPathComponent("new", isDirectory: true)
    try? fm.createDirectory(at: newDir, withIntermediateDirectories: true)
    _ = makeBundle(at: newDir, marker: "NEW-BUILD")
    let artifact = work.appendingPathComponent("artifact.tar.gz")
    guard tar(newDir, "LangzeitPlaner.app", to: artifact),
          let artifactBytes = try? Data(contentsOf: artifact) else {
        print("Bail out! could not build the test artifact")
        exit(2)
    }
    let goodSig = ((try? priv.signature(for: artifactBytes)) ?? Data()).base64EncodedString()

    // ── 1 · verification ─────────────────────────────────────────────────────
    if case .success = verifyArtifact(artifactBytes, signature: goodSig, publicKey: pubB64) {
        ok(true, "a genuine artifact verifies against the updater key")
    } else {
        ok(false, "a genuine artifact verifies against the updater key")
    }

    var tampered = artifactBytes
    tampered[tampered.count / 2] ^= 0xFF
    ok({ if case .failure(.signature) = verifyArtifact(tampered, signature: goodSig, publicKey: pubB64) { return true }; return false }(),
       "one flipped byte in the artifact fails verification")

    var sigBytes = Data(base64Encoded: goodSig)!
    sigBytes[10] ^= 0x01
    ok({ if case .failure(.signature) = verifyArtifact(artifactBytes, signature: sigBytes.base64EncodedString(), publicKey: pubB64) { return true }; return false }(),
       "one flipped byte in the signature fails verification")

    ok({ if case .failure(.signature) = verifyArtifact(artifactBytes, signature: goodSig, publicKey: otherPubB64) { return true }; return false }(),
       "a signature from a DIFFERENT key is refused")

    ok({ if case .failure(.noKey) = verifyArtifact(artifactBytes, signature: goodSig, publicKey: "") { return true }; return false }(),
       "no updater key configured means no install is possible at all")

    ok({ if case .failure(.badSignatureFormat) = verifyArtifact(artifactBytes, signature: "not base64 at all !!", publicKey: pubB64) { return true }; return false }(),
       "a signature that is not a signature is refused as a format error")

    // minisign container: 2-byte algorithm + 8-byte key id + 64-byte signature,
    // wrapped in the .sig text file, base64'd — the shape a Tauri manifest carries.
    var mini = Data("Ed".utf8)
    mini.append(Data(repeating: 0x11, count: 8))
    mini.append(Data(base64Encoded: goodSig)!)
    let miniFile = "untrusted comment: signature from LangzeitPlaner\n\(mini.base64EncodedString())\ntrusted comment: x\n"
    let miniWrapped = Data(miniFile.utf8).base64EncodedString()
    if case .success = verifyArtifact(artifactBytes, signature: miniWrapped, publicKey: pubB64) {
        ok(true, "a base64-wrapped minisign container (algorithm Ed) verifies")
    } else {
        ok(false, "a base64-wrapped minisign container (algorithm Ed) verifies")
    }
    if case .success = verifyArtifact(artifactBytes, signature: miniFile, publicKey: pubB64) {
        ok(true, "an unwrapped minisign .sig text also verifies")
    } else {
        ok(false, "an unwrapped minisign .sig text also verifies")
    }

    var pre = Data("ED".utf8)
    pre.append(Data(repeating: 0x11, count: 8))
    pre.append(Data(base64Encoded: goodSig)!)
    let preFile = "untrusted comment: x\n\(pre.base64EncodedString())\n"
    ok({ if case .failure(.prehashedUnsupported) = verifyArtifact(artifactBytes, signature: Data(preFile.utf8).base64EncodedString(), publicKey: pubB64) { return true }; return false }(),
       "a PREHASHED minisign signature is refused loudly, not mis-verified")

    // a minisign public key line (2 + 8 + 32 bytes) is accepted as well as a raw one
    var miniPub = Data("Ed".utf8)
    miniPub.append(Data(repeating: 0x11, count: 8))
    miniPub.append(priv.publicKey.rawRepresentation)
    if case .success = verifyArtifact(artifactBytes, signature: goodSig,
                                      publicKey: "untrusted comment: minisign public key\n\(miniPub.base64EncodedString())\n") {
        ok(true, "a minisign public-key line is accepted as the updater key")
    } else {
        ok(false, "a minisign public-key line is accepted as the updater key")
    }

    // ── 2 · cross-implementation vectors (Node signed these, not CryptoKit) ──
    let xPub = work.appendingPathComponent("crosscheck-pubkey.txt")
    let xPay = work.appendingPathComponent("crosscheck-payload.bin")
    let xSig = work.appendingPathComponent("crosscheck-sig.txt")
    if let pk = try? String(contentsOf: xPub, encoding: .utf8),
       let payload = try? Data(contentsOf: xPay),
       let sg = try? String(contentsOf: xSig, encoding: .utf8) {
        if case .success = verifyArtifact(payload, signature: sg, publicKey: pk) {
            ok(true, "a signature produced by node:crypto verifies here (cross-implementation)")
        } else {
            ok(false, "a signature produced by node:crypto verifies here (cross-implementation)")
        }
        var badPayload = payload
        badPayload[0] ^= 0xFF
        ok({ if case .failure(.signature) = verifyArtifact(badPayload, signature: sg, publicKey: pk) { return true }; return false }(),
           "the node:crypto vector fails once the payload is edited")
    } else {
        lines.append("# no cross-check vectors in \(work.path) — run via shell-macos/updater-selftest.sh")
    }

    // ── 3 · apply: the part that must install NOTHING when verification fails ─
    let installedDir = work.appendingPathComponent("installed", isDirectory: true)
    try? fm.createDirectory(at: installedDir, withIntermediateDirectories: true)
    let installed = makeBundle(at: installedDir, marker: "OLD-BUILD")

    let poison = work.appendingPathComponent("poison.tar.gz")
    try? fm.removeItem(at: poison)
    try? tampered.write(to: poison)
    let badApply = applyStagedUpdate(artifact: poison, signature: goodSig,
                                     publicKey: pubB64, installedApp: installed)
    ok({ if case .failure = badApply { return true }; return false }(),
       "apply refuses an artifact whose signature does not verify")
    ok(markerOf(installed) == "OLD-BUILD",
       "AN UPDATE THAT FAILS VERIFICATION INSTALLS NOTHING — the bundle is untouched",
       "marker is now \(markerOf(installed))")
    ok(!fm.fileExists(atPath: poison.path),
       "the rejected artifact is deleted rather than retried")

    // a tarball that unpacks to something that is not an app is refused too
    let junkDir = work.appendingPathComponent("junk", isDirectory: true)
    try? fm.createDirectory(at: junkDir, withIntermediateDirectories: true)
    try? "hello".write(to: junkDir.appendingPathComponent("README.txt"), atomically: true, encoding: .utf8)
    let junkTar = work.appendingPathComponent("junk.tar.gz")
    _ = tar(junkDir, "README.txt", to: junkTar)
    if let junkBytes = try? Data(contentsOf: junkTar) {
        let junkSig = ((try? priv.signature(for: junkBytes)) ?? Data()).base64EncodedString()
        let r = applyStagedUpdate(artifact: junkTar, signature: junkSig,
                                  publicKey: pubB64, installedApp: installed)
        ok({ if case .failure(.notAnApp) = r { return true }; return false }(),
           "a correctly signed archive that is not an .app is still refused")
        ok(markerOf(installed) == "OLD-BUILD", "…and it too installs nothing")
    }

    let goodApply = applyStagedUpdate(artifact: artifact, signature: goodSig,
                                      publicKey: pubB64, installedApp: installed)
    ok({ if case .success = goodApply { return true }; return false }(),
       "apply swaps the bundle when the signature verifies",
       "\(goodApply)")
    ok(markerOf(installed) == "NEW-BUILD",
       "the installed bundle really is the new build after the swap",
       "marker is \(markerOf(installed))")

    // ── 4 · the 21.5 gate, at the Swift layer ────────────────────────────────
    // updater.js refuses to reach the network before disclosure; so does this
    // side, because a bridge command is reachable from any page script and the
    // guarantee must not depend on the caller being polite.
    var prefs = UpdaterPrefs()
    prefs.disclosed = false
    prefs.enabled = true
    prefs.save()
    let sem = DispatchSemaphore(value: 0)
    var fetchReply = ""
    DispatchQueue.global().async {
        updaterFetchManifest { r in fetchReply = r; sem.signal() }
    }
    _ = sem.wait(timeout: .now() + 5)
    ok(fetchReply.contains("\"disabled\""),
       "the shell refuses to fetch a manifest before the first-run screen has disclosed it",
       fetchReply)

    prefs.disclosed = true
    prefs.enabled = false
    prefs.save()
    var reply2 = ""
    let sem2 = DispatchSemaphore(value: 0)
    DispatchQueue.global().async { updaterFetchManifest { r in reply2 = r; sem2.signal() } }
    _ = sem2.wait(timeout: .now() + 5)
    ok(reply2.contains("\"disabled\""), "…and refuses when the settings switch is off", reply2)

    prefs.enabled = true
    prefs.save()
    var reply3 = ""
    let sem3 = DispatchSemaphore(value: 0)
    DispatchQueue.global().async { updaterFetchManifest { r in reply3 = r; sem3.signal() } }
    _ = sem3.wait(timeout: .now() + 5)
    // Both gates open, but the release host is still a placeholder: it must
    // refuse rather than resolve some unrelated host that happens to answer.
    ok(reply3.contains("no-release-host"),
       "with both gates open it still refuses while the release host is a placeholder",
       reply3)

    // ── 5 · status JSON is the shape src/js/platform/updater.js expects ───────
    let status = updaterStatusJSON()
    if let d = status.data(using: .utf8),
       let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
        ok(o["enabled"] as? Bool == true && o["disclosed"] as? Bool == true,
           "update_status reports the two 21.5 gates", status)
        ok(o["channel"] as? String == UPDATE_CHANNEL && o["target"] as? String == UPDATE_TARGET,
           "update_status reports the single stable channel (22.5)", status)
        ok(o.keys.contains("currentVersion") && o.keys.contains("lastCheckAt")
            && o.keys.contains("stagedVersion"),
           "update_status carries every member the JS port reads", status)
    } else {
        ok(false, "update_status is valid JSON", status)
    }

    print("TAP version 13")
    print("# updater selftest, scratch: \(work.path)")
    print("# bridge scratch: \(appSupportDir().path)")
    print("1..\(n)")
    for l in lines { print(l) }
    print("# pass \(n - failed)")
    print("# fail \(failed)")
    fflush(stdout)
    exit(failed == 0 ? 0 : 1)
}

if let dir = selftestDir { runUpdaterSelftest(dir) }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
