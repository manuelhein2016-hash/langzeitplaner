// Native shell. Everything here exists because the board is a Mac app, not a
// web page: atomic writes to Application Support, the menu bar from §9, ⌘W
// hiding the window instead of closing it, and the optional tray icon.
//
// Zero network by architecture (13.4): no HTTP client is linked, and the CSP in
// tauri.conf.json permits `self` and the IPC channel only.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const BOARD_FILE: &str = "board.json";
const SNAPSHOT_FILE: &str = "snapshots.json";
// LZP-402 — ADR 001 §9. Neither exists until a family space is created.
const OPS_FILE: &str = "ops.jsonl";
const CHECKPOINT_FILE: &str = "checkpoint.json";

/// The user's board directory — and it is `<Application Support>/LangzeitPlaner`, NOT
/// `app_data_dir()`.
///
/// ⚠ THIS CONSTANT IS LOAD-BEARING AND IT IS NOT COSMETIC. `app_data_dir()` derives the
/// path from the bundle identifier, so it answers `.../org.langzeitplaner.app` — while
/// `shell-macos/main.swift:64-67` hard-codes the component `"LangzeitPlaner"`. Those are
/// two different directories, and the Swift shell is the one that has every board in it:
/// it is what is installed, what was signed and notarized, and what every measurement in
/// this project used.
///
/// The failure mode is not "install the wrong DMG". `main.swift:422-478` extracts a
/// `.app.tar.gz` and `replaceItemAt`s the installed bundle in place, and
/// `.github/workflows/release.yml:429` publishes exactly such an archive built by Tauri —
/// so the FIRST SUCCESSFUL AUTO-UPDATE would silently convert a Swift install into a Tauri
/// one, and the board would move to a directory that does not exist. Nobody downloads
/// anything; nobody makes a mistake. Nothing is destroyed — the real board sits untouched
/// next door — but it presents to the user as total data loss.
///
/// `data_dir()` is the platform base (`~/Library/Application Support` on macOS); the
/// component below is the same literal Swift appends. The two shells resolve to one
/// directory, which is what "the same product" has to mean.
fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| format!("no data dir: {e}"))?;
    let dir = base.join("LangzeitPlaner");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `<file>.tmp` beside the target — mirrors Swift's `appendingPathExtension`.
/// `with_extension("json.tmp")` would have turned `ops.jsonl` into
/// `ops.json.tmp`; for `board.json` / `snapshots.json` this is the same name it
/// always produced.
fn tmp_path(path: &PathBuf) -> PathBuf {
    let mut s = path.clone().into_os_string();
    s.push(".tmp");
    PathBuf::from(s)
}

/// 11.4 — temp file + rename, so a crash mid-save cannot corrupt the board.
fn write_atomic(path: &PathBuf, contents: &str) -> Result<(), String> {
    let tmp = tmp_path(path);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_opt(path: &PathBuf) -> Option<String> {
    fs::read_to_string(path).ok()
}

#[tauri::command]
fn load_board(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_opt(&data_dir(&app)?.join(BOARD_FILE)))
}

#[tauri::command]
fn save_board(app: AppHandle, contents: String) -> Result<(), String> {
    write_atomic(&data_dir(&app)?.join(BOARD_FILE), &contents)
}

#[tauri::command]
fn load_snapshots(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_opt(&data_dir(&app)?.join(SNAPSHOT_FILE)))
}

#[tauri::command]
fn save_snapshots(app: AppHandle, contents: String) -> Result<(), String> {
    write_atomic(&data_dir(&app)?.join(SNAPSHOT_FILE), &contents)
}

// ── LZP-402 · the op log ─────────────────────────────────────────────────────
//
// UNVERIFIED (risk R8): there is no Rust toolchain on the machine this was
// written on, so nothing below has been compiled or smoke-tested. It is a
// line-for-line mirror of shell-macos/main.swift, which IS built and covered by
// tests/tier2/shell-oplog.dom.js. Build and run that same round-trip against
// this shell on a machine with cargo before any Tauri build ships.
//
// Tauri v2 maps camelCase invoke args onto snake_case command parameters, so
// `invoke('truncate_ops', { keepFromLine })` binds to `keep_from_line`.

