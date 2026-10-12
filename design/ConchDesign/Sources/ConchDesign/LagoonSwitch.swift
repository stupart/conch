import SwiftUI

/// The lagoon switch (2026-10-11): in the Mac window's title bar, right of "conch". Off, the sessions; on, the lagoon.
/// The art is the brand repo's v2 "turned" set (generated/oct/lagoon-toggle/v2/assets), in the Mac app's asset catalog
/// under `LagoonSwitch/`; the motion is `LagoonSwitchMotion`, turned.js's timeline. 40 × 22 pt, for the 32 pt title bar.
public struct LagoonSwitch: View {
    private let isOn: Bool
    private let action: () -> Void

    /// Which way it last went and when, so a click mid-animation goes back from where the shell is.
    @State private var playhead: LagoonSwitchPlayhead
    /// The clock runs only while a change plays out.
    @State private var moving = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchHidden) private var hidden

    /// `isOn` is the page the window shows; `action` asks for the other one (it changes `isOn`, which plays the motion, so
    /// ⌘0 and the menu animate it too).
    public init(isOn: Bool, action: @escaping () -> Void) {
        self.isOn = isOn
        self.action = action
        _playhead = State(initialValue: LagoonSwitchPlayhead(isOn: isOn))
    }

    public var body: some View {
        Button(action: action) {
            TimelineView(.animation(minimumInterval: nil, paused: !moving || hidden)) { timeline in
                LagoonSwitchArtwork(playhead.pose(at: moving ? timeline.date : .distantFuture, reduceMotion: reduceMotion))
            }
            .contentShape(Capsule())
        }
        .buttonStyle(Unstyled())
        .help("Lagoon (⌘0)")
        .accessibilityLabel("Lagoon")
        .accessibilityValue(isOn ? "on" : "off")
        .accessibilityAddTraits(.isToggle)
        .onChange(of: isOn) { _, on in
            playhead.flip(toOn: on, at: Date(), reduceMotion: reduceMotion)
            moving = true
        }
        // Stops the clock once the change has played out.
        .task(id: playhead) {
            let left = playhead.length - playhead.elapsed(at: Date())
            if left > 0 { try? await Task.sleep(nanoseconds: UInt64((left + 20) * 1_000_000)) }
            if !Task.isCancelled { moving = false }
        }
    }

    /// The art is the whole control: no press tint over it.
    private struct Unstyled: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View { configuration.label }
    }
}

/// The switch's pictures (`LagoonSwitchArt.Piece`), from the app's asset catalog unless told otherwise: the frame
/// renderer hands it a compiled copy of the same catalog.
public struct LagoonSwitchArt {
    public enum Piece: String, CaseIterable, Sendable {
        /// The grey pill, and Tide's water in it, and the cream rim that comes with the water.
        case trackOff = "track-off"
        case trackOn = "track-on"
        case trackOnRim = "track-on-rim"
        /// The foam that rides the water's edge.
        case foamCollar = "foam-collar"
        /// The shell's spiral side (off) and its opening (on).
        case spiral = "knob-closed-c"
        case opening = "knob-closed-a"
        /// The OG, who lives below the opening's lower rim, and his blink.
        case crab = "knob-crab"
        case lids = "knob-lids"
    }

    public var image: (Piece) -> Image

    public init(image: @escaping (Piece) -> Image) {
        self.image = image
    }

    /// The Mac app's `Assets.xcassets/LagoonSwitch`.
    public static var catalog: LagoonSwitchArt { from(nil) }

    public static func from(_ bundle: Bundle?) -> LagoonSwitchArt {
        LagoonSwitchArt { Image("LagoonSwitch/\($0.rawValue)", bundle: bundle) }
    }
}

extension EnvironmentValues {
    @Entry public var lagoonSwitchArt: LagoonSwitchArt = .catalog
}

/// The switch at one moment: what `LagoonSwitch` draws every frame, and what the frame renderer draws offscreen. turned.js's
/// layers (v2.css), bottom to top: the grey track; the wet grey; the water, masked to hug the shell's back; the foam
/// collar; the cream rim; the shell, which slides, leans, squashes and turns, with the OG in its opening clipped to the
/// lower rim. The layout is 40 × 22; the drawing runs a few points past it, so a leaning shell and its shadow aren't cut.
public struct LagoonSwitchArtwork: View {
    public let pose: LagoonSwitchMotion.Pose
    @Environment(\.lagoonSwitchArt) private var art

    public init(_ pose: LagoonSwitchMotion.Pose) {
        self.pose = pose
    }

    private typealias Motion = LagoonSwitchMotion
    private static let overhang = 4.0

