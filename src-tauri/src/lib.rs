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

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
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
            update_restart
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
