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
import Security

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
//   --sync-origin <origin>  LZP-1002: the ONE origin `sync_request` may address in a
//                           headless run. Gated on isHeadless exactly like
//                           --updater-manifest-url, and it is the only way a loopback
//                           origin (node server/dev-server.mjs) is ever reachable.
//                           Absent — which is every normal launch — means no origin is
//                           configured and every sync_request is refused locally.
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

// ── LZP-1002 · `sync_request` — THE SHELL IS THE TRANSPORT (ADR 003 §7 gate 3) ────────────────
//
// `src/js/platform/net.js` §6 publishes the contract and `chooseTransport()` picks the BRIDGE
// whenever a shell `invoke` exists — which, inside this app, is always. Until this section
// existed the command it named was implemented by neither shell, so every family feature that
// "passed" had passed on `createFetchTransport` in a browser. This is that gap, closed.
//
//   sync_request({ url, method, headers, body })
//       → { status: Int, headers: {…lower-cased…}, body: String, url: String, redirected: false }
//       → { error: "offline" | "timeout" | "blocked" | "transport", reason: String }
//
// The reply is a DICTIONARY, not the JSON string the four updater commands use. That is not
// drift: `createBridgeTransport` reads `reply.status` / `reply.headers` / `reply.body` off an
// object, and the Tauri half returns a `serde_json::Value` object for the same reason. One
// contract, two shells, and it is net.js §6 that is the contract.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS THE MOST DANGEROUS FUNCTION IN THE SHELL, AND WHAT MAKES IT SAFE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A bridge command that accepted an arbitrary URL from the web view would be an **SSRF
// primitive**: page script — or anything that ever gets to run as page script — could reach the
// user's router at `http://192.168.1.1/`, a `localhost` admin port, `169.254.169.254`, an
// `smb://` share, a `file://` path, or any origin at all, FROM A NATIVE PROCESS and therefore
// outside every rule the WebView applies to itself (the CSP, the navigation delegate, the
// custom-scheme sandbox). The web view is the least trusted part of this system: it renders the
// user's own text, it is where a future XSS lands, and it is the only part an attacker who has
// nothing else can already influence.
//
// So the shell **PINS the origin; it does not accept one.** The web view may name a PATH. It
// cannot name a host, a scheme or a port — those come from shell configuration, and the request
// is rebuilt from the pinned origin rather than from the string the page sent. There is no
// argument to this command that changes WHERE it goes.
//
// The rest, in the order the checks run:
//
//   1. `sync_enabled` must be on. It is a shell pref, defaulting to FALSE, written only by
//      `set_shell_pref` at the family opt-in moment — ADR 003 §7 gate 3's own switch.
//   2. An origin must be configured, and it must be `https:` to a public DNS name. No IP
//      literal of ANY kind (which is a superset of "no private ranges" — 10/8, 172.16/12,
//      192.168/16, 127/8, 169.254/16, 100.64/10 and every IPv6 literal are refused by the same
//      rule), no `.local`/`.lan`/`.internal`/`.home.arpa`, no single-label LAN name, no
//      loopback — **even if configuration named one.**
//   3. The URL the page sent must re-serialise, byte for byte, to `pinned + path + ?query`.
//      A path is `/api/v1/…` in the narrow shape `PATH_RE` allows and nothing else.
//   4. GET or POST. Headers off a four-name allowlist, printable-ASCII values only, so the page
//      cannot smuggle a `Cookie`, a `Host` or a header-injection newline.
//   5. A 4 MiB request cap and an 8 MiB response cap, both enforced as the bytes move.
//   6. No redirect is followed — `willPerformHTTPRedirection` answers `nil` and the reply is
//      `blocked`. `URLSession` follows redirects by default; refusing takes this delegate. This
//      is FINDING P-5's shell half: a signed request replayed at a destination the relay chose
//      is exactly what "nothing else may be reachable" has to prevent, and the reply carries the
//      final URL so `createBridgeTransport` can check it rather than trust this comment.
//   7. An ephemeral session with no cookie jar, no credential storage and no cache. This
//      transport carries a signed request and NOTHING ambient.
//
// **SOLO MODE MAKES ZERO REQUESTS, AND THAT IS A PROPERTY OF THE ORDER ABOVE.** Steps 1 and 2
// are pure, local and cheap; no `URLSession` object exists until step 7. With `sync_enabled` off
// — or with no origin configured, which is every build shipped so far — this command refuses
// without a socket, without a DNS lookup, and without allocating a session.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ADR IS WRONG HERE, AND THIS IS THE AMENDMENT (ADR 003 §7 gate 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// §7 gate 3 reads: *"`WKNavigationDelegate` / `WKURLSchemeHandler` … rejects every request whose
// scheme is not `app://` unless the shell has been told (`set_shell_pref: "sync_enabled"`) that
// a space exists — **and then permits exactly the one sync origin**."*
//
// The second half is a **loosening, and it must not be built.** The page does not open the
// socket — net.js's header works that out in full and lands on "the native shell process
// performs the request; the page does not", which is why the CSP diff for family mode is empty.
// Opening the navigation delegate to the relay origin would therefore buy nothing and cost the
// one gate that survives a JS bug: it would let page script navigate to, and pull subresources
// from, a remote host — the precise thing `default-src 'self'` plus this delegate exist to stop,
// and it would do it in the ONE state (family mode) where the machine has something to leak.
//
// So gate 3 as built is: **the navigation delegate stays shut — `app://` and `about:`, forever
// — and the pinned-origin bridge command below is the gate.** `sync_enabled` is real and is
// this section's first check. `docs/v2/adr/003-sync-protocol.md` §7 is amended to match.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES NOT DEFEND AGAINST, STATED RATHER THAN IMPLIED
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A configured DNS NAME that RESOLVES to a private address (`relay.example.org → 10.0.0.5`) is
// not caught: the checks are on the name, and pinning the resolved address would need a custom
// resolver and would still race the one `URLSession` performs. The exposure is bounded by who
// chooses the name — it is shell configuration, never a page parameter, so reaching it requires
// control of the build, at which point the relay is already the attacker's. Recorded, not fixed.