/// ADR 001 §9 — the log is APPENDED, never rewritten. `write_atomic` would make
/// every append O(file) and the whole log O(n²) to write. `sync_all` puts the
/// bytes on the platter before the reply goes back. A torn trailing line is the
/// reader's problem, and `storage.js`'s `parseJSONL` already drops one.
fn append_file(path: &PathBuf, contents: &str) -> Result<(), String> {
    if contents.is_empty() {
        return Ok(());
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

/// Split a JSONL blob the way `storage.js`'s `parseJSONL` does — blank and
/// unparseable lines skipped — so a line index computed from what `load_ops`
/// returned means the same thing here. That equivalence is the whole contract of
/// `truncate_ops(keepFromLine)`.
fn jsonl_lines(txt: &str) -> Vec<&str> {
    txt.split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter(|l| serde_json::from_str::<serde_json::Value>(l).is_ok())
        .collect()
}

/// `""` — not null — when the log does not exist yet, so an absent file and an
/// empty one are indistinguishable to the caller.
#[tauri::command]
fn load_ops(app: AppHandle) -> Result<String, String> {
    Ok(read_opt(&data_dir(&app)?.join(OPS_FILE)).unwrap_or_default())
}

#[tauri::command]
fn append_ops(app: AppHandle, contents: String) -> Result<(), String> {
    append_file(&data_dir(&app)?.join(OPS_FILE), &contents)
}

/// The one whole-file rewrite the log gets, after a compaction has folded its
/// head into the checkpoint (ADR 001 §7.2). Rare by construction, and atomic:
/// a half-written log after a compaction loses ops the checkpoint had not
/// absorbed yet.
#[tauri::command]
fn truncate_ops(app: AppHandle, keep_from_line: usize) -> Result<(), String> {
    let path = data_dir(&app)?.join(OPS_FILE);
    let txt = read_opt(&path).unwrap_or_default();
    let kept: Vec<&str> = jsonl_lines(&txt).into_iter().skip(keep_from_line).collect();
    if kept.is_empty() {
        let _ = fs::remove_file(&path);
        Ok(())
    } else {
        write_atomic(&path, &(kept.join("\n") + "\n"))
    }
}

#[tauri::command]
fn load_checkpoint(app: AppHandle) -> Result<String, String> {
    Ok(read_opt(&data_dir(&app)?.join(CHECKPOINT_FILE)).unwrap_or_default())
}

/// Atomic, like `save_board` — and for a stronger reason. A torn `board.json`
/// can be rebuilt by replaying the log; a torn checkpoint is the one file
/// nothing else can re-derive.
#[tauri::command]
fn save_checkpoint(app: AppHandle, contents: String) -> Result<(), String> {
    write_atomic(&data_dir(&app)?.join(CHECKPOINT_FILE), &contents)
}

// ═══════════════════════════════════════════════════════════════════════════
// F22 · UPDATES — LZP-102 (auto-updater) + LZP-104 (minimum version)
// Stories 22.3, 22.5, 22.6, 22.7.  Amendment A11.
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ UNVERIFIED — EVERY LINE OF THIS SECTION (risk R8, PLAN.md §4).
//
// There is no Rust toolchain on the machine this was written on, so nothing
// below has been compiled, let alone run. It is written to mirror
// `shell-macos/main.swift`, which IS built and covered by
// `tests/tier2/shell-updater.dom.js` and `shell-macos/updater-selftest.sh`.
// The API calls into `tauri-plugin-updater` in particular are written from its
// documented v2 surface and MUST be checked against the crate on a machine with
// cargo before any Tauri build ships. The specific things to re-check:
//
//   · `UpdaterExt::updater_builder()`, `version_comparator`, `check()`
//   · that `Update` really exposes `raw_json`, `version`, `download()` and
//     `install()` with these signatures
//   · that `download()` is the call that performs the minisign verification
//
// WHAT THE DECISION LOGIC IS, AND WHERE IT LIVES. Nothing here decides anything.
// Whether a check is due, whether a manifest is well-formed, whether the offered
// build is newer, whether this client is below `minimum_version` — all of that
// is `src/js/platform/updater.js`, tested under `node --test`. These commands are
// the same four the Swift shell implements, with the same names, the same
// arguments and the same JSON replies, so ONE tested brain drives both shells.
//
// 21.5 — WHY THE CSP IN tauri.conf.json DOES NOT GAIN A HOST. The updater's
// HTTPS GET is made by the plugin, in Rust, outside the WebView. The page's
// `connect-src` therefore stays `'self' ipc: http://ipc.localhost` and the board
// still cannot reach the network at all. The two consent gates (`disclosed`,
// `enabled`) are re-checked here as well as in JavaScript, because a bridge
// command is reachable from any page script.
//
// 22.3 — "APPLIES ON THE NEXT START", AND HOW IT DIFFERS FROM THE SWIFT SHELL.
// This is the one place the two shells are not identical, and the difference is
// deliberate rather than accidental:
//
//   Swift : download → verify → stage the bytes on disk → at the NEXT LAUNCH
//           re-verify the signature and swap the bundle.
//   Tauri : download (the plugin verifies the minisign signature as it goes) →
//           install immediately. On macOS `install()` replaces the bundle on
//           disk while the running process keeps executing from the image it
//           already opened, so the user sees nothing until they next launch —
//           which is exactly what 22.3 asks for.
//
// The Tauri path is arguably the safer of the two: there is no window in which
// downloaded bytes wait on disk between verification and use. The Swift path
// closes that window by verifying a second time at apply. Neither ever installs
// anything it has not just verified, which is the whole of 22.6.

// ─────────────────────────────────────────────────────────────────────────────
// LZP-302 · the Keychain backstop (ADR 002 §2.2)
//
// ⚠ UNVERIFIED — NOT COMPILED, NOT RUN, NOT ONCE.
// There is no Rust toolchain on the machine this was written on (PLAN.md risk
// R8), so this file cannot be built here at all. `shell-macos/main.swift` is the
// REFERENCE IMPLEMENTATION for v2 and it is the one that has been exercised
// against a real Keychain by `tests/tier2/crypto-keystore-phase1.dom.js`. What
// follows is written to match it command-for-command so the two shells present
// one bridge protocol to `src/js/platform/keystore.js` — and whoever first gets
// `cargo` running must check it rather than trust it.
//
// WHAT THESE THREE COMMANDS HOLD, AND WHAT THEY MUST NEVER HOLD.
// Between them: the recovery identity only — a 32-byte DEK plus RK_sig/RK_kex
// as AES-GCM-wrapped PKCS#8 under that DEK. The DEVICE keys (IK_sig / IK_kex)
// never come near here: they are generated `extractable: false` and live as
// non-extractable CryptoKeys in IndexedDB, so no code path can turn them into
// the bytes these commands take.
//
// TWO THINGS TO VERIFY WHEN A TOOLCHAIN EXISTS, both of which the Swift side
// gets right and neither of which this simple binding guarantees:
//
//   1. ACCESSIBILITY. The Swift reference sets
//      `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`:
//        · WhenUnlocked   — unreadable while the Mac is locked;
//        · ThisDeviceOnly — NEVER synced to iCloud Keychain. ADR 002 §8.12
//          records that the recovery key has no revocation and no leak
//          detection, so syncing it would widen that residual from one Mac to
//          every device on the Apple ID.
//      `security_framework::passwords`' convenience functions do not take an
//      accessibility argument. If they do not default to
//      `WhenUnlockedThisDeviceOnly`, this must be rewritten against
//      `security_framework::item::ItemAddOptions` (or raw `SecItemAdd`) with
//      the attribute set explicitly. THAT IS A SECURITY DIFFERENCE, not a
//      style one, and it is the first thing to check.
//   2. ISOLATION. The Swift shell uses a SEPARATE service name for headless
//      runs so a test can never touch production items. Tauri has no headless
//      test mode today; if one is added, mirror `keychainService()`.
//
// The service name and the two account names are fixed by ADR 002 §2.2 and are
// mirrored in `src/js/platform/keystore.js` as `KEYCHAIN_SERVICE` /
// `KEYCHAIN_ACCOUNTS`.
const KEYCHAIN_SERVICE: &str = "org.langzeitplaner.keys";

#[tauri::command]
fn keychain_set(key: String, value: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("keychain_set: key is required".into());
    }
    // Idempotent, like the Swift side: a re-pair rewrites the DEK in place
    // rather than failing with a duplicate-item error.
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, &key, value.as_bytes())
        .map_err(|e| format!("keychain_set: {e}"))
}

#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>, String> {
    if key.is_empty() {
        return Err("keychain_get: key is required".into());
    }
    // `None` for absent AND for unreadable — the web layer cannot act on the
    // difference, and both lead to the same place: mint a new one, or re-pair.
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &key) {
        Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn keychain_delete(key: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("keychain_delete: key is required".into());
    }
    // Deleting something absent is success — otherwise every clean-up path
    // needs a probe first.
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &key);
    Ok(())
}

const UPDATER_PREFS_FILE: &str = "updater.json";

/// 22.5 — one channel for every device. Mirrors `CHANNEL` in updater.js.
const UPDATE_CHANNEL: &str = "stable";
/// Mirrors `TARGET` in updater.js. Tauri resolves the platform key itself, but
/// the JS side needs to know which one to read out of the manifest.
const UPDATE_TARGET: &str = "darwin-universal";

/// The updater's own tiny preference file — deliberately NOT part of
/// `board.json`. 22.7 says updates never touch user data, and the cheapest way
/// to keep that true is for the updater to have no reason to open the user's
/// files at all.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct UpdaterPrefs {
    /// The settings switch (22.4 — the user can always turn it off).
    enabled: bool,
    /// 21.5 — has the first-run screen said this happens? No check of any kind
    /// runs until this is true. FALSE on a fresh install: silence until someone
    /// has been told.
    disclosed: bool,
    /// Epoch milliseconds, to match JavaScript's clock without conversion.
    last_check_at: f64,
    /// The version that has been installed but is not running yet.
    staged_version: Option<String>,
}

