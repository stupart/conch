import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Measure a screenshot NUMERICALLY, so "the tint looks off" becomes a number that
// can be compared between two runs.
//
//   swift tools/pixels.swift stats <img.png> [x y w h]    mean RGBA, chroma, luma, stddev
//   swift tools/pixels.swift ink   <img.png> [x y w h]    extent of the accent caret and of the text ink
//   swift tools/pixels.swift synth <out.png>              a fixture of KNOWN geometry, for the row-order test
//
// Two rules this file exists to enforce, both of them paid for in wasted hours:
//
// 1. ROWS ARE COUNTED FROM THE TOP. A scanner that reads rows bottom-up gives a
//    perfectly mirrored, entirely plausible, WRONG answer — "the caret sits below
//    the glyph" when it sits above — and nothing in the output looks wrong. The
//    direction is pinned by `synth`, whose marks are at known y, and by the test
//    over it in test/ui-snapshot.test.ts. Do not "simplify" that test away.
// 2. NOTHING FOUND SAYS SO. The prototype reported an empty search as negative
//    heights and reversed ranges (`y 44...-1  height -44`), which reads as a broken
//    measurement rather than an empty one. A whole session was lost scanning for a
//    caret in a field that had no keyboard focus, where the correct answer was
//    always "there is no caret here".
//
// Region defaults to the WHOLE image. Cropping blind is what produced most of the
// bad measurements; pass a region only once you know it from live geometry.

/// A region of a PNG as 8-bit sRGB RGBA, row 0 at the TOP of the image (see rule 1).
struct Bitmap {
    let width: Int, height: Int, origin: CGPoint
    let px: [UInt8]

    subscript(col: Int, row: Int) -> (r: Int, g: Int, b: Int, a: Int) {
        let i = (row * width + col) * 4
        return (Int(px[i]), Int(px[i + 1]), Int(px[i + 2]), Int(px[i + 3]))
    }

    static func load(_ path: String, region: CGRect?) -> Bitmap {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            fail("cannot read an image at \(path)")
        }
        let whole = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        // Refused BEFORE `.integral`, which standardises a negative-width rect into a
        // perfectly valid one somewhere else in the image. A crop meant for a 144px
        // panel came back as a 16px patch of the backdrop that way, and reported it as
        // the panel: mean 128.0, chroma 0.00, sd 0.00 — every number true, and every
        // one of them about the wrong pixels. A region with no area is the caller's
        // arithmetic mistake, and saying so is the only safe answer.
        // `.size.width`, not `.width`: CGRect's width property ALSO normalises, so the
        // obvious check reads 16 for a width of -16 and passes a broken crop straight
        // through. The same trap twice, one level further down.
        if let region, region.size.width < 1 || region.size.height < 1 {
            fail("region \(short(region)) has no area — a width or height below 1 is an arithmetic mistake in the caller, not a region")
        }
        let rect = (region ?? whole).integral
        guard whole.contains(rect), rect.width >= 1, rect.height >= 1 else {
            fail("region \(short(rect)) is not inside the image, which is \(image.width)x\(image.height)")
        }
        // Cropping in CGImage space, where y is measured from the TOP, so the region a
        // caller reads off a screenshot means the same thing here.
        guard let crop = image.cropping(to: rect) else { fail("cropping to \(short(rect)) failed") }
        let (w, h) = (Int(rect.width), Int(rect.height))
        var buffer = [UInt8](repeating: 0, count: w * h * 4)
        guard let context = CGContext(
            data: &buffer, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { fail("cannot make an \(w)x\(h) bitmap context") }
        context.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        return Bitmap(width: w, height: h, origin: rect.origin, px: buffer)
    }
}

func luma(_ p: (r: Int, g: Int, b: Int, a: Int)) -> Double {
    0.2126 * Double(p.r) + 0.7152 * Double(p.g) + 0.0722 * Double(p.b)
}

func short(_ rect: CGRect) -> String {
    String(format: "%.0f,%.0f %.0fx%.0f", rect.minX, rect.minY, rect.width, rect.height)
}

func fail(_ reason: String) -> Never {
    FileHandle.standardError.write(Data("pixels: \(reason)\n".utf8))
    exit(1)
}

/// The extent of something found in the region, or nothing at all. The distinction is
/// the whole point: `nil` prints as NOT FOUND rather than as a negative height.
struct Extent {
    var minX = Int.max, maxX = Int.min, minY = Int.max, maxY = Int.min
    var found: Bool { maxX >= minX }

    mutating func add(col: Int, row: Int) {
        minX = min(minX, col); maxX = max(maxX, col)
        minY = min(minY, row); maxY = max(maxY, row)
    }

    func line(_ label: String, missing: String) -> String {
        guard found else { return "\(label)  NOT FOUND — \(missing)" }
        return String(
            format: "%@  x %d...%d  y %d...%d  (w %d, h %d)",
            label, minX, maxX, minY, maxY, maxX - minX + 1, maxY - minY + 1
        )
    }
}

