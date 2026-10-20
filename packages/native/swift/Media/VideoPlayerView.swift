#if os(macOS)
import Combine
import SwiftUI

/// The video with floating controls in a translucent capsule, as macOS players draw them: play and pause, ten
/// seconds back and forward, a scrubber with elapsed and remaining time, and volume. The controls fade out after two
/// seconds without the pointer moving, while playing. Space plays and pauses, the arrow keys seek five seconds.
struct VideoPlayerView: View {
    @ObservedObject var player: MPVPlayer
    /// Tick marks on the scrubber, in seconds (bookmarks).
    var marks: [Double] = []

    @StateObject private var hud = PlayerHUDState()

    var body: some View {
        ZStack(alignment: .bottom) {
            MPVVideoView(player: player)
            if let problem = player.problem {
                Text(problem)
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                    .frame(maxHeight: .infinity)
            } else if player.isBuffering || !player.isLoaded {
                ProgressView().controlSize(.large).frame(maxHeight: .infinity)
            }
            PlayerControls(player: player, marks: marks, hud: hud)
                .padding(.horizontal, 48)
                .padding(.bottom, 16)
                .opacity(hud.visible || player.isPaused ? 1 : 0)
                .animation(.easeOut(duration: 0.25), value: hud.visible || player.isPaused)
        }
        .background(.black)
        .onContinuousHover { phase in
            if case .active = phase { hud.poke() }
        }
        .focusable()
        .focusEffectDisabled()
        .onKeyPress(.space) { player.togglePause(); hud.poke(); return .handled }
        .onKeyPress(.leftArrow) { player.seek(by: -5); hud.poke(); return .handled }
        .onKeyPress(.rightArrow) { player.seek(by: 5); hud.poke(); return .handled }
    }
}

/// Whether the controls show: a pointer movement shows them for two seconds.
@MainActor
final class PlayerHUDState: ObservableObject {
    @Published private(set) var visible = true
    /// The scrubber's position while it is being dragged.
    @Published var scrubbing: Double?
    private var hide: Task<Void, Never>?

    func poke() {
        visible = true
        hide?.cancel()
        hide = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, self?.scrubbing == nil else { return }
            self?.visible = false
        }
    }
}

private struct PlayerControls: View {
    @ObservedObject var player: MPVPlayer
    let marks: [Double]
    @ObservedObject var hud: PlayerHUDState

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 18) {
                Image(systemName: player.volume == 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .frame(width: 18)
                Slider(value: Binding(get: { player.volume }, set: { player.setVolume($0) }), in: 0...100)
                    .controlSize(.mini)
                    .frame(width: 72)
                Spacer()
                button("gobackward.10", "Back 10 Seconds") { player.seek(by: -10) }
                button(player.isPaused ? "play.fill" : "pause.fill", player.isPaused ? "Play" : "Pause", size: 22) { player.togglePause() }
                button("goforward.10", "Forward 10 Seconds") { player.seek(by: 10) }
                Spacer()
                Color.clear.frame(width: 108, height: 1)
            }
            HStack(spacing: 10) {
                Text(clock(hud.scrubbing ?? player.position)).monospacedDigit()
                ZStack {
                    Slider(
                        value: Binding(get: { hud.scrubbing ?? player.position }, set: { value in
                            hud.scrubbing = value
                            player.seek(to: value, exact: false)
                        }),
                        in: 0...max(player.duration, 1),
                        onEditingChanged: { editing in
                            if !editing, let value = hud.scrubbing {
                                player.seek(to: value)
                                hud.scrubbing = nil
                            }
                            hud.poke()
                        }
                    )
                    .controlSize(.small)
                    GeometryReader { geometry in
                        ForEach(marks.filter { player.duration > 0 && $0 <= player.duration }, id: \.self) { mark in
                            Capsule()
                                .fill(.yellow)
                                .frame(width: 2, height: 8)
                                .position(x: geometry.size.width * mark / player.duration, y: geometry.size.height / 2)
                        }
                    }
                    .allowsHitTesting(false)
                }
                Text("−" + clock(max(0, player.duration - (hud.scrubbing ?? player.position)))).monospacedDigit()
            }
            .font(.caption)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: 640)
        .background(.ultraThinMaterial.opacity(0.9), in: RoundedRectangle(cornerRadius: 14))
        .environment(\.colorScheme, .dark)
    }

    private func button(_ symbol: String, _ label: String, size: CGFloat = 16, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: size, weight: .semibold)).frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }

    private func clock(_ seconds: Double) -> String {
        Duration.seconds(seconds.isFinite ? seconds : 0).formatted(.time(pattern: seconds >= 3600 ? .hourMinuteSecond : .minuteSecond))
    }
}
#endif
