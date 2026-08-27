// render-svg — deterministic SVG/PNG compositor for the release artwork (LZP-107).
//
// Why this exists: the DMG background and the invitation-email illustration must be
// generated from committed sources, never checked in as opaque binaries. macOS 13+
// ships a native SVG rasteriser behind NSImage (_NSSVGImageRep), so a ~120-line Swift
// file replaces an image toolchain and keeps the project's zero-dependency rule intact.
//
// Rejected alternatives, recorded so nobody re-litigates them:
//   · `qlmanage -t` pads every thumbnail to a square and anchors the image at the top,
//     so the output size depends on the source aspect ratio. Measured, not assumed.
//   · `sips` cannot decode SVG at all (ImageIO has no SVG decoder).
//
// Usage:
//   render-svg <out.png> <W> <H> [ops...]
// Ops, drawn in the order given:
//   --fill    <#rrggbb>
//   --svg     <file> <x> <y> <w> <h> <rTop> <rBottom>
//   --png     <file> <x> <y> <w> <h> <rTop> <rBottom>
//   --appicon <path> <x> <y> <w> <h> <rTop> <rBottom>   // the system icon for <path>
// Coordinates are output pixels with y measured DOWNWARD from the top-left.

import AppKit

func die(_ m: String) -> Never { FileHandle.standardError.write("render-svg: \(m)\n".data(using: .utf8)!); exit(1) }

func color(_ hex: String) -> NSColor {
    var s = hex
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { die("bad colour '\(hex)' (want #rrggbb)") }
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                   blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

/// Rounded rect with independent top and bottom radii, in AppKit's y-up space.
func path(_ r: NSRect, top: CGFloat, bottom: CGFloat) -> NSBezierPath {
    let t = min(top, r.width / 2, r.height / 2), b = min(bottom, r.width / 2, r.height / 2)
    let p = NSBezierPath()
    p.move(to: NSPoint(x: r.minX, y: r.minY + b))
    if b > 0 { p.appendArc(withCenter: NSPoint(x: r.minX + b, y: r.minY + b), radius: b, startAngle: 180, endAngle: 270) }
    p.line(to: NSPoint(x: r.maxX - b, y: r.minY))
    if b > 0 { p.appendArc(withCenter: NSPoint(x: r.maxX - b, y: r.minY + b), radius: b, startAngle: 270, endAngle: 360) }
    p.line(to: NSPoint(x: r.maxX, y: r.maxY - t))
    if t > 0 { p.appendArc(withCenter: NSPoint(x: r.maxX - t, y: r.maxY - t), radius: t, startAngle: 0, endAngle: 90) }
    p.line(to: NSPoint(x: r.minX + t, y: r.maxY))
    if t > 0 { p.appendArc(withCenter: NSPoint(x: r.minX + t, y: r.maxY - t), radius: t, startAngle: 90, endAngle: 180) }
    p.close()
    return p
}

let a = CommandLine.arguments
guard a.count >= 4, let W = Int(a[2]), let H = Int(a[3]), W > 0, H > 0 else {
    die("usage: render-svg <out.png> <W> <H> [--fill #rrggbb] [--svg|--png|--appicon <src> <x> <y> <w> <h> <rTop> <rBottom>]...")
}
let out = a[1]

guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { die("cannot allocate \(W)x\(H) bitmap") }
rep.size = NSSize(width: W, height: H)

NSGraphicsContext.saveGraphicsState()
guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { die("cannot open a drawing context") }
NSGraphicsContext.current = ctx
ctx.imageInterpolation = .high

var i = 4
while i < a.count {
    let op = a[i]
    if op == "--fill" {
        guard i + 1 < a.count else { die("--fill wants a colour") }
        color(a[i + 1]).setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
        i += 2; continue
    }
    guard ["--svg", "--png", "--appicon"].contains(op) else { die("unknown op '\(op)'") }
    guard i + 7 < a.count else { die("\(op) wants <src> <x> <y> <w> <h> <rTop> <rBottom>") }
    let src = a[i + 1]
    let nums = (2...7).map { Double(a[i + $0]) }
    guard !nums.contains(where: { $0 == nil }) else { die("\(op): x y w h rTop rBottom must be numbers") }
    let x = nums[0]!, yTop = nums[1]!, w = nums[2]!, h = nums[3]!, rT = nums[4]!, rB = nums[5]!

    let img: NSImage
    if op == "--appicon" {
        guard FileManager.default.fileExists(atPath: src) else { die("no such path for --appicon: \(src)") }
        img = NSWorkspace.shared.icon(forFile: src)
    } else {
        guard let loaded = NSImage(contentsOfFile: src) else { die("cannot load \(src)") }
        if op == "--svg", !loaded.representations.contains(where: { String(describing: type(of: $0)).contains("SVG") }) {
            die("\(src) did not decode as SVG — this macOS has no SVG rasteriser (needs macOS 13+)")
        }
        img = loaded
    }
    // y flip: caller measures from the top, AppKit draws from the bottom.
    let r = NSRect(x: x, y: Double(H) - yTop - h, width: w, height: h)
    NSGraphicsContext.saveGraphicsState()
    if rT > 0 || rB > 0 { path(r, top: rT, bottom: rB).addClip() }
    img.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    i += 8
}
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { die("PNG encode failed") }
do { try png.write(to: URL(fileURLWithPath: out)) } catch { die("cannot write \(out): \(error)") }
print("  \(out)  \(W)x\(H)  \(png.count) bytes")