    public var body: some View {
        Canvas { context, _ in
            var context = context
            context.translateBy(x: Self.overhang, y: Self.overhang)
            let pictures = Pictures(context: context, art: art)
            switch pose {
            case let .motion(direction, t):
                Self.draw(Motion.frame(direction, at: t), pictures, in: context)
            case let .crossfade(on):
                // `.rm`: the finished states, one over the other, each at its own opacity.
                for (state, opacity) in [(false, 1 - on), (true, on)] where opacity > 0.001 {
                    var layer = context
                    layer.opacity = opacity
                    layer.drawLayer { rest in
                        rest.draw(state ? pictures.trackOn : pictures.trackOff, in: Self.track)
                        Self.drawShell(state ? .on : .off, pictures, in: rest)
                    }
                }
            }
        }
        .frame(width: Motion.width + 2 * Self.overhang, height: Motion.height + 2 * Self.overhang)
        .padding(-Self.overhang)
        .accessibilityHidden(true)
    }

    private static let track = CGRect(x: 0, y: 0, width: Motion.width, height: Motion.height)
    /// `.in`: the inside of the track, which the rim stays outside of.
    private static let inside = Path(
        roundedRect: track.insetBy(dx: Motion.insetX, dy: Motion.insetY),
        cornerRadius: Motion.insetRadius,
        style: .circular
    )

