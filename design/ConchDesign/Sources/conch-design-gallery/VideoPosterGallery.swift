import ConchDesign
import SwiftUI

/// A video deliverable's card in the conversation (2026-11-24, `VideoPosterView`): its poster at the video's own shape,
/// a screen recording's and a phone's portrait one under the 420 pt cap, with the play mark and its length; and the
/// symbol row it shows until the poster is read, or for good when there is none (a webm, a file that won't decode). The
/// card is drawn as the Mac's `ArtifactPreview` draws it, in the conversation's 700 pt column. The frames are the
/// invented app the sent-receipts page uses, not read from a video.
func renderVideoPosters() throws {
    let frames = MainActor.assumeIsolated { () -> (wide: CGImage, tall: CGImage)? in
        let renderer = ImageRenderer(content: OtherApp().frame(width: m3Screen.width, height: m3Screen.height).environment(\.conchRendersStatically, true))
        renderer.scale = 1
        guard let screen = renderer.cgImage, let tall = screen.cropping(to: CGRect(x: 300, y: 0, width: 422, height: 750)) else { return nil }
        return (screen, tall)
    }
    guard let frames else { fatalError("could not draw the video posters' frames") }
    let wide = VideoPoster(key: "wide", image: frames.wide, aspect: 16 / 10, length: 42, at: 3)
    let tall = VideoPoster(key: "tall", image: frames.tall, aspect: 9 / 16, length: 8, at: 0.8)
    try render("video-poster", width: 780) {
        Heading(title: "A video deliverable's card", note: "A frame a tenth of the way in (at least 0.5 s, at most 3 s), at the video's own shape, with the play mark and its length. Until it is read, or when it can't be, the symbol row.")
        DeliverableCardFixture(summary: "Screen recording of the invite flow: check the header no longer jumps on scroll") {
            VideoPosterView(poster: wide, cornerRadius: 8).frame(maxWidth: .infinity, maxHeight: 420)
        }
        Caption("A phone's portrait recording, capped at 420 pt and centred, as a tall picture is:")
        DeliverableCardFixture(summary: "The onboarding on an iPhone 15, start to finish") {
            VideoPosterView(poster: tall, cornerRadius: 8).frame(maxWidth: .infinity, maxHeight: 420)
        }
        Caption("While the poster is read, and for a webm or a video that won't decode:")
        DeliverableCardFixture(summary: "Screen recording of the invite flow: check the header no longer jumps on scroll", symbol: "play.rectangle") {
            EmptyView()
        }
    }
}

/// `ArtifactPreview`'s card in ConchDesign's tokens: the preview, then the symbol (when there is no preview) and the
/// summary, in a hairline at 14 pt.
private struct DeliverableCardFixture<Preview: View>: View {
    let summary: String
    var symbol: String?
    @ViewBuilder let preview: () -> Preview

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            preview()
            HStack(alignment: .center, spacing: 10) {
                if let symbol {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(ConchColor.ground)
                        .frame(width: 44, height: 44)
                        .overlay(Image(systemName: symbol).font(.system(size: 15)).foregroundStyle(ConchColor.ready.opacity(0.85)))
                }
                Text(summary)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
        }
        .padding(8)
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: 700)
        .background(ConchColor.surface, in: RoundedRectangle(cornerRadius: ConchRadius.large))
    }
}
