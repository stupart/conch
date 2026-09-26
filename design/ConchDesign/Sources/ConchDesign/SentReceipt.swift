import SwiftUI

/// Something Tyler sent through conch itself — a canvas, a Show, a video from the phone — as the daemon sums it up
/// (`SentReceipt` in `src/conversation.ts`).
///
/// Each reaches the session as one message written for the agent: the picture's path, the files beside it, how to
/// draw an answer back. Drawn as written, his own conversation showed him a 320 pt picture of the screen he was
/// already looking at, under the agent's instructions. Tyler: "Don't need the image of the work I'm currently looking
/// at to also be in the convo if I'm currently looking at it." So the row is the one line he needs: what it was, his
/// own words from it, a thumbnail, and a click to see it whole.
public struct ConchSentReceipt: Decodable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case canvas, show, video
        /// A kind a newer daemon added: still a receipt, drawn with the plainest glyph.
        case unknown
    }

    public var kind: Kind
    /// "Marked up Invite page", "Showed Invite page · 0:23", "Sent a video · 0:42".
    public var title: String
    /// A line each: the counts, then his notes or what he said, quoted and cut short.
    public var detail: String?
    /// The picture, as a path on the Mac: the flat.png, a Show's first frame, a video's contact sheet.
    public var thumb: String?
    /// What a click opens on the Mac: the picture, or the recording itself.
    public var open: String?

    public init(kind: Kind, title: String, detail: String? = nil, thumb: String? = nil, open: String? = nil) {
        self.kind = kind
        self.title = title
        self.detail = detail
        self.thumb = thumb
        self.open = open
    }

    private enum CodingKeys: String, CodingKey { case kind, title, detail, thumb, open }

    /// Tolerant, as every conversation shape is, but never titleless: a receipt with nothing to say throws, the item
    /// decodes without it, and the row is drawn as it always was.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        guard !title.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .title, in: c, debugDescription: "a receipt says what it was")
        }
        self.title = title
        kind = Kind(rawValue: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "") ?? .unknown
        detail = (try? c.decodeIfPresent(String.self, forKey: .detail)).flatMap { $0.isEmpty ? nil : $0 }
        thumb = (try? c.decodeIfPresent(String.self, forKey: .thumb)).flatMap { $0.isEmpty ? nil : $0 }
        open = (try? c.decodeIfPresent(String.self, forKey: .open)).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Whether `sent`, a message still waiting for the transcript's copy, is the one this receipt stands for: it names
    /// the same file. The words can't say so — the receipt has none of the message's — and a bubble matched on words
    /// alone sat under its own receipt, every agent-facing line of it, for the ten minutes a bubble is kept.
    public func stands(for sent: String) -> Bool {
        [open, thumb].contains { $0.map(sent.contains) ?? false }
    }

    /// The glyph a receipt shows until its picture is read, or when the picture is gone.
    public var symbol: String {
        switch kind {
        // The canvas pill's own pen.
        case .canvas: "pencil"
        case .show: "record.circle"
        case .video: "video"
        case .unknown: "paperplane"
        }
    }
}

/// A receipt, as one quiet row in Tyler's own bubble: a small thumbnail, the title, and the detail under it in
/// secondary text. Nothing big — the picture is a click away (`action`), and the work itself is on his screen.
///
/// The bubble is the caller's, so it matches the words beside it: the Mac's `fill` at the large radius by default, the
/// phone's raised ground at its own.
public struct SentReceiptRow: View {
    /// Read off the main thread too, where a thumbnail is decoded to this size.
    nonisolated public static let thumbnailSize = CGSize(width: 44, height: 30)

    let receipt: ConchSentReceipt
    let thumbnail: Image?
    let fill: ConchColorToken
    let radius: CGFloat
    let action: () -> Void

    public init(
        receipt: ConchSentReceipt,
        thumbnail: Image?,
        fill: ConchColorToken = ConchColor.fill,
        radius: CGFloat = ConchRadius.large,
        action: @escaping () -> Void
    ) {
        self.receipt = receipt
        self.thumbnail = thumbnail
        self.fill = fill
        self.radius = radius
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: ConchSpace.x2 + 2) {
                picture
                VStack(alignment: .leading, spacing: 1) {
                    Text(receipt.title)
                        .font(ConchType.uiBody.weight(.medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(1)
                    if let detail = receipt.detail {
                        Text(detail)
                            .font(ConchType.secondary)
                            .foregroundStyle(ConchColor.textSecondary)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, 7)
            .padding(.trailing, ConchSpace.x3)
            .padding(.vertical, 7)
            .background(fill, in: RoundedRectangle(cornerRadius: radius))
            .contentShape(RoundedRectangle(cornerRadius: radius))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([receipt.title, receipt.detail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Opens it whole")
    }

    private var picture: some View {
        let shape = RoundedRectangle(cornerRadius: ConchRadius.small)
        return ZStack {
            if let thumbnail {
                thumbnail
                    .resizable()
                    .scaledToFill()
            } else {
                shape.fill(ConchColor.fill)
                Image(systemName: receipt.symbol)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ConchColor.textTertiary)
            }
        }
        .frame(width: Self.thumbnailSize.width, height: Self.thumbnailSize.height)
        .clipShape(shape)
        .overlay { shape.strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5) }
    }
}