impl Default for UpdaterPrefs {
    fn default() -> Self {
        Self { enabled: true, disclosed: false, last_check_at: 0.0, staged_version: None }
    }
}

impl UpdaterPrefs {
    fn load(app: &AppHandle) -> Self {
        let path = match data_dir(app) {
            Ok(d) => d.join(UPDATER_PREFS_FILE),
            Err(_) => return Self::default(),
        };
        read_opt(&path)
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save(&self, app: &AppHandle) {
        if let Ok(dir) = data_dir(app) {
            if let Ok(txt) = serde_json::to_string_pretty(self) {
                let _ = write_atomic(&dir.join(UPDATER_PREFS_FILE), &txt);
            }
        }
    }
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn status_json(app: &AppHandle) -> String {
    let p = UpdaterPrefs::load(app);
    serde_json::json!({
        "currentVersion": current_version(app),
        "channel": UPDATE_CHANNEL,
        "target": UPDATE_TARGET,
        "enabled": p.enabled,
        "disclosed": p.disclosed,
        "lastCheckAt": p.last_check_at,
        "stagedVersion": p.staged_version,
    })
    .to_string()
}

#[tauri::command]
fn update_status(app: AppHandle) -> String {
    status_json(&app)
}

/// 21.5 — set ONCE by LZP-106's first-run screen, after it has said in one line
/// that the app asks about updates. Nothing checks anything before this is true.
#[tauri::command]
fn update_set_disclosed(app: AppHandle, value: Option<bool>) -> String {
    let mut p = UpdaterPrefs::load(&app);
    p.disclosed = value.unwrap_or(true);
    p.save(&app);
    status_json(&app)
}

#[tauri::command]
fn update_set_enabled(app: AppHandle, value: Option<bool>) -> String {
    let mut p = UpdaterPrefs::load(&app);
    p.enabled = value.unwrap_or(true);
    p.save(&app);
    status_json(&app)
}

/// Written BEFORE the request goes out (updater.js calls it in that order), so a
/// host that hangs cannot leave the device retrying on every single launch.
#[tauri::command]
fn update_note_check(app: AppHandle, at: Option<f64>) {
    let mut p = UpdaterPrefs::load(&app);
    p.last_check_at = at.unwrap_or(0.0);
    p.save(&app);
}

// ── 22.4 · the quiet hint and the one click (LZP-103) ────────────────────────
//
// ⚠ UNVERIFIED — written on a machine with no Rust toolchain. Nothing below has
// ever been compiled. `shell-macos/main.swift` is the reference implementation
// of the same two commands and IS built and tested (`--smoke` prints the App
// menu in both languages and both states); this is its Tauri twin. Re-check on
// a machine with cargo, specifically: `IsMenuItem` being in `tauri::menu`,
// `Submenu::with_items` accepting a `&[&dyn IsMenuItem<R>]` slice, and
// `AppHandle::restart()` existing with this signature.

/// The staged version the App menu is currently advertising, or `None`.
/// A `Mutex` rather than managed state so `build_menu` — which is called from
/// `setup` before any state could be managed — can read it without a signature
/// change.
static UPDATE_HINT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn update_hint_value() -> Option<String> {
    UPDATE_HINT.lock().ok().and_then(|g| g.clone())
}

/// 22.4 — the App-menu half of the quiet hint. The web layer owns the predicate
/// (one function, in update-ui.js); this only draws it. An empty string means
/// "no hint": JSON `null` and an absent argument are not distinguishable across
/// both bridges, so the wire value is `""`.
#[tauri::command]
fn update_menu_hint(app: AppHandle, version: Option<String>) -> Result<(), String> {
    let v = version.filter(|s| !s.trim().is_empty());
    if let Ok(mut g) = UPDATE_HINT.lock() {
        if *g == v {
            return Ok(()); // no change — do not rebuild the menu on every redraw
        }
        *g = v;
    }
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// 22.4 — "one click restarts into the new version". Refuses when nothing is
/// staged, because restarting into the same build is a no-op a user reads as a
/// broken button.
///
/// The two shells differ here, deliberately, and both are honest: the Swift
/// shell stages verified bytes and swaps the bundle at the next launch, so its
/// restart is what performs the update. Tauri's plugin has already installed
/// the new bundle by this point — macOS keeps executing the already-open image,
/// which is why the user still sees nothing until a restart — so this restart
/// only ends the old process. Neither installs anything it has not verified.
#[tauri::command]
fn update_restart(app: AppHandle) -> String {
    let p = UpdaterPrefs::load(&app);
    if p.staged_version.is_none() {
        return serde_json::json!({ "ok": false, "error": "nothing-staged" }).to_string();
    }
    // Reply first, restart a beat later: the reply handler must complete, and
    // update-ui.js has already flushed the board before calling this.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            inner.restart();
        });
    });
    serde_json::json!({ "ok": true, "restarting": true }).to_string()
}

#[tauri::command]
fn update_clear_staged(app: AppHandle) -> String {
    let mut p = UpdaterPrefs::load(&app);
    p.staged_version = None;
    p.save(&app);
    status_json(&app)
}

/// The one network request solo mode makes, and the reason the 21.5 gates exist.
///
/// The RAW manifest text goes back to JavaScript. This side has no opinion about
/// what a manifest means: `parseManifest` in updater.js does, and it is the one
/// with tests. `version_comparator` is pinned to `true` so that the plugin hands
/// us the manifest even when its own comparison would have said "nothing newer"
/// — otherwise a manifest that carries only a `minimum_version` bump (22.7,
/// LZP-104) would never reach the client that needs to read it.
#[tauri::command]
async fn update_fetch_manifest(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    let p = UpdaterPrefs::load(&app);
    if !p.disclosed || !p.enabled {
        return Ok(serde_json::json!({ "ok": false, "error": "disabled" }).to_string());
    }

    let updater = app
        .updater_builder()
        .version_comparator(|_current, _update| true)
        .build()
        .map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(serde_json::json!({
            "ok": true,
            "manifest": update.raw_json.to_string(),
        })
        .to_string()),
        // No `Update` at all means the endpoint answered but there is nothing to
        // describe — for our always-true comparator that is effectively an empty
        // manifest, and the JS side treats it as a malformed one.
        Ok(None) => Ok(serde_json::json!({ "ok": false, "error": "empty" }).to_string()),
        Err(e) => Ok(serde_json::json!({
            "ok": false, "error": "network", "detail": e.to_string()
        })
        .to_string()),
    }
}