/// PLACEHOLDER, and it is checked at runtime rather than hoped about. ADR 003 §1 names
/// `https://<vercel-app>.vercel.app`; no such app exists (net.js's CSP note, reason 2: "there is
/// no host to allowlist"). Empty means every `sync_request` is refused locally — which is the
/// correct behaviour for a build with nowhere to sync to, and it is why `--sync-origin` below
/// exists for the headless suites.
let SYNC_ORIGIN_BUILTIN = ""

let SYNC_PREFS_FILE = "sync.json"

/// EVERY path this command may address, mirroring `net.js`'s `PATH_PREFIX`/`PATH_RE`.
let SYNC_PATH_PREFIX = "/api/v1/"

/// `net.js`'s `DEFAULT_TIMEOUT_MS`. A request that has not answered in this long is a failure,
/// not a hang — ADR 003 §8.2's backoff counts a timeout as a transport error.
let SYNC_TIMEOUT_SECONDS: TimeInterval = 15

/// `net.js`'s `MAX_REQUEST_BYTES` (ADR 003 §6.1). The server refuses a larger body, the client
/// refuses to build one, and the shell refuses to carry one.
let SYNC_MAX_REQUEST_BYTES = 4 * 1024 * 1024

/// A pull of 500 envelopes is the largest honest answer (ADR 003 §3.2). 8 MiB is headroom and
/// still a bound: without one, a hostile or broken relay decides how much memory this process
/// allocates.
let SYNC_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/// The FIVE headers `buildRequest` emits, and nothing else may be set by the page. `Cookie`,
/// `Host`, `Origin`, `Referer` and every `X-Forwarded-*` are absent from this list on purpose.
let SYNC_HEADER_ALLOWLIST: Set<String> = [
    "x-lzp-protocol", "x-lzp-client", "authorization", "content-type",
]

let SYNC_MAX_HEADER_VALUE_BYTES = 8 * 1024

/// Every local refusal, named. All of them reach JavaScript as `error: "blocked"` — the only
/// vocabulary `createBridgeTransport` accepts — with the name as `reason`, so a test and a
/// human can tell which rule fired without the page being able to branch on it.
enum SyncRefusal: String, Error {
    case syncDisabled          = "sync_disabled"
    case noOriginConfigured    = "no_origin_configured"
    case originNotHttps        = "origin_is_not_https"
    case originIsLocal         = "origin_host_is_local_private_or_an_ip_literal"
    case originShape           = "origin_is_not_scheme_host_port"
    case urlUnparsable         = "url_did_not_parse"
    case urlOffOrigin          = "url_is_not_the_pinned_origin"
    case urlPath               = "url_path_is_not_an_api_v1_path"
    case urlQuery              = "url_query_carries_forbidden_characters"
    case urlFragment           = "url_carries_a_fragment"
    case urlNotCanonical       = "url_is_not_the_canonical_rebuild"
    case badMethod             = "method_is_neither_get_nor_post"
    case headerNotAllowed      = "header_is_not_on_the_allowlist"
    case headerValue           = "header_value_is_not_printable_ascii"
    case bodyOnGet             = "a_get_carries_no_body"
    case requestTooLarge       = "request_body_exceeds_the_cap"
}

/// The sync switch, ADR 003 §7 gate 3. Deliberately NOT in board.json and not in updater.json:
/// one file, one question, and `dataFile()` routes it through the headless scratch guard like
/// everything else. Defaults to FALSE — a fresh install is solo, and solo makes zero requests.
struct SyncPrefs {
    var enabled = false

    static func load() -> SyncPrefs {
        var p = SyncPrefs()
        guard let txt = readIfExists(dataFile(SYNC_PREFS_FILE)),
              let d = txt.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        else { return p }
        if let v = o["enabled"] as? Bool { p.enabled = v }
        return p
    }

    func save() {
        let o: [String: Any] = ["enabled": enabled]
        if let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted]),
           let s = String(data: d, encoding: .utf8) {
            try? writeAtomic(dataFile(SYNC_PREFS_FILE), s)
        }
    }
}

