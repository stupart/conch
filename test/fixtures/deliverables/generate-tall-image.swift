// Generates tall.png (900x4200) for the review harness. The image is 2.6MB and
// trivially reproducible, so the GENERATOR is committed rather than the binary.
import AppKit
let size = NSSize(width: 900, height: 4200)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 0.05, green: 0.06, blue: 0.055, alpha: 1).setFill()
NSRect(origin: .zero, size: size).fill()
for i in 0..<14 {
    let y = CGFloat(i) * 300
    NSColor(calibratedHue: CGFloat(i) / 14, saturation: 0.5, brightness: 0.75, alpha: 1).setFill()
    NSRect(x: 40, y: y + 40, width: 820, height: 220).fill()
    let label = "section \(i + 1) of 14 — a tall page that must SCROLL, not shrink" as NSString
    label.draw(at: NSPoint(x: 60, y: y + 130), withAttributes: [
        .font: NSFont.boldSystemFont(ofSize: 28), .foregroundColor: NSColor.black,
    ])
}
image.unlockFocus()
let png = NSBitmapImageRep(data: image.tiffRepresentation!)!
    .representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
