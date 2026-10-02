import AppKit
import WebKit

// Compiled with mac-app/conch-mac/PageCapturer.swift and ConchDesign's sources by test/page-capture-render.test.ts:
// conch_capture's real drawing, run against pages the test serves. It reads the cases from the JSON file named first,
// writes each capture into the folder named second, and prints one JSON line per case with what came back and the
// colours at the points the test asks about, read from the PNG it wrote. A store of its own (`.nonPersistent()`), never
// a default one: nothing a test draws is kept.

struct Case: Decodable {
    let name: String
    let url: String
    let selector: String?
    let quote: String?
    let width: Double
    let height: Double
    let fullPage: Bool?
    /// Points in the page's CSS pixels (from the capture's top left) to read the colour at.
    let points: [[Double]]?
}

/// The PNG's pixels as sRGB bytes, decoded with ImageIO and drawn into an sRGB bitmap. (NSBitmapImageRep's `colorAt`
/// reads a PNG's bytes as calibrated RGB, and converting that to sRGB moved rgb(220, 30, 60) to (229, 54, 76): the
/// harness misreading, not the capture.)
struct Pixels {
    let bytes: [UInt8]
    let width: Int
    let height: Int

    init(png: Data) {
        let source = CGImageSourceCreateWithData(png as CFData, nil)!
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        width = image.width
        height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        self.bytes = bytes
    }
}

/// The sRGB colour at a pixel, from the top left.
func rgb(_ pixels: Pixels, _ x: Double, _ y: Double) -> [Int]? {
    let px = Int(x.rounded(.down)), py = Int(y.rounded(.down))
    guard px >= 0, py >= 0, px < pixels.width, py < pixels.height else { return nil }
    let at = (py * pixels.width + px) * 4
    return [Int(pixels.bytes[at]), Int(pixels.bytes[at + 1]), Int(pixels.bytes[at + 2])]
}

@MainActor
func run(_ item: Case, into folder: URL) async -> [String: Any] {
    let target: PageCapturer.Target? = item.selector.map { .selector($0) } ?? item.quote.map { .quote($0) }
    let spec = PageCapturer.Spec(
        url: URL(string: item.url)!,
        target: target,
        viewport: CGSize(width: item.width, height: item.height),
        fullPage: item.fullPage ?? false,
        deadline: Date().addingTimeInterval(36)
    )
    let started = Date()
    var line: [String: Any] = ["name": item.name]
    switch await PageCapturer.capture(spec, store: .nonPersistent()) {
    case let .success(shot):
        let file = folder.appendingPathComponent("\(item.name).png")
        try! shot.png.write(to: file)
        let rep = Pixels(png: shot.png)
        line["ok"] = true
        line["png"] = file.path
        line["width"] = shot.width
        line["height"] = shot.height
        line["scale"] = shot.scale
        line["finalUrl"] = shot.finalURL
        line["title"] = shot.title
        line["loginWall"] = shot.loginWall
        line["clipped"] = shot.clipped
        line["settled"] = shot.settled
        if let box = shot.element {
            line["element"] = [box.minX, box.minY, box.width, box.height]
            line["center"] = rgb(rep, box.midX, box.midY) as Any
            // Just outside its left edge, in the margin: the page, not the target.
            line["outside"] = rgb(rep, box.minX - 6 * shot.scale, box.midY) as Any
            // Just under it: what it sits on.
            line["below"] = rgb(rep, box.midX, box.maxY + 4 * shot.scale) as Any
        }
        line["points"] = (item.points ?? []).map { rgb(rep, $0[0] * shot.scale, $0[1] * shot.scale) as Any }
    case let .failure(failure):
        line["ok"] = false
        line["error"] = failure.message
        line["title"] = failure.title as Any
        line["finalUrl"] = failure.finalURL as Any
        line["loginWall"] = failure.loginWall
        line["headings"] = failure.headings
        if let seen = failure.seen {
            let file = folder.appendingPathComponent("\(item.name)-seen.png")
            try! seen.png.write(to: file)
            line["seen"] = file.path
        }
    }
    line["seconds"] = Date().timeIntervalSince(started)
    line["windows"] = NSApp.windows.filter(\.isVisible).count
    return line
}

let arguments = CommandLine.arguments
let cases = try! JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1])))
let folder = URL(fileURLWithPath: arguments[2])

let app = NSApplication.shared
// Never in the Dock, never in front: this process draws pages and nothing else.
app.setActivationPolicy(.prohibited)
DispatchQueue.main.asyncAfter(deadline: .now() + 170) {
    FileHandle.standardError.write("the harness ran out of time\n".data(using: .utf8)!)
    exit(3)
}
Task { @MainActor in
    for item in cases {
        let line = await run(item, into: folder)
        let data = try! JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
    }
    exit(0)
}
app.run()