/// The configured origin, and the ONE headless override — gated exactly like
/// `--updater-manifest-url`, and for the same reason. `tests/run-dom-tests.sh` does not pass it,
/// so the ordinary tier-2 run exercises the REFUSAL path; the end-to-end run against
/// `node server/dev-server.mjs` passes `--sync-origin http://127.0.0.1:8787` and is the only way
/// a loopback origin is ever reachable. A production build that honoured this flag would let
/// anything that can start the app choose where the board is sent.
func syncOriginSetting() -> String {
    if isHeadless, let o = argValue("--sync-origin") { return o }
    // The same override as an environment variable, gated identically. `tests/run-dom-tests.sh`
    // owns its own command line and passes no sync flags, but it INHERITS the environment — so
    // `LZP_SYNC_ORIGIN=http://127.0.0.1:8787 npm run test:dom` runs the whole tier-2 suite,
    // §3 red team and §4 round trip included, with no edit to any script.
    if isHeadless, let e = ProcessInfo.processInfo.environment["LZP_SYNC_ORIGIN"], !e.isEmpty {
        return e
    }
    return SYNC_ORIGIN_BUILTIN
}

/// Is this host THIS MACHINE? The Swift half of `net.js`'s `isLoopbackHost`, written over a
/// `URLComponents.host` rather than a raw string for the same reason: the parser has already
/// lower-cased it, punycoded any unicode and bracketed an IPv6 literal, so a remote host cannot
/// be dressed as a loopback one by spelling it differently.
///
/// `127.0.0.0/8` and not `127.0.0.1` alone: the whole /8 is loopback and `node
/// server/dev-server.mjs` may bind anywhere in it. `*.localhost` because RFC 6761 §6.3 reserves
/// the whole name.
func isLoopbackSyncHost(_ hostname: String) -> Bool {
    let h = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if h == "localhost" || h.hasSuffix(".localhost") { return true }
    if h == "::1" || h == "0:0:0:0:0:0:0:1" { return true }
    let parts = h.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4, parts[0] == "127" else { return false }
    return parts.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isNumber) && (Int($0) ?? 999) <= 255 }
}

/// Is this host on this machine, this LAN, or otherwise not a public relay?
///
/// Written over a `URLComponents.host` — already lower-cased by the parser for ASCII and
/// punycoded for unicode — and deliberately BLUNT: every IP literal is refused, v4 and v6 alike,
/// rather than a list of private ranges that has to stay complete. `10.0.0.1`, `192.168.1.1`,
/// `172.20.0.1`, `169.254.169.254`, `100.64.0.1`, `127.0.0.1`, `[::1]`, `[fd00::1]` and a
/// perfectly public `93.184.216.34` all fail the same way, because a relay is a NAME and an
/// origin spelled as an address is a misconfiguration whichever address it is.
func isPrivateOrLocalSyncHost(_ host: String) -> Bool {
    let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if h.isEmpty { return true }
    if isLoopbackSyncHost(host) { return true }
    // Any IPv6 literal — `::1`, `fe80::…` (link-local), `fc00::/7` (unique-local) and the rest.
    if h.contains(":") { return true }
    // Any IPv4 literal.
    let parts = h.split(separator: ".", omittingEmptySubsequences: false)
    if parts.count == 4 && parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) { return true }
    // mDNS and the reserved LAN suffixes, plus any single-label name — `router`, `nas`, `printer`
    // resolve on the local network and nowhere else.
    for suffix in [".local", ".localhost", ".lan", ".internal", ".home.arpa", ".intranet"] {
        if h.hasSuffix(suffix) { return true }
    }
    if !h.contains(".") { return true }
    if h.hasSuffix(".") { return true }   // an FQDN's trailing dot would not compare equal
    return false
}

/// Normalise the CONFIGURED origin to `scheme://host[:port]`, or say which rule refused it.
///
/// The single exception is a headless run with `--sync-origin` at a loopback host over `http:`
/// — `node server/dev-server.mjs`, which binds loopback only and is where the end-to-end
/// demonstration runs. `net.js`'s `normalizeOrigin` carves the same hole for the same host for
/// the same reason (finding P-7: "a loopback host is this Mac talking to itself, there is no
/// wire to tap"), and here it is narrower still, because it is unreachable in a normal launch.
func normalizeSyncOrigin(_ raw: String) -> Result<String, SyncRefusal> {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return .failure(.noOriginConfigured) }
    guard let c = URLComponents(string: trimmed),
          let schemeRaw = c.scheme, let hostRaw = c.host, !hostRaw.isEmpty
    else { return .failure(.originShape) }
    guard c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
          c.path.isEmpty || c.path == "/"
    else { return .failure(.originShape) }

    let scheme = schemeRaw.lowercased()
    let host = hostRaw.lowercased()
    let devLoopback = isHeadless && scheme == "http" && isLoopbackSyncHost(host)
    if !devLoopback {
        guard scheme == "https" else { return .failure(.originNotHttps) }
        guard !isPrivateOrLocalSyncHost(host) else { return .failure(.originIsLocal) }
    }
    let port = c.port.map { ":\($0)" } ?? ""
    return .success("\(scheme)://\(host)\(port)")
}

/// The pinned origin for this run, or the refusal that stands in its place.
func pinnedSyncOrigin() -> Result<String, SyncRefusal> {
    normalizeSyncOrigin(syncOriginSetting())
}