/// Download, VERIFY, install. 22.6: the plugin checks the minisign signature
/// against `plugins.updater.pubkey` from tauri.conf.json as the bytes arrive, and
/// `install` is unreachable without a `Vec<u8>` that came out of `download`.
/// An artifact that fails verification returns an error here and NOTHING is
/// written to the application bundle.
///
/// `version` is passed in by the caller and re-checked against what the endpoint
/// offers: the JS side already decided which build it wants (and refused any
/// downgrade), so a mismatch means the manifest moved between the check and the
/// download, and the safe answer is to do nothing.
#[tauri::command]
async fn update_download(
    app: AppHandle,
    version: String,
    url: Option<String>,
    signature: Option<String>,
    size: Option<u64>,
) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    // `url`, `signature` and `size` are part of the shared port shape (the Swift
    // shell fetches and verifies them itself). Tauri re-derives all three from
    // the manifest it just parsed, so they are accepted and deliberately unused
    // rather than trusted — a URL chosen by the caller is exactly the hijackable
    // update path 22.6 exists to prevent.
    let _ = (url, signature, size);

    let p = UpdaterPrefs::load(&app);
    if !p.disclosed || !p.enabled {
        return Ok(serde_json::json!({ "ok": false, "error": "disabled" }).to_string());
    }

    let updater = app
        .updater_builder()
        .version_comparator(|_current, _update| true)
        .build()
        .map_err(|e| e.to_string())?;

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            return Ok(serde_json::json!({ "ok": false, "error": "empty" }).to_string())
        }
        Err(e) => {
            return Ok(serde_json::json!({
                "ok": false, "error": "network", "detail": e.to_string()
            })
            .to_string())
        }
    };

    if update.version != version {
        return Ok(serde_json::json!({
            "ok": false, "error": "version-moved",
            "detail": format!("asked for {version}, endpoint now offers {}", update.version)
        })
        .to_string());
    }

    // THE VERIFICATION IS IN HERE. `download` fails if the minisign signature
    // does not check out against the configured public key, and nothing is
    // installed because `install` needs the bytes it returns.
    let bytes = match update.download(|_chunk, _total| {}, || {}).await {
        Ok(b) => b,
        Err(e) => {
            let msg = e.to_string();
            // Distinguish "the signature is wrong" from "the wifi dropped": the
            // first wants a human, the second wants tomorrow.
            let kind = if msg.to_lowercase().contains("signature") { "signature" } else { "network" };
            return Ok(serde_json::json!({ "ok": false, "error": kind, "detail": msg }).to_string());
        }
    };

    if let Err(e) = update.install(bytes) {
        return Ok(serde_json::json!({
            "ok": false, "error": "install", "detail": e.to_string()
        })
        .to_string());
    }

    // The bundle on disk is now the new build; this process keeps running from
    // the image it already opened. 22.3's "applies on the next start" is
    // therefore simply what happens, with no restart prompt and no modal (22.4).
    let mut prefs = UpdaterPrefs::load(&app);
    prefs.staged_version = Some(version.clone());
    prefs.save(&app);

    Ok(serde_json::json!({ "ok": true, "staged": true, "version": version }).to_string())
}

/// Called once at startup. If the staged version is the version now running, the
/// swap took effect and the marker is stale — clear it so the quiet "Update
/// verfügbar" hint (22.4) does not linger after the update it referred to.
///
/// 22.7 — nothing in this path reads or writes board.json, ops.jsonl,
/// checkpoint.json or snapshots.json. Schema migrations (11.6) run at the next
/// boot of the NEW binary, after the swap, exactly as for any other version
/// change.
fn clear_staged_marker_if_applied(app: &AppHandle) {
    let mut p = UpdaterPrefs::load(app);
    if p.staged_version.as_deref() == Some(current_version(app).as_str()) {
        p.staged_version = None;
        p.save(app);
    }
}

// ── LZP-1002 · `sync_request` — THE SHELL IS THE TRANSPORT (ADR 003 §7 gate 3) ───────────────
//
// The Tauri half of the command `src/js/platform/net.js` §6 publishes. `shell-macos/main.swift`
// is the REFERENCE implementation — it is the shell that ships and the one with a running test
// suite behind it (`tests/tier2/shell-transport.dom.js`, 17 rows in a real WKWebView). This file
// mirrors it rule for rule, because a divergence between two shells is a bug a user finds.
//
//   sync_request({ url, method, headers, body })
//       → { status, headers: {…lower-cased…}, body: String, url: String, redirected: false }
//       → { error: "offline" | "timeout" | "blocked" | "transport", reason: String }
//
// The reply is a JSON OBJECT, not the JSON string the four updater commands return, because
// `createBridgeTransport` reads `reply.status` / `reply.headers` / `reply.body` off an object.
// The Swift shell answers with a dictionary for the same reason. One contract, two shells.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ TWO THINGS THIS FILE NEEDS THAT IT CANNOT ADD ITSELF — HAND-OFF, NOT AN OVERSIGHT
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//  1. **`src-tauri/Cargo.toml` needs one line**, and it is owned by another pass:
//
//         reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
//
//     `tauri-plugin-updater` already pulls `reqwest` into the dependency graph, so this adds no
//     new TLS stack and no new transitive risk — it makes the crate that is already there
//     nameable from this file. `reqwest::Url` is also where the URL parsing below comes from,
//     so the line buys both halves.
//
//  2. **This file has never been compiled.** There is no `cargo` on the machine this was written
//     on (PLAN.md risk R8) — the same statement the Keychain section above already carries.
//     `shell-macos/main.swift` compiles, runs, and is characterized end to end against a real
//     relay; this is its mirror, reviewed line by line against it and UNVERIFIED by execution.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SECURITY SHAPE, WHICH IS THE WHOLE DIFFICULTY
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A bridge command that accepted an arbitrary URL from the web view is an **SSRF primitive**:
// page script could reach the household router, a `localhost` admin port, `169.254.169.254`, a
// `file://` path or any origin at all — from the NATIVE process, outside every rule the WebView
// applies to itself (the CSP in `tauri.conf.json`, the navigation gate, the IPC sandbox).
//
// So the shell **pins the origin; it does not accept one.** The web view may name a PATH. It may
// not name a host, a scheme or a port. Then, in the order the checks run:
//
//   1. `sync_enabled` must be on — a shell pref defaulting to FALSE, ADR 003 §7 gate 3's switch.
//   2. An origin must be configured, `https:` to a public DNS name: no IP literal of any kind
//      (a superset of "no private ranges"), no `.local`/`.lan`/`.internal`/`.home.arpa`, no
//      single-label LAN name, no loopback — even if configuration named one.
//   3. The URL must re-serialise, byte for byte, to `pinned + path + ?query`, with the path in
//      the narrow `/api/v1/…` shape `net.js`'s `PATH_RE` allows.
//   4. GET or POST; headers off a four-name allowlist with printable-ASCII values; no Cookie,
//      no Host, no header-injection newline.
//   5. A 4 MiB request cap and an 8 MiB response cap, the latter enforced as the bytes arrive.
//   6. No redirect followed (`redirect::Policy::none()`), and a 3xx is `blocked` rather than an
//      answer — FINDING P-5: a signed request replayed at a destination the relay chose is the
//      attack. The reply names the final URL so the page can check rather than trust.
//   7. No cookie store, no proxy-supplied credentials, no cache.
//
// **Solo mode makes zero requests, and that is a property of the order**: steps 1 and 2 are pure
// and local, and no HTTP client is constructed until step 7. With `sync_enabled` off — or no
// origin configured, which is every build shipped so far — this refuses without a socket and
// without a DNS lookup.
//
// ── WHERE THIS DELIBERATELY DIVERGES FROM THE SWIFT SHELL, AND WHY ───────────────────────────
//
// `main.swift` allows ONE extra origin: `http://` to a loopback host, and only in a headless run
// (`--sync-origin` / `LZP_SYNC_ORIGIN`), so the tier-2 suite can drive `node
// server/dev-server.mjs`. Tauri has no headless test mode today — exactly the note the Keychain
// section above carries — so that carve-out is absent here rather than approximated. If a
// headless mode is added, mirror `syncOriginSetting()` and `normalizeSyncOrigin`'s `devLoopback`
// branch together; adding either alone is how a shipped build becomes redirectable.
//
// ── WHAT THIS DOES NOT DEFEND AGAINST ────────────────────────────────────────────────────────
//
// A configured DNS NAME that resolves to a private address is not caught: the checks are on the
// name. Pinning the resolved address needs a custom resolver and still races the one the client
// performs. The origin is build configuration and never a page parameter, so reaching this needs
// control of the build. Recorded, not fixed — the same sentence the Swift shell carries.

