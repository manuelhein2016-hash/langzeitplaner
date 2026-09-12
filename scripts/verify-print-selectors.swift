// scripts/verify-print-selectors.swift — 12.4's selectors, asked of the Obj-C runtime itself.
//
// WHY THIS FILE EXISTS. `print_board` in src-tauri/src/lib.rs drives NSPrintOperation through
// `objc2::msg_send!`, which sends whatever selector name it is handed. A wrong name is not a
// compile error, it is "unrecognized selector sent to instance" — a crash, at runtime, in the
// shipped app, on a path no test in this repository can reach.
//
// It shipped once as `runModalForWindow:delegate:didRunSelector:contextInfo:`. That selector is
// real — on NSApplication — which is exactly why it survived a reading of the Rust bindings. On
// NSPrintOperation it does not exist, and CmdOrCtrl+P would have crashed the app the first time
// anybody pressed it. The Swift shell spells the same call `runModal(for:delegate:didRun:
// contextInfo:)`, which maps to `runOperationModalForWindow:…`, so main.swift was always right.
//
// The runtime is the only authority that cannot be misread:
//
//     swiftc -O -o /tmp/vps scripts/verify-print-selectors.swift -framework AppKit && /tmp/vps
//
// Every line must print ✓ except the one deliberately marked as the mistake. Run it after any
// change to `print_board`'s message sequence.

import AppKit
let cls: AnyClass = NSPrintOperation.self
for name in ["runOperationModalForWindow:delegate:didRunSelector:contextInfo:",
             // THE MISTAKE, kept as the control: this one must print ✗.
             "runModalForWindow:delegate:didRunSelector:contextInfo:",
             "runOperation", "view", "setShowsPrintPanel:", "setShowsProgressPanel:"] {
  let ok = cls.instancesRespond(to: Selector(name))
  print("\(ok ? "✓" : "✗")  NSPrintOperation responds to \(name)")
}
let pi: AnyClass = NSPrintInfo.self
for name in ["setOrientation:", "setTopMargin:", "setHorizontalPagination:",
             "setHorizontallyCentered:", "paperSize", "copy"] {
  print("\(pi.instancesRespond(to: Selector(name)) ? "✓" : "✗")  NSPrintInfo responds to \(name)")
}