    private static func draw(_ f: Motion.Frame, _ pictures: Pictures, in context: GraphicsContext) {
        context.draw(pictures.trackOff, in: track)

        // Wet sand: the grey track, darker and a little glossier, drying from the right (`.wet`).
        if f.wet > 0.001 {
            var wet = context
            wet.opacity = f.wet
            wet.drawLayer { layer in
                layer.clip(to: inside)
                var tinted = layer
                tinted.addFilter(.colorMultiply(Color(white: 0.8)))
                tinted.addFilter(.contrast(1.06))
                tinted.addFilter(.saturation(1.25))
                tinted.draw(pictures.trackOff, in: track)
                var dried = layer
                dried.blendMode = .destinationOut
                dried.fill(Path(track), with: .linearGradient(
                    Gradient(colors: [.clear, .black]),
                    startPoint: CGPoint(x: f.dry - 6, y: 0),
                    endPoint: CGPoint(x: f.dry, y: 0)
                ))
            }
        }

        // The sea: kept left of `lin` and outside the ellipse round the shell, so it hugs the shell's back (`.water`).
        if f.water > 0.001, f.lin > 0 {
            var water = context
            water.opacity = f.water
            water.drawLayer { layer in
                layer.clip(to: inside)
                layer.draw(pictures.trackOn, in: track)
                var cut = layer
                cut.blendMode = .destinationOut
                if f.lin < Motion.width {
                    cut.fill(Path(CGRect(x: f.lin, y: -1, width: Motion.width - f.lin + 1, height: Motion.height + 2)), with: .color(.black))
                }
                if f.rx > 0.05 {
                    // radial-gradient(rx ry at cx 50%, transparent 97%, #000 100%), as the hole it leaves.
                    cut.translateBy(x: f.cx, y: Motion.height / 2)
                    cut.scaleBy(x: f.rx, y: f.ry)
                    cut.fill(Path(CGRect(x: -1, y: -1, width: 2, height: 2)), with: .radialGradient(
                        Gradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.97), .init(color: .clear, location: 1)]),
                        center: .zero, startRadius: 0, endRadius: 1
                    ))
                }
            }
        }

        // The foam collar riding that edge (`.foam`).
        if f.collar > 0.001 {
            var foam = context
            foam.opacity = f.collar
            foam.clip(to: inside)
            foam.draw(pictures.foamCollar, in: CGRect(x: f.collarX, y: 0, width: Motion.collarWidth, height: Motion.height))
        }

        // The rim turns from grey to the lagoon's cream on its own (`.rimon`).
        if f.rim > 0.001 {
            var rim = context
            rim.opacity = f.rim
            rim.draw(pictures.trackOnRim, in: track)
        }

        drawShell(Shell(f), pictures, in: context)
    }

    /// `.knob` and everything in it.
    private struct Shell {
        var x = 0.0, rotation = 0.0, squash = 0.0, turn = 1.0, shade = 1.0, face = false, crab = Motion.crabHidden, lid = 0.0

        init(_ f: Motion.Frame) {
            x = f.x
            rotation = f.lean + f.roll
            squash = f.squash
            turn = f.turn
            shade = f.shade
            face = f.face
            crab = f.crab
            lid = f.lid
        }

        init(x: Double, face: Bool, crab: Double) {
            self.x = x
            self.face = face
            self.crab = crab
        }

        /// `.rm .s-off` and `.rm .s-on`: at rest, and the OG up (`.crab{transform:none}`).
        static let off = Shell(x: 0, face: false, crab: Motion.crabHidden)
        static let on = Shell(x: Motion.travel, face: true, crab: 0)
    }

    private static func drawShell(_ shell: Shell, _ pictures: Pictures, in context: GraphicsContext) {
        // filter: drop-shadow(0 .45 .7 rgba(80,45,15,.36)), CSS's blur being twice the deviation. Drawn as a pass of its
        // own under the shell: a shadow filter over the shell itself rasterises it soft.
        var shadow = context
        shadow.addFilter(.shadow(
            color: Color(.sRGB, red: 80 / 255, green: 45 / 255, blue: 15 / 255, opacity: 0.36),
            radius: 0.35, x: 0, y: 0.45, options: .shadowOnly
        ))
        shadow.drawLayer { drawShellBody(shell, pictures, in: &$0) }
        context.drawLayer { drawShellBody(shell, pictures, in: &$0) }
    }

    private static func drawShellBody(_ shell: Shell, _ pictures: Pictures, in layer: inout GraphicsContext) {
        let w = Motion.knobWidth, h = Motion.knobHeight, box = CGRect(x: 0, y: 0, width: w, height: h)
        layer.translateBy(x: Motion.knobLeft, y: Motion.knobTop)
        // .knob: translateX(x) rotate(lean + roll), about 50% 94%.
        layer.translateBy(x: w * Motion.leanOrigin.x + shell.x, y: h * Motion.leanOrigin.y)
        layer.rotate(by: .degrees(shell.rotation))
        layer.translateBy(x: -w * Motion.leanOrigin.x, y: -h * Motion.leanOrigin.y)
        // .bob: the squash on landing, about 50% 96%.
        layer.translateBy(x: w * Motion.squashOrigin.x, y: h * Motion.squashOrigin.y)
        layer.scaleBy(x: 1 + 0.75 * shell.squash, y: 1 - shell.squash)
        layer.translateBy(x: -w * Motion.squashOrigin.x, y: -h * Motion.squashOrigin.y)
        // .turn: squeezed edge-on, about 50% 60%, and brightness(shade).
        layer.translateBy(x: w * Motion.turnOrigin.x, y: h * Motion.turnOrigin.y)
        layer.scaleBy(x: shell.turn, y: 1)
        layer.translateBy(x: -w * Motion.turnOrigin.x, y: -h * Motion.turnOrigin.y)
        if shell.shade < 1 { layer.addFilter(.colorMultiply(Color(white: shell.shade))) }

        layer.draw(shell.face ? pictures.opening : pictures.spiral, in: box)
        guard shell.face else { return }
        // .hole: the OG, only above the opening's lower rim, so he rises out of it and ducks back in.
        var hole = layer
        hole.clip(to: rim)
        let dy = shell.crab / 100 * h
        hole.draw(pictures.crab, in: box.offsetBy(dx: 0, dy: dy))
        if shell.lid > 0.001 {
            let shut = Motion.eyeTop + (Motion.eyeBottom - Motion.eyeTop) * shell.lid
            var lids = hole
            lids.clip(to: Path(CGRect(x: 0, y: dy, width: w, height: h * shut / 100)))
            lids.draw(pictures.lids, in: box.offsetBy(dx: 0, dy: dy))
        }
    }

    /// `.hole`'s polygon, in the knob's box.
    private static let rim: Path = {
        var path = Path()
        let points = Motion.rimPolygon.map { CGPoint(x: $0.x / 100 * Motion.knobWidth, y: $0.y / 100 * Motion.knobHeight) }
        path.addLines(points)
        path.closeSubpath()
        return path
    }()

    /// Every picture, resolved once per frame at the scale it is drawn at.
    private struct Pictures {
        let trackOff, trackOn, trackOnRim, foamCollar, spiral, opening, crab, lids: GraphicsContext.ResolvedImage

        init(context: GraphicsContext, art: LagoonSwitchArt) {
            func resolve(_ piece: LagoonSwitchArt.Piece) -> GraphicsContext.ResolvedImage {
                context.resolve(art.image(piece).interpolation(.high).antialiased(true))
            }
            trackOff = resolve(.trackOff)
            trackOn = resolve(.trackOn)
            trackOnRim = resolve(.trackOnRim)
            foamCollar = resolve(.foamCollar)
            spiral = resolve(.spiral)
            opening = resolve(.opening)
            crab = resolve(.crab)
            lids = resolve(.lids)
        }
    }
}