func statsCommand(_ bitmap: Bitmap) {
    var sr = 0.0, sg = 0.0, sb = 0.0, sa = 0.0, chroma = 0.0, sl = 0.0, sl2 = 0.0
    let n = Double(bitmap.width * bitmap.height)
    for row in 0..<bitmap.height {
        for col in 0..<bitmap.width {
            let p = bitmap[col, row]
            sr += Double(p.r); sg += Double(p.g); sb += Double(p.b); sa += Double(p.a)
            chroma += Double(max(p.r, max(p.g, p.b)) - min(p.r, min(p.g, p.b)))
            let l = luma(p)
            sl += l; sl2 += l * l
        }
    }
    let meanLuma = sl / n, meanAlpha = sa / n
    print("region \(short(CGRect(x: bitmap.origin.x, y: bitmap.origin.y, width: CGFloat(bitmap.width), height: CGFloat(bitmap.height)))) (y from the TOP)")
    print(String(
        format: "R %.1f  G %.1f  B %.1f  A %.1f  chroma %.2f  luma %.1f  sd %.2f",
        sr / n, sg / n, sb / n, meanAlpha, chroma / n, meanLuma, (sl2 / n - meanLuma * meanLuma).squareRoot()
    ))
    // An offscreen capture of a panel is transparent where its blur lives: the colours
    // above are then premultiplied over BLACK and comparing them to an opaque shot is
    // comparing two different things.
    if meanAlpha < 254 {
        print(String(format: "NOT OPAQUE (mean alpha %.1f of 255) — these colours are premultiplied over black, not what an eye sees", meanAlpha))
    }
}

func inkCommand(_ bitmap: Bitmap) {
    // Dark mode inverts which pixels are "ink". Judging a dark panel with the
    // light-mode rule finds nothing and reads as a broken scan — an hour went into
    // exactly that, comparing a light reference against a dark app.
    var background = 0.0
    for row in 0..<bitmap.height {
        for col in 0..<bitmap.width { background += luma(bitmap[col, row]) }
    }
    background /= Double(bitmap.width * bitmap.height)
    let darkMode = background < 128
    let inkRule = darkMode ? "luma > \(Int(background) + 60) (light ink on a dark ground)" : "luma < 150 (dark ink on a light ground)"

    var caret = Extent(), ink = Extent()
    for row in 0..<bitmap.height {
        for col in 0..<bitmap.width {
            let p = bitmap[col, row]
            if p.b > p.r + 50 && p.b > p.g + 40 {
                caret.add(col: col, row: row)
            } else if darkMode ? luma(p) > background + 60 : luma(p) < 150 {
                ink.add(col: col, row: row)
            }
        }
    }
    print("region \(short(CGRect(x: bitmap.origin.x, y: bitmap.origin.y, width: CGFloat(bitmap.width), height: CGFloat(bitmap.height)))) (y from the TOP)")
    print(String(format: "mean luma %.1f — ink rule: %@; caret rule: blue > red+50 and > green+40", background, inkRule))
    print(caret.line("caret", missing: "no pixel in this region is accent blue"))
    print(ink.line("text ", missing: "no pixel in this region matches the ink rule"))
    guard caret.found, ink.found else {
        print("no comparison: \(caret.found ? "text" : "caret") NOT FOUND")
        return
    }
    // y grows DOWNWARD, so a smaller y is higher on the screen.
    let top = ink.minY - caret.minY, bottom = caret.maxY - ink.maxY
    print("caret top is \(abs(top)) px \(top >= 0 ? "ABOVE" : "BELOW") the text top")
    print("caret bottom is \(abs(bottom)) px \(bottom >= 0 ? "BELOW" : "ABOVE") the text bottom")
}

/// A fixture of known geometry: a blue caret mark at y 10...39 and a dark ink mark at
/// y 60...79, both measured from the TOP. The gap between them is deliberately
/// asymmetric so a bottom-up scanner cannot produce the same answer by accident.
func synthCommand(_ path: String) {
    let (w, h) = (120, 100)
    guard let context = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { fail("cannot make the fixture's context") }
    context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: w, height: h))
    // CGContext's y grows UPWARD, so a mark meant to land at rows 10...39 from the top
    // is drawn at y = 100 - 40. Getting this wrong is the very mistake being pinned.
    context.setFillColor(CGColor(srgbRed: 0.1, green: 0.3, blue: 0.95, alpha: 1))
    context.fill(CGRect(x: 20, y: h - 40, width: 4, height: 30))
    context.setFillColor(CGColor(srgbRed: 0.1, green: 0.1, blue: 0.1, alpha: 1))
    context.fill(CGRect(x: 40, y: h - 80, width: 50, height: 20))
    guard let image = context.makeImage(),
          let out = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fail("cannot write \(path)") }
    CGImageDestinationAddImage(out, image, nil)
    guard CGImageDestinationFinalize(out) else { fail("cannot finalise \(path)") }
    print("\(path) — caret y 10...39, text y 60...79, measured from the TOP")
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first, args.count >= 2 else {
    fail("usage: pixels.swift stats|ink <img.png> [x y w h]  |  pixels.swift synth <out.png>")
}
if command == "synth" { synthCommand(args[1]); exit(0) }
guard ["stats", "ink"].contains(command) else { fail("unknown command '\(command)'") }
var region: CGRect?
if args.count == 6 {
    guard let x = Double(args[2]), let y = Double(args[3]), let w = Double(args[4]), let h = Double(args[5]) else {
        fail("region must be four numbers: x y w h")
    }
    region = CGRect(x: x, y: y, width: w, height: h)
} else if args.count != 2 {
    fail("a region is four numbers (x y w h), or leave it off for the whole image")
}
let bitmap = Bitmap.load(args[1], region: region)
if command == "stats" { statsCommand(bitmap) } else { inkCommand(bitmap) }
