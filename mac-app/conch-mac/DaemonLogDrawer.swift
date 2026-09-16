import AppKit
import ConchDesign
import SwiftUI

struct DaemonLogDrawer: View {
    let lines: [String]

    var body: some View {
        DaemonLogTextView(text: lines.joined(separator: "\n"))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ConchPalette.raised.opacity(0.42))
    }
}

private struct DaemonLogTextView: NSViewRepresentable {
    let text: String

    final class Coordinator {
        var previousText = ""
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.borderType = .noBorder

        let textView = NSTextView()
        textView.drawsBackground = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = false
        textView.usesFindBar = false
        textView.focusRingType = .none
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textColor = NSColor(ConchPalette.textDim)
        textView.textContainerInset = NSSize(width: 12, height: 10)
        textView.minSize = .zero
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.setAccessibilityLabel("Conch daemon log")
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard context.coordinator.previousText != text,
              let textView = scrollView.documentView as? NSTextView else {
            return
        }
        let previousString = textView.string as NSString
        let selectedStrings = textView.selectedRanges.compactMap { value -> String? in
            let range = value.rangeValue
            guard range.length > 0,
                  NSMaxRange(range) <= previousString.length else {
                return nil
            }
            return previousString.substring(with: range)
        }

        context.coordinator.previousText = text
        textView.string = text
        let updatedString = textView.string as NSString
        let restoredRanges = selectedStrings.compactMap { selection -> NSValue? in
            let range = updatedString.range(of: selection)
            guard range.location != NSNotFound else { return nil }
            return NSValue(range: range)
        }
        if !restoredRanges.isEmpty {
            textView.selectedRanges = restoredRanges
        }

        guard restoredRanges.isEmpty else { return }
        DispatchQueue.main.async { [weak textView] in
            guard let textView else { return }
            textView.scrollRangeToVisible(
                NSRange(location: textView.string.utf16.count, length: 0)
            )
        }
    }
}
