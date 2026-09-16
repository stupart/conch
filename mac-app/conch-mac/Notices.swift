import AppKit
import ConchDesign
import SwiftUI

/// Everything the window has to SAY, above the work.
///
/// These seven notices were stacked inline in `DashboardView.body`, between the header and the
/// sidebar/stage split — which is exactly where the workspace spec needs the stage to become an
/// inset panel. They are one view now, in the order they were in: a stale build, a daemon that
/// is not running, whichever of the three audio states holds (C9b Cut B), a transient audio
/// message, and the plugin hint.
///
/// It reads the same three environment objects the dashboard does; they are injected, not
/// plumbed, so nothing had to be passed in.
struct WorkspaceNotices: View {
    @EnvironmentObject private var store: StateStore
    @EnvironmentObject private var daemon: DaemonHost
    @EnvironmentObject private var audio: AudioHolderStore

    /// Nil while conch is working, so the bar only appears when it earns its
    /// space. A daemon we adopted from a terminal is working fine and needs no
    /// banner — it is simply not ours to stop.
    private var daemonTrouble: String? {
        switch daemon.state {
        case .running, .adopted: return nil
        case .starting: return "Starting conch…"
        case .stopped: return "conch is off."
        case .failed(let reason): return reason
        }
    }

    var body: some View {
        VStack(spacing: 0) {
    if store.staleBuild {
        HStack(spacing: 10) {
            Image(systemName: "arrow.trianglehead.2.clockwise")
                .font(.system(size: 10.5, weight: .medium))
            Text(store.relaunchFailure ?? "A newer conch is installed — this window is still running the old one.")
                .font(ConchTypography.font(size: 11.5))
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Button("Relaunch", action: store.relaunchForNewBuild)
                .buttonStyle(.plain)
                .font(ConchTypography.font(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.statusWorking)
        }
        .foregroundStyle(ConchPalette.statusWaiting)
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchPalette.raised)

        Rectangle()
            .fill(ConchPalette.divider)
            .frame(height: 1)
    }

    // The daemon runs inside this app, so when it is down the app
    // is the only place that can say so. Silence here is what
    // "couldn't reach your Mac" looked like from the outside.
    if let trouble = daemonTrouble {
        HStack(spacing: 10) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 10.5, weight: .medium))
            Text(trouble)
                .font(ConchTypography.font(size: 11.5))
            Spacer(minLength: 8)
            Button("Start", action: daemon.start)
                .buttonStyle(.plain)
                .font(ConchTypography.font(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.statusWorking)
        }
        .foregroundStyle(ConchPalette.statusWaiting)
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchPalette.raised)

        Rectangle()
            .fill(ConchPalette.divider)
            .frame(height: 1)
    }

    // C9b Cut B. Another Mac holds this one's voice and ear: say so,
    // and offer the one control that changes it. Typed sends and
    // everything else keep working; only the mic and the mode
    // control below are dimmed.
    if let host = audio.controlledBy {
        HStack(spacing: 10) {
            Image(systemName: "speaker.slash")
                .font(.system(size: 10.5, weight: .medium))
            Text("Controlled by \(host) —")
                .font(ConchTypography.font(size: 11.5))
            Button("Take it", action: audio.takeIt)
                .buttonStyle(.plain)
                .font(ConchTypography.font(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.brandCyan)
            Spacer(minLength: 8)
        }
        .foregroundStyle(ConchPalette.textDim)
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchPalette.raised)

        Rectangle()
            .fill(ConchPalette.divider)
            .frame(height: 1)
    } else if !audio.silentHosts.isEmpty {
        // Drawn from the PEER's document, and only while it is online.
        HStack(spacing: 10) {
            Image(systemName: "speaker.wave.2")
                .font(.system(size: 10.5, weight: .medium))
            Text("You hold audio · \(audio.silentHosts.joined(separator: ", ")) is silent")
                .font(ConchTypography.font(size: 11.5))
            Spacer(minLength: 8)
            Button("Give it back", action: audio.releaseAll)
                .buttonStyle(.plain)
                .font(ConchTypography.font(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
        }
        .foregroundStyle(ConchPalette.brandCyan)
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchPalette.raised)

        Rectangle()
            .fill(ConchPalette.divider)
            .frame(height: 1)
    } else if !audio.takeableHosts.isEmpty {
        // Both Macs local: the first transfer has to start somewhere.
        HStack(spacing: 10) {
            Image(systemName: "speaker.wave.1")
                .font(.system(size: 10.5, weight: .medium))
            Text("\(audio.takeableHosts.joined(separator: ", ")) speaks for itself —")
                .font(ConchTypography.font(size: 11.5))
            Button("Take it", action: audio.takeIt)
                .buttonStyle(.plain)
                .font(ConchTypography.font(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.brandCyan)
            Spacer(minLength: 8)
        }
        .foregroundStyle(ConchPalette.textDim)
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchPalette.raised)

        Rectangle()
            .fill(ConchPalette.divider)
            .frame(height: 1)
    }
    if let note = audio.message {
        Text(note)
            .font(ConchTypography.font(size: 11))
            .foregroundStyle(ConchPalette.statusWaiting)
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    if store.pluginHintVisible {
        PluginHintBar(onDismiss: store.dismissPluginHint)
        Rectangle()
            .fill(ConchPalette.divider)
            .frame(height: 1)
    }
        }
    }
}

/// One quiet line telling the user the editor plugin exists.
private struct PluginHintBar: View {
    let onDismiss: () -> Void
    @State private var copied = false

    private static let command = "/plugin marketplace add Blueprint-Studio-AI/claude-code-marketplace"

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "puzzlepiece.extension")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)

            Text("Talk to your sessions from inside Claude Code or Codex — add the conch plugin.")
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 8)

            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(Self.command, forType: .string)
                copied = true
            } label: {
                Text(copied ? "Copied" : "Copy command")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(copied ? ConchPalette.statusWorking : ConchPalette.textPrimary)
            }
            .buttonStyle(.plain)
            .help(Self.command)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ConchPalette.textDim)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(ConchPalette.raised)
    }
}