/// PLACEHOLDER, checked at runtime rather than hoped about. ADR 003 §1 names
/// `https://<vercel-app>.vercel.app` and no such app exists. Empty means every `sync_request` is
/// refused locally, which is the correct behaviour for a build with nowhere to sync to.
///
/// ██ AUDIT F1 · SUBSTITUTING THIS IS HALF AN ACT, AND HALF IS WORSE THAN NONE ██
///
/// The finding was never that this constant is empty — empty is correct for a build with nowhere
/// to sync to. It was that **no release gate named it**, while the checklist *did* force the
/// releaser to substitute a relay address into four invitation mails that nothing reads. So the
/// two substitutions are now one act, held by one row:
///
///   1. this constant, and `SYNC_ORIGIN_BUILTIN` in `shell-macos/main.swift` — byte for byte;
///   2. the `SERVERADRESSE` / `SERVER ADDRESS` line in all four
///      `docs/v2/email/invitation.{de,en}.{txt,html}` files.
///
/// `tests/tier1/release-gate.test.js` §1c fails when those halves are in different states. It
/// runs inside `npm test`, which `docs/v2/RELEASE-CHECKLIST.md` §B requires green before a tag.
///
/// While this is `""` the invitations carry `https://serveradresse-fehlt.invalid`; RFC 2606 §2
/// reserves `.invalid` so no registry can delegate it. `is_reserved_sync_host` below refuses it
/// here too, so pasting the placeholder in by mistake is a named local refusal.
const SYNC_ORIGIN_BUILTIN: &str = "";

const SYNC_PREFS_FILE: &str = "sync.json";

/// EVERY path this command may address — `net.js`'s `PATH_PREFIX`.
const SYNC_PATH_PREFIX: &str = "/api/v1/";

/// `net.js`'s `DEFAULT_TIMEOUT_MS`. ADR 003 §8.2 counts a timeout as a transport error; without
/// one the backoff loop would simply stop.
const SYNC_TIMEOUT_SECS: u64 = 15;

/// `net.js`'s `MAX_REQUEST_BYTES` (ADR 003 §6.1).
const SYNC_MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// A pull of 500 envelopes is the largest honest answer (ADR 003 §3.2). Without a cap, a hostile
/// or broken relay decides how much memory this process allocates.
const SYNC_MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const SYNC_MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;

/// The four headers `buildRequest` emits. `Cookie`, `Host`, `Origin`, `Referer` and every
/// `X-Forwarded-*` are absent on purpose.
const SYNC_HEADER_ALLOWLIST: [&str; 4] =
    ["x-lzp-protocol", "x-lzp-client", "authorization", "content-type"];

/// Every local refusal, named. All of them reach JavaScript as `error: "blocked"` — the only
/// vocabulary `createBridgeTransport` accepts — with the name as `reason`. The strings are
/// IDENTICAL to `SyncRefusal` in `shell-macos/main.swift`: one contract, one vocabulary, and a
/// test that reads a reason must not have to ask which shell answered.
mod sync_refusal {
    pub const SYNC_DISABLED: &str = "sync_disabled";
    pub const NO_ORIGIN: &str = "no_origin_configured";
    pub const ORIGIN_NOT_HTTPS: &str = "origin_is_not_https";
    pub const ORIGIN_IS_LOCAL: &str = "origin_host_is_local_private_or_an_ip_literal";
    pub const ORIGIN_IS_RESERVED: &str = "origin_host_is_a_reserved_name_that_cannot_resolve";
    pub const ORIGIN_SHAPE: &str = "origin_is_not_scheme_host_port";
    pub const URL_UNPARSABLE: &str = "url_did_not_parse";
    pub const URL_OFF_ORIGIN: &str = "url_is_not_the_pinned_origin";
    pub const URL_PATH: &str = "url_path_is_not_an_api_v1_path";
    pub const URL_QUERY: &str = "url_query_carries_forbidden_characters";
    pub const URL_FRAGMENT: &str = "url_carries_a_fragment";
    pub const URL_NOT_CANONICAL: &str = "url_is_not_the_canonical_rebuild";
    pub const BAD_METHOD: &str = "method_is_neither_get_nor_post";
    pub const HEADER_NOT_ALLOWED: &str = "header_is_not_on_the_allowlist";
    pub const HEADER_VALUE: &str = "header_value_is_not_printable_ascii";
    pub const BODY_ON_GET: &str = "a_get_carries_no_body";
    pub const REQUEST_TOO_LARGE: &str = "request_body_exceeds_the_cap";
}

/// The sync switch, ADR 003 §7 gate 3. Its own file for the reason the updater's prefs are in
/// theirs: one file, one question, and nothing here has a reason to open the user's board.
/// FALSE by default — a fresh install is solo, and solo makes zero requests.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(default)]
struct SyncPrefs {
    enabled: bool,
}

impl SyncPrefs {
    fn load(app: &AppHandle) -> Self {
        let path = match data_dir(app) {
            Ok(d) => d.join(SYNC_PREFS_FILE),
            Err(_) => return Self::default(),
        };
        read_opt(&path)
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save(&self, app: &AppHandle) {
        if let Ok(dir) = data_dir(app) {
            if let Ok(txt) = serde_json::to_string_pretty(self) {
                let _ = write_atomic(&dir.join(SYNC_PREFS_FILE), &txt);
            }
        }
    }
}

/// The configured origin. Build configuration and nothing else — there is no headless override
/// here because there is no headless mode; see the divergence note above.
fn sync_origin_setting() -> String {
    SYNC_ORIGIN_BUILTIN.trim().to_string()
}

/// Is this host THIS MACHINE? `127.0.0.0/8` and not `127.0.0.1` alone, because the whole /8 is
/// loopback; `*.localhost` because RFC 6761 §6.3 reserves the whole name.
fn is_loopback_sync_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    if h == "::1" || h == "0:0:0:0:0:0:0:1" {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4
        && parts[0] == "127"
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Is this host on this machine, this LAN, or otherwise not a public relay?
///
/// Deliberately BLUNT: every IP literal is refused, v4 and v6 alike, rather than a list of
/// private ranges that has to stay complete. `10.0.0.1`, `192.168.1.1`, `172.20.0.1`,
/// `169.254.169.254`, `100.64.0.1`, `127.0.0.1`, `[::1]`, `[fd00::1]` and a perfectly public
/// `93.184.216.34` all fail the same way, because a relay is a NAME.
fn is_private_or_local_sync_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty() || is_loopback_sync_host(&h) {
        return true;
    }
    // Any IPv6 literal — `::1`, `fe80::…` (link-local), `fc00::/7` (unique-local) and the rest.
    if h.contains(':') {
        return true;
    }
    // Any IPv4 literal.
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
        return true;
    }
    for suffix in [".local", ".localhost", ".lan", ".internal", ".home.arpa", ".intranet"] {
        if h.ends_with(suffix) {
            return true;
        }
    }
    // A single-label name — `router`, `nas`, `printer` — resolves on the local network and
    // nowhere else. A trailing dot would not compare equal to the pinned form.
    !h.contains('.') || h.ends_with('.')
}