/// `net.js`'s `PATH_RE`, hand-rolled: `/api/v1` followed by one or more segments of
/// `[A-Za-z0-9._~-]` that do not begin with a dot. Nothing here can carry a scheme, a host, a
/// `..`, a query or a fragment.
func syncPathIsWellFormed(_ path: String) -> Bool {
    guard path.hasPrefix(SYNC_PATH_PREFIX), !path.contains("..") else { return false }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    // "" / "api" / "v1" / at least one more
    guard segments.count >= 4, segments[0].isEmpty, segments[1] == "api", segments[2] == "v1"
    else { return false }
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-")
    for seg in segments.dropFirst(3) {
        if seg.isEmpty || seg.hasPrefix(".") { return false }
        if !seg.allSatisfy({ allowed.contains($0) }) { return false }
    }
    return true
}

/// What `canonicalQuery()` can produce: `encodeURIComponent` output joined by `=` and `&`.
func syncQueryIsWellFormed(_ query: String) -> Bool {
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~!*'()%=&")
    return !query.isEmpty && query.allSatisfy { allowed.contains($0) }
}

/// The URL this request is allowed to have, rebuilt from the PINNED origin — never from the
/// string the page sent — and then required to equal that string byte for byte.
///
/// This is `assertReachable`'s discipline on the far side of the bridge: build it, and require
/// the thing that came in to be what would have been built. A page that sends
/// `https://relay.test@evil.example/api/v1/ops`, `https://relay.test:443/api/v1/ops` (when the
/// pin has no port), `HTTPS://RELAY.TEST/…`, a `//evil/` path, a `..`, a fragment or a
/// double-encoded segment does not get a "close enough" — it gets `blocked`.
func syncCanonicalURL(_ raw: String, pinned: String) -> Result<URL, SyncRefusal> {
    guard let c = URLComponents(string: raw), let schemeRaw = c.scheme, let hostRaw = c.host
    else { return .failure(.urlUnparsable) }
    guard c.user == nil, c.password == nil else { return .failure(.urlOffOrigin) }
    guard c.fragment == nil else { return .failure(.urlFragment) }

    let port = c.port.map { ":\($0)" } ?? ""
    let origin = "\(schemeRaw.lowercased())://\(hostRaw.lowercased())\(port)"
    guard origin == pinned else { return .failure(.urlOffOrigin) }

    let path = c.percentEncodedPath
    guard syncPathIsWellFormed(path) else { return .failure(.urlPath) }
    if let q = c.percentEncodedQuery, !syncQueryIsWellFormed(q) { return .failure(.urlQuery) }

    let rebuilt = pinned + path + (c.percentEncodedQuery.map { "?" + $0 } ?? "")
    guard rebuilt == raw, let url = URL(string: rebuilt) else { return .failure(.urlNotCanonical) }
    return .success(url)
}

/// Everything a `sync_request` is, decided before a socket exists.
struct SyncPlan {
    let request: URLRequest
    let url: String
}

/// The whole gate, in one pure function. Nothing here opens a socket, resolves a name or
/// allocates a `URLSession` — that is what makes "solo mode makes zero requests" a property of
/// the code rather than a promise about it, and it is why `syncPerform` below is unreachable
/// except through a `.success` from here.
func syncPreflight(_ args: [String: Any]) -> Result<SyncPlan, SyncRefusal> {
    // 1 — the switch. ADR 003 §7 gate 3.
    guard SyncPrefs.load().enabled else { return .failure(.syncDisabled) }
    // 2 — the pin. Configuration, never a parameter: there is no `args["origin"]` in this file.
    let pinned: String
    switch pinnedSyncOrigin() {
    case .failure(let why): return .failure(why)
    case .success(let o): pinned = o
    }
    // 3 — the address.
    guard let rawURL = args["url"] as? String else { return .failure(.urlUnparsable) }
    let url: URL
    switch syncCanonicalURL(rawURL, pinned: pinned) {
    case .failure(let why): return .failure(why)
    case .success(let u): url = u
    }
    // 4 — the method.
    let method = (args["method"] as? String ?? "").uppercased()
    guard method == "GET" || method == "POST" else { return .failure(.badMethod) }

    // 5 — the body.
    let bodyText = args["body"] as? String ?? ""
    if method == "GET" && !bodyText.isEmpty { return .failure(.bodyOnGet) }
    let bodyData = Data(bodyText.utf8)
    if bodyData.count > SYNC_MAX_REQUEST_BYTES { return .failure(.requestTooLarge) }

    var req = URLRequest(url: url)
    req.httpMethod = method
    // No cookies on the request, whatever the session might think it has.
    req.httpShouldHandleCookies = false

    // ── THE HEADERS URLSession ADDS FOR FREE, PINNED ─────────────────────────────────────────
    //
    // Measured against a loopback relay that echoes what it receives: `URLSession` adds
    // `User-Agent: LangzeitPlaner/1.0.0 CFNetwork/3860.700.1 Darwin/25.6.0` and
    // `Accept-Language: en-US,en;q=0.9` of its own accord. Neither is in ADR 003 §2, neither is
    // signed, and `docs/v2/server-metadata.md` §2/§5 does not list either — so the relay was
    // being told this Mac's macOS build and the user's LANGUAGE PREFERENCES on every single sync,
    // for free, from a transport whose whole claim is that it carries a signed request and
    // nothing ambient.
    //
    // The version already travels, once, in `X-LZP-Client`, where the protocol puts it. So the
    // agent is a constant and the language is `*` — "any", which is true and says nothing.
    // `Accept-Encoding` is deliberately LEFT ALONE: overriding it turns off URLSession's
    // transparent decompression, and a compressed body we then fail to decode is a worse bug than
    // the one byte of information it carries.
    req.setValue("LangzeitPlaner", forHTTPHeaderField: "User-Agent")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("*", forHTTPHeaderField: "Accept-Language")
    req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    req.timeoutInterval = SYNC_TIMEOUT_SECONDS
    if !bodyData.isEmpty { req.httpBody = bodyData }

    // 6 — the headers. Allowlisted by name, printable ASCII by value. A newline in a value is a
    // header-injection attempt and a `Cookie` is ambient authority; neither gets past this loop.
    for (k, v) in (args["headers"] as? [String: Any] ?? [:]) {
        let name = k.lowercased()
        guard SYNC_HEADER_ALLOWLIST.contains(name) else { return .failure(.headerNotAllowed) }
        guard let value = v as? String, !value.isEmpty,
              value.utf8.count <= SYNC_MAX_HEADER_VALUE_BYTES,
              value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value < 0x7F })
        else { return .failure(.headerValue) }
        req.setValue(value, forHTTPHeaderField: k)
    }
    return .success(SyncPlan(request: req, url: url.absoluteString))
}

