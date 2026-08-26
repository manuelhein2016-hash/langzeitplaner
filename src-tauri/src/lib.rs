// Native shell. Everything here exists because the board is a Mac app, not a
// web page: atomic writes to Application Support, the menu bar from §9, ⌘W
// hiding the window instead of closing it, and the optional tray icon.
//
// Zero network by architecture (13.4): no HTTP client is linked, and the CSP in
// tauri.conf.json permits `self` and the IPC channel only.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
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
    let app_menu = Submenu::with_items(
        app,
        "LangzeitPlaner",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Über LangzeitPlaner"), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Einstellungen …", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("LangzeitPlaner ausblenden"))?,
            &PredefinedMenuItem::quit(app, Some("Beenden"))?,
        ],
    )?;

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
            set_shell_pref
        ])
        .setup(|app| {
            let handle = app.handle().clone();
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