/// Is this host a name the DNS root will never delegate? The Rust half of the Swift shell's
/// `isReservedSyncHost`, rule for rule.
///
/// RFC 2606 §2 reserves `.invalid` so no registry can sell it and no resolver will answer it —
/// which is what a placeholder has to be (AUDIT F13: a *claimable* `*.vercel.app` placeholder in
/// a shipped invitation lets whoever registers it collect a redeemable invite token in the
/// clear). Deliberately narrow: `.invalid` only, because `https://relay.example.org` is the
/// origin the tier-2 SSRF table drives a SUCCESSFUL request against.
fn is_reserved_sync_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    h == "invalid" || h.ends_with(".invalid")
}

/// Normalise the CONFIGURED origin to `scheme://host[:port]`, or say which rule refused it.
fn normalize_sync_origin(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(sync_refusal::NO_ORIGIN);
    }
    let u = reqwest::Url::parse(trimmed).map_err(|_| sync_refusal::ORIGIN_SHAPE)?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(sync_refusal::ORIGIN_SHAPE);
    }
    if u.query().is_some() || u.fragment().is_some() {
        return Err(sync_refusal::ORIGIN_SHAPE);
    }
    if u.path() != "/" && !u.path().is_empty() {
        return Err(sync_refusal::ORIGIN_SHAPE);
    }
    if u.scheme() != "https" {
        return Err(sync_refusal::ORIGIN_NOT_HTTPS);
    }
    let host = u.host_str().ok_or(sync_refusal::ORIGIN_SHAPE)?.to_ascii_lowercase();
    if is_private_or_local_sync_host(&host) {
        return Err(sync_refusal::ORIGIN_IS_LOCAL);
    }
    // AFTER the local check, so `localhost` keeps the name the SSRF table already gives it.
    if is_reserved_sync_host(&host) {
        return Err(sync_refusal::ORIGIN_IS_RESERVED);
    }
    Ok(match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    })
}

fn pinned_sync_origin() -> Result<String, &'static str> {
    normalize_sync_origin(&sync_origin_setting())
}

/// `net.js`'s `PATH_RE`, hand-rolled: `/api/v1` followed by one or more segments of
/// `[A-Za-z0-9._~-]` that do not begin with a dot.
fn sync_path_is_well_formed(path: &str) -> bool {
    if !path.starts_with(SYNC_PATH_PREFIX) || path.contains("..") {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 4 || !segments[0].is_empty() || segments[1] != "api" || segments[2] != "v1" {
        return false;
    }
    segments[3..].iter().all(|s| {
        !s.is_empty()
            && !s.starts_with('.')
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
    })
}

/// What `canonicalQuery()` can produce: `encodeURIComponent` output joined by `=` and `&`.
fn sync_query_is_well_formed(q: &str) -> bool {
    !q.is_empty()
        && q.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '!' | '*' | '\'' | '(' | ')' | '%' | '=' | '&')
        })
}

/// The URL this request is allowed to have, rebuilt from the PINNED origin — never from the
/// string the page sent — and then required to equal that string byte for byte.
///
/// `assertReachable`'s discipline on the far side of the bridge. A page that sends
/// `https://relay.test@evil.example/api/v1/ops`, `HTTPS://RELAY.TEST/…`, a `//evil/` path, a
/// `..`, a fragment or a double-encoded segment does not get a "close enough" — it gets refused.
fn sync_canonical_url(raw: &str, pinned: &str) -> Result<String, &'static str> {
    let u = reqwest::Url::parse(raw).map_err(|_| sync_refusal::URL_UNPARSABLE)?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(sync_refusal::URL_OFF_ORIGIN);
    }
    if u.fragment().is_some() {
        return Err(sync_refusal::URL_FRAGMENT);
    }
    let host = u.host_str().ok_or(sync_refusal::URL_UNPARSABLE)?.to_ascii_lowercase();
    let origin = match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    };
    if origin != pinned {
        return Err(sync_refusal::URL_OFF_ORIGIN);
    }
    if !sync_path_is_well_formed(u.path()) {
        return Err(sync_refusal::URL_PATH);
    }
    if let Some(q) = u.query() {
        if !sync_query_is_well_formed(q) {
            return Err(sync_refusal::URL_QUERY);
        }
    }
    let rebuilt = match u.query() {
        Some(q) => format!("{}{}?{}", pinned, u.path(), q),
        None => format!("{}{}", pinned, u.path()),
    };
    if rebuilt != raw {
        return Err(sync_refusal::URL_NOT_CANONICAL);
    }
    Ok(rebuilt)
}

/// Everything a `sync_request` is, decided before a socket exists.
struct SyncPlan {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

/// The whole gate, in one pure function. Nothing here opens a socket, resolves a name or builds a
/// client — that is what makes "solo mode makes zero requests" a property of the code rather than
/// a promise about it, and it is why `sync_perform` is unreachable except through an `Ok` here.
fn sync_preflight(
    app: &AppHandle,
    url: &str,
    method: &str,
    headers: &std::collections::HashMap<String, String>,
    body: &str,
) -> Result<SyncPlan, &'static str> {
    // 1 — the switch. ADR 003 §7 gate 3.
    if !SyncPrefs::load(app).enabled {
        return Err(sync_refusal::SYNC_DISABLED);
    }
    // 2 — the pin. Configuration, never a parameter: this command has no `origin` argument.
    let pinned = pinned_sync_origin()?;
    // 3 — the address.
    let canonical = sync_canonical_url(url, &pinned)?;
    // 4 — the method.
    let m = method.to_ascii_uppercase();
    if m != "GET" && m != "POST" {
        return Err(sync_refusal::BAD_METHOD);
    }
    // 5 — the body.
    if m == "GET" && !body.is_empty() {
        return Err(sync_refusal::BODY_ON_GET);
    }
    if body.len() > SYNC_MAX_REQUEST_BYTES {
        return Err(sync_refusal::REQUEST_TOO_LARGE);
    }
    // 6 — the headers. Allowlisted by name, printable ASCII by value: a newline in a value is a
    // header-injection attempt and a `Cookie` is ambient authority.
    let mut out = Vec::new();
    for (k, v) in headers {
        let name = k.to_ascii_lowercase();
        if !SYNC_HEADER_ALLOWLIST.contains(&name.as_str()) {
            return Err(sync_refusal::HEADER_NOT_ALLOWED);
        }
        if v.is_empty()
            || v.len() > SYNC_MAX_HEADER_VALUE_BYTES
            || !v.chars().all(|c| c.is_ascii() && !c.is_ascii_control())
        {
            return Err(sync_refusal::HEADER_VALUE);
        }
        out.push((k.clone(), v.clone()));
    }
    Ok(SyncPlan {
        url: canonical,
        method: m,
        headers: out,
        body: if body.is_empty() { None } else { Some(body.to_string()) },
    })
}

