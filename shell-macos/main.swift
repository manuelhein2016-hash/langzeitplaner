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

let APP_SCHEME = "app"
let APP_HOST = "localhost"

// ── headless modes ───────────────────────────────────────────────────────────
//
//   --smoke                 load the board, print one line of what it rendered
//   --test <file.js>        load the board, run <file.js> against the live DOM,
//                           print TAP, exit non-zero on any failure
//   --scratch <dir>         where the bridge's board.json/snapshots.json go in
//                           a headless run (default: a per-mode temp dir)
//
// Both headless modes are HERMETIC: every bridge write is redirected into a
// scratch directory, so a test run can never reach the user's real board. That
// is enforced by `resolveScratchDir()` below, which aborts rather than fall
// back to Application Support.

private func argValue(_ flag: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: flag), i + 1 < a.count else { return nil }
    let v = a[i + 1]
    return v.hasPrefix("--") ? nil : v
}

let isSmokeRun = CommandLine.arguments.contains("--smoke")
let testFilePath: String? = CommandLine.arguments.contains("--test") ? argValue("--test") : nil
let isTestRun = testFilePath != nil
let isHeadless = isSmokeRun || isTestRun

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

/// 11.4 — temp file + rename, so a crash mid-save cannot corrupt the board.
func writeAtomic(_ url: URL, _ contents: String) throws {
    let tmp = url.appendingPathExtension("tmp")
    try contents.write(to: tmp, atomically: false, encoding: .utf8)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
}

func readIfExists(_ url: URL) -> String? {
    try? String(contentsOf: url, encoding: .utf8)
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

    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any],
              let cmd = body["cmd"] as? String else {
            replyHandler(nil, "malformed invoke"); return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        let dir = appSupportDir()

        do {
            switch cmd {
            case "load_board":
                replyHandler(readIfExists(dir.appendingPathComponent("board.json")) ?? NSNull(), nil)

            case "save_board":
                try writeAtomic(dir.appendingPathComponent("board.json"),
                                args["contents"] as? String ?? "")
                replyHandler(NSNull(), nil)

            case "load_snapshots":
                replyHandler(readIfExists(dir.appendingPathComponent("snapshots.json")) ?? NSNull(), nil)

            case "save_snapshots":
                try writeAtomic(dir.appendingPathComponent("snapshots.json"),
                                args["contents"] as? String ?? "")
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
        cfg.userContentController.addUserScript(
            WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))

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
        webView.callAsyncJavaScript(probe, in: nil, in: .page) { result in
            switch result {
            case .success(let v): print("SMOKE \(v)")
            case .failure(let e): print("SMOKE FAILED \(e)")
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