/// One request's delegate: refuses redirects, caps the response as it arrives, and answers
/// exactly once.
///
/// `URLSession` follows redirects unless a delegate says otherwise — that is FINDING P-5's whole
/// mechanism, and the reason this class exists rather than a `dataTask(with:completionHandler:)`
/// one-liner. A 30x is not followed and not reported as an answer: it is `blocked`, because a
/// signed request replayed at a destination the relay chose is the attack.
final class SyncRequestDelegate: NSObject, URLSessionDataDelegate {
    private let expectedURL: String
    private let finish: ([String: Any]) -> Void
    private var buffer = Data()
    private var redirected = false
    private var overCap = false
    private var answered = false

    init(expectedURL: String, finish: @escaping ([String: Any]) -> Void) {
        self.expectedURL = expectedURL
        self.finish = finish
    }

    private func answer(_ o: [String: Any]) {
        guard !answered else { return }
        answered = true
        DispatchQueue.main.async { self.finish(o) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        redirected = true
        completionHandler(nil)   // do not follow. Not to another host, not to another path.
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if response.expectedContentLength > Int64(SYNC_MAX_RESPONSE_BYTES) {
            overCap = true
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if buffer.count + data.count > SYNC_MAX_RESPONSE_BYTES {
            overCap = true
            dataTask.cancel()
            return
        }
        buffer.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { session.finishTasksAndInvalidate() }

        if redirected {
            answer(["error": "blocked", "reason": "redirect_refused"])
            return
        }
        if overCap {
            answer(["error": "transport", "reason": "response_exceeds_the_cap"])
            return
        }
        if let error = error as? URLError {
            answer(["error": syncErrorKind(error), "reason": "urlerror_\(error.code.rawValue)",
                    "detail": error.localizedDescription])
            return
        }
        if let error = error {
            answer(["error": "transport", "reason": "unknown", "detail": error.localizedDescription])
            return
        }
        guard let http = task.response as? HTTPURLResponse else {
            answer(["error": "transport", "reason": "not_an_http_response"])
            return
        }
        // The bytes came from here. `createBridgeTransport` refuses a reply whose `url` is not
        // the one it asked for, so this field is the checkable half of "no redirects".
        let finalURL = http.url?.absoluteString ?? expectedURL
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            headers[String(describing: k).lowercased()] = String(describing: v)
        }
        guard let text = String(data: buffer, encoding: .utf8) else {
            answer(["error": "transport", "reason": "response_was_not_utf8"])
            return
        }
        answer([
            "status": http.statusCode,
            "headers": headers,
            "body": text,
            "url": finalURL,
            "redirected": false,
        ])
    }
}

/// A `URLError` in the vocabulary `createBridgeTransport` accepts. "Offline" and "timeout" are
/// separated because ADR 003 §8.2's backoff treats them differently and the settings sheet says
/// different sentences for them (19.3).
func syncErrorKind(_ e: URLError) -> String {
    switch e.code {
    case .timedOut:
        return "timeout"
    case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost,
         .cannotConnectToHost, .dnsLookupFailed, .internationalRoamingOff,
         .dataNotAllowed, .callIsActive:
        return "offline"
    default:
        return "transport"
    }
}

/// Perform the plan. Reachable ONLY from a `.success` of `syncPreflight` — the first line of
/// this function is already past every gate, which is the point of the split.
func syncPerform(_ plan: SyncPlan, _ done: @escaping ([String: Any]) -> Void) {
    // Ephemeral: no cookie jar, no credential store, no disk cache, nothing that outlives the
    // request. ADR 003 §1 — "no cookies, no sessions, no bearer tokens"; this transport carries
    // a signed request and nothing ambient.
    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpCookieAcceptPolicy = .never
    cfg.httpShouldSetCookies = false
    cfg.httpCookieStorage = nil
    cfg.urlCredentialStorage = nil
    cfg.urlCache = nil
    cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    cfg.timeoutIntervalForRequest = SYNC_TIMEOUT_SECONDS
    cfg.timeoutIntervalForResource = SYNC_TIMEOUT_SECONDS * 2
    cfg.httpAdditionalHeaders = [:]
    cfg.tlsMinimumSupportedProtocolVersion = .TLSv12

    let delegate = SyncRequestDelegate(expectedURL: plan.url, finish: done)
    let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    session.dataTask(with: plan.request).resume()
}

/// The command. Two lines of control flow, because every decision it makes is above it.
func syncRequest(_ args: [String: Any], _ done: @escaping ([String: Any]) -> Void) {
    switch syncPreflight(args) {
    case .failure(let why):
        // Refused HERE: no socket, no DNS lookup, no session. Story 21.5's zero-request promise
        // is this line.
        done(["error": "blocked", "reason": why.rawValue, "message": syncBlockedMessage()])
    case .success(let plan):
        syncPerform(plan, done)
    }
}

/// What the settings sheet needs to know, and the sentence a person is shown.
///
/// The copy lives HERE for the reason `net.js`'s `insecureOriginMessage()` and `crypto/probe.js`'s
/// `unavailableMessage()` give: the module that owns the RULE owns the sentence that explains it,
/// so the two cannot drift, and the UI picks the language. It does not say "error" — nothing has
/// gone wrong; the app is doing exactly what a solo install is supposed to do.
///
/// `origin` is disclosed on purpose. It is not a secret (the page must build URLs against it),
/// and the page learning it grants nothing: it could already name any URL it liked and the pin
/// would refuse it. What the disclosure buys is a settings sheet that can show the ONE address
/// this Mac may talk to instead of asking the user to type one.
func syncStatus() -> [String: Any] {
    let prefs = SyncPrefs.load()
    // `configured` is the RAW setting, refused or not. A build that named something this shell
    // will not talk to should be able to say what it named — a settings sheet that can only say
    // "not configured" cannot tell a missing relay from a rejected one.
    var o: [String: Any] = [
        "enabled": prefs.enabled,
        "configured": syncOriginSetting().trimmingCharacters(in: .whitespacesAndNewlines),
    ]
    switch pinnedSyncOrigin() {
    case .success(let origin):
        o["origin"] = origin
        o["originConfigured"] = true
        o["reason"] = NSNull()
        if !prefs.enabled {
            o["message"] = [
                "de": "Sync ist ausgeschaltet. Solange kein Familienkreis besteht, stellt dieser "
                    + "Mac keine einzige Netzwerkanfrage.",
                "en": "Sync is off. Until there is a Familienkreis, this Mac makes no network "
                    + "request at all.",
            ]
        }
    case .failure(let why):
        o["origin"] = NSNull()
        o["originConfigured"] = false
        o["reason"] = why.rawValue
        o["message"] = [
            "de": "Diese Version hat keinen Sync-Server hinterlegt. Der Kalender läuft "
                + "vollständig auf diesem Mac — es wird nichts gesendet und nichts abgerufen.",
            "en": "This build has no sync server configured. The calendar runs entirely on this "
                + "Mac — nothing is sent and nothing is fetched.",
        ]
    }
    return o
}

/// The sentence for a request that was refused because it did not name the pinned origin. The
/// page cannot cause this in normal operation — `assertReachable` refuses first — so it is the
/// sentence for the case where something inside the page has gone wrong, and it says what the
/// shell did rather than what the page did.
func syncBlockedMessage() -> [String: String] {
    [
        "de": "Diese Anfrage ging nicht an den hinterlegten Sync-Server und wurde deshalb gar "
            + "nicht erst gesendet.",
        "en": "This request was not addressed to the configured sync server, so it was never sent.",
    ]
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

// ── Keychain (LZP-302 · ADR 002 §2.2) ────────────────────────────────────────
//
// Three functions, one generic-password item per key. `src-tauri/src/lib.rs`
// mirrors them for parity and is UNVERIFIED — there is no Rust toolchain on the
// machine this was written on, so THIS is the reference implementation.
//
// ISOLATION, and it is not optional. A headless run (`--test`, `--smoke`,
// `--updater-selftest`) uses a DIFFERENT service name, exactly as
// `resolveScratchDir()` redirects the data directory. tests/run-dom-tests.sh
// fingerprints the user's real board directory before and after a run; it
// cannot fingerprint the login Keychain, so the separation has to be structural
// rather than checked afterwards. A test run can therefore add, read and delete
// its own items all day and the production service is untouched.

private let KEYCHAIN_SERVICE_PROD = "org.langzeitplaner.keys"
private let KEYCHAIN_SERVICE_TEST = "org.langzeitplaner.keys.headless-test"

/// The service a run is allowed to touch. Headless ⇒ never the production one.
func keychainService() -> String {
    isHeadless ? KEYCHAIN_SERVICE_TEST : KEYCHAIN_SERVICE_PROD
}

private func keychainQuery(_ key: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService(),
        kSecAttrAccount as String: key,
    ]
}

/// `nil` on success, the OSStatus on failure.
func keychainSet(key: String, value: String) -> OSStatus? {
    let data = Data(value.utf8)
    var query = keychainQuery(key)

    // Update first: SecItemAdd on an existing account returns errSecDuplicateItem,
    // and "set" must be idempotent — a re-pair rewrites the DEK in place.
    let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update == errSecSuccess { return nil }
    if update != errSecItemNotFound { return update }

    query[kSecValueData as String] = data
    // WhenUnlocked: unreadable while the Mac is locked.
    // ThisDeviceOnly: never synced to iCloud Keychain — ADR 002 §8.12.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let add = SecItemAdd(query as CFDictionary, nil)
    return add == errSecSuccess ? nil : add
}

/// The stored string, or `nil` when absent — and `nil` for any failure too. The
/// web layer cannot act on an OSStatus for a read, and "absent" and "unreadable"
/// lead to the same place: mint a new one, or ask the user to re-pair.
func keychainGet(key: String) -> String? {
    var query = keychainQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
}

/// `nil` on success. Deleting something absent is success.
func keychainDelete(key: String) -> OSStatus? {
    let status = SecItemDelete(keychainQuery(key) as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound { return nil }
    return status
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

            // ── LZP-1002 · the sync transport (ADR 003 §7 gate 3, story 21.5) ─
            //
            // The command `src/js/platform/net.js` §6 names, and the reason
            // `chooseTransport()` picking `bridge` in this shell is now a
            // working path rather than a dead one. Every decision it makes is
            // in `syncRequest` above; this case exists to hand it the args and
            // hand back the dictionary. The reply is an OBJECT, not the JSON
            // string the updater commands use, because that is what
            // `createBridgeTransport` reads.
            //
            // Reachable from any page script, like every bridge command — which
            // is exactly why the origin is pinned in the shell and not passed
            // in here.
            case "sync_request":
                syncRequest(args) { replyHandler($0, nil) }

            // What the settings sheet needs: is sync on, is an origin
            // configured, which one, and the sentence to show when it is not.
            // Read-only; it changes nothing and makes no request.
            case "sync_status":
                replyHandler(syncStatus(), nil)

            case "print_board":
                printAction?()
                replyHandler(NSNull(), nil)

            // ── LZP-302 · the Keychain backstop (ADR 002 §2.2) ───────────────
            //
            // These three commands hold ONE thing between them: the recovery
            // identity — a 32-byte DEK, plus RK_sig/RK_kex as AES-GCM-wrapped
            // PKCS#8 under that DEK. The DEVICE keys (IK_sig/IK_kex) never come
            // anywhere near here: they are generated `extractable: false`, live
            // as non-extractable CryptoKeys in IndexedDB, and there is no code
            // path that could turn them into bytes to store.
            //
            // Why the backstop exists at all: IndexedDB under a custom `app://`
            // scheme can be evicted by the OS, and an eviction looks exactly
            // like "this device was never paired". The device then has to
            // re-pair — but the MEMBER identity survives, so the user is never
            // locked out of their own Familienkreis.
            //
            // kSecAttrAccessibleWhenUnlockedThisDeviceOnly, deliberately:
            //   · WhenUnlocked  — unreadable while the Mac is locked;
            //   · ThisDeviceOnly — NOT synced to iCloud Keychain. ADR 002 §8.12
            //     records that the recovery key has no revocation and no leak
            //     detection, so syncing it would silently widen that residual
            //     from one Mac to every device on the Apple ID.
            //
            // Values are strings (the web layer sends base64url), so the whole
            // surface is three string operations and there is nothing here that
            // parses attacker-shaped data.
            //
            // Solo mode never calls any of these — no key of any kind exists
            // until the family opt-in moment (ADR 002 §2.4).

            case "keychain_set":
                guard let key = args["key"] as? String, !key.isEmpty,
                      let value = args["value"] as? String else {
                    replyHandler(nil, "keychain_set: key and value are required"); break
                }
                if let status = keychainSet(key: key, value: value) {
                    replyHandler(nil, "keychain_set: OSStatus \(status)")
                } else {
                    replyHandler(NSNull(), nil)
                }

            case "keychain_get":
                guard let key = args["key"] as? String, !key.isEmpty else {
                    replyHandler(nil, "keychain_get: key is required"); break
                }
                // NSNull for "absent" — the same shape load_board uses, and
                // distinguishable in JS from the empty string, which is a
                // legitimate stored value.
                replyHandler(keychainGet(key: key) ?? NSNull(), nil)

            case "keychain_delete":
                guard let key = args["key"] as? String, !key.isEmpty else {
                    replyHandler(nil, "keychain_delete: key is required"); break
                }
                // Deleting something absent is success. A delete that reported
                // an error for "already gone" would make every clean-up path
                // need a probe first.
                if let status = keychainDelete(key: key) {
                    replyHandler(nil, "keychain_delete: OSStatus \(status)")
                } else {
                    replyHandler(NSNull(), nil)
                }

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
                case "sync_enabled":
                    // ADR 003 §7 gate 3's own switch, and the one the web layer
                    // is REQUIRED to push: `sync_request` refuses everything
                    // until it is true, so a build in which the family opt-in
                    // never calls this is a build that makes zero requests.
                    // Defaults to false and is persisted, so a relaunch of a
                    // solo install is solo again without asking anyone.
                    var sp = SyncPrefs.load()
                    sp.enabled = args["value"] as? Bool ?? false
                    sp.save()
                    // NSNull, like every other shell pref, and NOT the new status: the Tauri
                    // half's `set_shell_pref` returns `Result<(), String>` for all four keys, and
                    // one contract means one return shape. The status is a separate command.
                    replyHandler(NSNull(), nil)
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
        guard !isHeadless else { return }   // the menu-bar item cannot summon a test run
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
        // A headless run (--test / --smoke) never shows a window. Ordering it front
        // stole focus and flashed a window once PER TEST FILE — 26 of them per
        // `npm run test:dom` — which made the suite genuinely unpleasant to run and
        // therefore less likely to be run. WKWebView still lays out and evaluates
        // JS in an unordered window, and tier 2 asserts on the DOM, classes and
        // inline styles rather than on composited pixels, so nothing is lost.
        if !isHeadless { window.makeKeyAndOrderFront(nil) }

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
        // .prohibited in a headless run: no Dock tile, no menu bar, no window, and
        // no focus stolen from whatever the human is actually doing. .regular is
        // what makes this a visible app, and a test run is not one.
        // .accessory, NOT .prohibited: no Dock tile, no menu bar and no focus stolen,
        // but still a real GUI session. .prohibited denies the process the session
        // context WebKit needs to reach the WebCrypto master key in the login
        // Keychain, which broke crypto-keystore-phase1 outright (measured: 4/4 -> 1/4,
        // KeyStoreUnavailableError). Engine-difference #8 in ADR 002 §1 is why.
        NSApp.setActivationPolicy(isHeadless ? .accessory : .regular)
        if !isHeadless { NSApp.activate(ignoringOtherApps: true) }

        webView.load(URLRequest(url: URL(string: "\(APP_SCHEME)://\(APP_HOST)/index.html")!))
    }

    /// 13.4 / story 21.5 — zero network as an enforced property, not a habit:
    /// the web view may navigate only within its own bundle scheme.
    ///
    /// ── THIS GATE DOES NOT OPEN FOR THE SYNC ORIGIN, AND THE ADR IS AMENDED ──
    ///
    /// ADR 003 §7 gate 3 says this delegate should permit "exactly the one sync
    /// origin" once `sync_enabled` is set. That is a LOOSENING and it is not
    /// built — see the long note above `sync_request`. The page never opens the
    /// socket (net.js §6: the native process performs the request), so opening
    /// this delegate would buy nothing and would cost the one gate that
    /// survives a JS bug, in the one state where the machine has something to
    /// leak. `sync_enabled` is real; it gates the BRIDGE COMMAND, not this.
    ///
    /// The host check is new with the same pass: `BundleSchemeHandler` serves
    /// from the bundle for any `app://` host, so `app://anything/` was reaching
    /// the same files under a DIFFERENT ORIGIN — a second origin inside the
    /// app, with its own localStorage and IndexedDB, one `location =` away.
    /// One host, one origin.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let scheme = url?.scheme?.lowercased() ?? ""
        // `about:blank` carries no host; an `app://` navigation must name ours.
        let ownBundle = scheme == APP_SCHEME && (url?.host?.lowercased() ?? APP_HOST) == APP_HOST
        decisionHandler(ownBundle || scheme == "about" ? .allow : .cancel)
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

        webView.callAsyncJavaScript(body, in: nil, in: .page) { [weak webView] result in
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
            // ── F-SHELL-3(c) · THE HARNESS DEFECT THAT LOOKED LIKE THE PRODUCT LOSING DATA ─────
            //
            // `exit()` here used to be the last statement. `exit()` does not run
            // `applicationShouldTerminate` — the ONLY caller of `window.__lzpFlush` — and it does
            // not fire `pagehide` either, so the page's 700 ms `SAVE_DEBOUNCE` was abandoned
            // every time. Under ADR 006 `board.json` IS the truth, so an entry a phase had just
            // created was simply gone on the next launch, and `shell-family-e2e.mjs` reported it
            // as „the owner lost her own entry — unshare DELETED instead of reverting".
            //
            // ⌘Q always flushed; only the test runner did not. This is the same call
            // `applicationShouldTerminate` makes, with the same 2 s watchdog so a hung page
            // cannot wedge a suite, and it adds NO UI call — `isHeadless` and the `.accessory`
            // activation policy are untouched.
            let code: Int32 = failed == 0 ? 0 : 1
            var exited = false
            let leave: () -> Void = {
                if exited { return }
                exited = true
                fflush(stdout)
                exit(code)
            }
            guard let wv = webView else { leave(); return }
            wv.callAsyncJavaScript(
                "if (window.__lzpFlush) { await window.__lzpFlush(); } return true;",
                in: nil, in: .page) { _ in leave() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { leave() }
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
        guard !isHeadless else { return false }   // no Dock tile in a test run, so nothing to reopen
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