fn sync_error(kind: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({ "error": kind, "reason": reason })
}

/// The sentence for a request that was refused because it did not name the pinned origin. It
/// lives with the RULE, as `net.js`'s `insecureOriginMessage()` does, so the two cannot drift;
/// the UI picks the language.
fn sync_blocked_message() -> serde_json::Value {
    serde_json::json!({
        "de": "Diese Anfrage ging nicht an den hinterlegten Sync-Server und wurde deshalb gar \
               nicht erst gesendet.",
        "en": "This request was not addressed to the configured sync server, so it was never sent."
    })
}

/// The command. Every decision it makes is above it.
#[tauri::command]
async fn sync_request(
    app: AppHandle,
    url: String,
    method: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let hdrs = headers.unwrap_or_default();
    let plan = match sync_preflight(&app, &url, &method, &hdrs, body.as_deref().unwrap_or("")) {
        // Refused HERE: no socket, no DNS lookup, no client. Story 21.5's zero-request promise.
        Err(reason) => {
            let mut o = sync_error("blocked", reason);
            o["message"] = sync_blocked_message();
            return Ok(o);
        }
        Ok(p) => p,
    };

    // No cookie store, no proxy credentials, no automatic redirect. ADR 003 §1 — "no cookies, no
    // sessions, no bearer tokens": this transport carries a signed request and nothing ambient.
    //
    // "No cookie store" is a DEPENDENCY fact here, not a builder call: `Cargo.toml` declares
    // `reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }`, and
    // the cookie store lives behind reqwest's `cookies` feature. `.cookie_store(false)` would not
    // even compile against that declaration. This is the Rust spelling of the Swift shell's
    // `cfg.httpCookieStorage = nil` + `httpCookieAcceptPolicy = .never`, and
    // `tests/tier1/headless-shell.test.js` holds the Cargo line rather than this comment.
    // `User-Agent` is a constant: the client version already travels, once, in `X-LZP-Client`,
    // and a default agent hands the relay this machine's OS build for free (measured on the
    // Swift shell before it was pinned).
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(SYNC_TIMEOUT_SECS))
        .user_agent("LangzeitPlaner")
        .https_only(true)
        .build()
    {
        Ok(c) => c,
        Err(e) => return Ok(sync_error("transport", &format!("client_build: {e}"))),
    };

    let mut req = match plan.method.as_str() {
        "POST" => client.post(&plan.url),
        _ => client.get(&plan.url),
    };
    for (k, v) in &plan.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.header("Accept", "application/json").header("Accept-Language", "*");
    if let Some(b) = plan.body {
        req = req.body(b);
    }

    let mut resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let kind = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "offline"
            } else {
                "transport"
            };
            return Ok(sync_error(kind, "send_failed"));
        }
    };

    // FINDING P-5. With `Policy::none()` the 3xx is returned rather than followed, and a 3xx is
    // not an answer: a signed request replayed at a destination the relay chose is the attack.
    if resp.status().is_redirection() {
        return Ok(sync_error("blocked", "redirect_refused"));
    }

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let mut header_map = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        header_map.insert(
            k.as_str().to_ascii_lowercase(),
            serde_json::Value::String(v.to_str().unwrap_or("").to_string()),
        );
    }

    // The response cap, enforced AS THE BYTES ARRIVE rather than after they are all in memory —
    // otherwise the cap is a report about an allocation that already happened.
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > SYNC_MAX_RESPONSE_BYTES {
                    return Ok(sync_error("transport", "response_exceeds_the_cap"));
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                let kind = if e.is_timeout() { "timeout" } else { "transport" };
                return Ok(sync_error(kind, "body_read_failed"));
            }
        }
    }
    let text = match String::from_utf8(buf) {
        Ok(t) => t,
        Err(_) => return Ok(sync_error("transport", "response_was_not_utf8")),
    };

    Ok(serde_json::json!({
        "status": status,
        "headers": serde_json::Value::Object(header_map),
        "body": text,
        // The bytes came from here. `createBridgeTransport` refuses a reply whose `url` is not
        // the one it asked for, which is the checkable half of "no redirects".
        "url": final_url,
        "redirected": false,
    }))
}

/// What the settings sheet needs to know, and the sentence a person is shown.
///
/// The copy lives with the RULE (`net.js`'s `insecureOriginMessage()`, `crypto/probe.js`'s
/// `unavailableMessage()`), and the UI picks the language. It does not say "error": nothing has
/// gone wrong in solo mode.
///
/// `origin` is disclosed on purpose. It is not a secret — the page must build URLs against it —
/// and the page learning it grants nothing, because it could already name any URL it liked and
/// the pin would refuse it. What it buys is a settings sheet that can SHOW the one address this
/// Mac may talk to instead of asking a person to type one.
#[tauri::command]
fn sync_status(app: AppHandle) -> serde_json::Value {
    let prefs = SyncPrefs::load(&app);
    let configured = sync_origin_setting();
    match pinned_sync_origin() {
        Ok(origin) => {
            let mut o = serde_json::json!({
                "enabled": prefs.enabled,
                "configured": configured,
                "origin": origin,
                "originConfigured": true,
                "reason": serde_json::Value::Null,
            });
            if !prefs.enabled {
                o["message"] = serde_json::json!({
                    "de": "Sync ist ausgeschaltet. Solange kein Familienkreis besteht, stellt \
                           dieser Mac keine einzige Netzwerkanfrage.",
                    "en": "Sync is off. Until there is a Familienkreis, this Mac makes no network \
                           request at all."
                });
            }
            o
        }
        Err(reason) => serde_json::json!({
            "enabled": prefs.enabled,
            "configured": configured,
            "origin": serde_json::Value::Null,
            "originConfigured": false,
            "reason": reason,
            "message": {
                "de": "Diese Version hat keinen Sync-Server hinterlegt. Der Kalender läuft \
                       vollständig auf diesem Mac — es wird nichts gesendet und nichts abgerufen.",
                "en": "This build has no sync server configured. The calendar runs entirely on \
                       this Mac — nothing is sent and nothing is fetched."
            }
        }),
    }
}

/// 11.2 / 11.7 — native save dialog, dated default name.
#[tauri::command]
fn export_board(app: AppHandle, contents: String, suggested_name: String) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    match picked {
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            fs::write(path, contents).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 11.3 — the confirmation itself lives in the UI; this only reads the file.
#[tauri::command]
fn import_board(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match picked {
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            Ok(Some(fs::read_to_string(path).map_err(|e| e.to_string())?))
        }
        None => Ok(None),
    }
}

/// 13.2 / 13.3 — shell preferences the web layer cannot apply itself.
#[tauri::command]
fn set_shell_pref(app: AppHandle, key: String, value: bool) -> Result<(), String> {
    match key.as_str() {
        "launch_at_login" => {
            use tauri_plugin_autostart::ManagerExt;
            let mgr = app.autolaunch();
            if value {
                mgr.enable().map_err(|e| e.to_string())
            } else {
                mgr.disable().map_err(|e| e.to_string())
            }
        }
        // ADR 003 §7 gate 3's own switch: `sync_request` refuses everything until it is true,
        // so a build in which the family opt-in never calls this makes zero requests. Persisted,
        // and FALSE by default, so a relaunch of a solo install is solo again without asking.
        "sync_enabled" => {
            let mut p = SyncPrefs::load(&app);
            p.enabled = value;
            p.save(&app);
            Ok(())
        }
        "menu_bar_icon" => {
            if let Some(tray) = app.tray_by_id("main") {
                tray.set_visible(value).map_err(|e| e.to_string())
            } else {
                Ok(())
            }
        }
        other => Err(format!("unknown shell pref: {other}")),
    }
}

/// The menu bar fixed in §9. Every item that maps to a board action emits an
/// event the web layer already handles, so there is exactly one implementation
/// of each command.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ── 22.4 · the App menu carries the quiet hint (LZP-103) ─────────────────
    // The hint item exists ONLY while a verified build is staged: no greyed-out
    // row, no "no updates available" to click. Directly under About, above
    // „Auf Updates prüfen …“, so the answer sits above the question. Built as a
    // Vec rather than a literal slice because one of the items is conditional.
    let about = PredefinedMenuItem::about(app, Some("Über LangzeitPlaner"), Some(AboutMetadata::default()))?;
    let sep_a = PredefinedMenuItem::separator(app)?;
    let hint_item = match update_hint_value() {
        Some(v) => Some(MenuItem::with_id(
            app,
            "update-restart",
            format!("Update verfügbar ({v}) — neu starten"),
            true,
            None::<&str>,
        )?),
        None => None,
    };
    let check_item = MenuItem::with_id(app, "check-updates", "Auf Updates prüfen …", true, None::<&str>)?;
    let sep_b = PredefinedMenuItem::separator(app)?;
    let settings_item = MenuItem::with_id(app, "settings", "Einstellungen …", true, Some("CmdOrCtrl+,"))?;
    let sep_c = PredefinedMenuItem::separator(app)?;
    let hide_item = PredefinedMenuItem::hide(app, Some("LangzeitPlaner ausblenden"))?;
    let quit_item = PredefinedMenuItem::quit(app, Some("Beenden"))?;

    let mut app_items: Vec<&dyn IsMenuItem<R>> = vec![&about, &sep_a];
    if let Some(h) = hint_item.as_ref() {
        app_items.push(h);
    }
    app_items.push(&check_item);
    app_items.push(&sep_b);
    app_items.push(&settings_item);
    app_items.push(&sep_c);
    app_items.push(&hide_item);
    app_items.push(&quit_item);

    let app_menu = Submenu::with_items(app, "LangzeitPlaner", true, &app_items)?;

    let file_menu = Submenu::with_items(
        app,
        "Ablage",
        true,
        &[
            &MenuItem::with_id(app, "export", "Exportieren …", true, Some("CmdOrCtrl+Shift+E"))?,
            &MenuItem::with_id(app, "import", "Importieren …", true, Some("CmdOrCtrl+Shift+I"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "print", "Drucken …", true, Some("CmdOrCtrl+P"))?,
            &PredefinedMenuItem::separator(app)?,
            // 13.5 — ⌘W hides; the app keeps running.
            &MenuItem::with_id(app, "hide-window", "Fenster schließen", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Bearbeiten",
        true,
        &[
            &MenuItem::with_id(app, "undo", "Widerrufen", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "redo", "Wiederholen", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Ausschneiden"))?,
            &PredefinedMenuItem::copy(app, Some("Kopieren"))?,
            &PredefinedMenuItem::paste(app, Some("Einsetzen"))?,
            &PredefinedMenuItem::select_all(app, Some("Alles auswählen"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "Suchen", true, Some("CmdOrCtrl+F"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "Darstellung",
        true,
        &[
            &MenuItem::with_id(app, "today", "Heute", true, Some("CmdOrCtrl+T"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "layer-feiertage", "Feiertage", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(app, "layer-ferien", "Schulferien", true, Some("CmdOrCtrl+2"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "mode-toggle", "Modus rollierend / fixiert", true, None::<&str>)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Fenster",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Im Dock ablegen"))?,
            &PredefinedMenuItem::fullscreen(app, Some("Vollbild"))?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // LZP-102. UNVERIFIED — see the F22 section above. The plugin refuses to
        // initialise without `plugins.updater.pubkey` in tauri.conf.json, which
        // is the right failure mode: no updater key, no update path at all
        // (22.6 — "a device installs authentic builds or nothing").
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            load_board,
            save_board,
            load_snapshots,
            save_snapshots,
            load_ops,
            append_ops,
            truncate_ops,
            load_checkpoint,
            save_checkpoint,
            export_board,
            import_board,
            set_shell_pref,
            // LZP-302 · ADR 002 §2.2 — the Keychain backstop. UNVERIFIED (no
            // Rust toolchain here); shell-macos/main.swift is the reference.
            keychain_set,
            keychain_get,
            keychain_delete,
            // F22 · the updater port (LZP-102 / LZP-104). Exactly the command
            // names `bridgePort()` in src/js/platform/updater.js sends, plus the
            // two switches LZP-103's settings panel and LZP-106's first-run
            // screen need. None of them can reach board.json, ops.jsonl,
            // checkpoint.json or snapshots.json — 22.7 enforced by the size of
            // the surface rather than by discipline.
            update_status,
            update_set_disclosed,
            update_set_enabled,
            update_note_check,
            update_fetch_manifest,
            update_download,
            update_clear_staged,
            // LZP-103 · 22.4 — the quiet hint's App-menu half and the one click.
            update_menu_hint,
            update_restart,
            // LZP-1002 · story 21.5 · ADR 003 §7 gate 3 — the sync transport. The command
            // `net.js` §6 names and `chooseTransport()` picks whenever a shell invoke exists,
            // which inside a shell is always. UNVERIFIED (no cargo here) and it needs one line
            // in Cargo.toml — see the hand-off note above `sync_request`.
            sync_request,
            sync_status
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 22.3/22.4 — if the bundle was replaced during the last session, the
            // running binary IS the staged version now; drop the stale marker so
            // the quiet "Update verfügbar" hint does not outlive the update.
            clear_staged_marker_if_applied(&handle);
            app.set_menu(build_menu(&handle)?)?;

            // 13.2 — monochrome template glyph, light/dark aware, one click
            // focuses the window.
            let tray_handle = handle.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("LangzeitPlaner")
                .on_tray_icon_event(move |_tray, _event| {
                    if let Some(w) = tray_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "hide-window" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                return;
            }
            // Everything else is a board action; the web layer owns it.
            let _ = app.emit("menu", id);
        })
        .on_window_event(|window, event| {
            // ⌘W / red button hide rather than close (13.5).
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running LangzeitPlaner");
}
