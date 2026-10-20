#if os(macOS)
import AppKit
import Combine
import SwiftUI

extension View {
    /// Runs `engine` for this window's app: starts it, shows the Access sign-in when it asks, and tells it whether the
    /// app is active. Every native app's main window uses it once.
    func runsEngine(_ engine: HearthlogEngine) -> some View {
        modifier(EngineRunner(engine: engine))
    }
}

private struct EngineRunner: ViewModifier {
    @ObservedObject var engine: HearthlogEngine
    // Not `@State`: in recent SDKs that is a macro whose plugin ships only with Xcode, and these apps build with the
    // Command Line Tools.
    @StateObject private var signIn = EngineSignInPresenter()

    func body(content: Content) -> some View {
        content
            .task { engine.startIfNeeded() }
            .onChange(of: engine.state) { _, state in
                if case .signInRequired(let url) = state { signIn.present(url, engine: engine) }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didHideNotification)) { _ in
                Task { await engine.setActive(false) }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didUnhideNotification)) { _ in
                Task { await engine.setActive(true) }
            }
    }
}

/// Opens the shell's sign-in window for the engine and reloads the engine once Access lets the person in.
@MainActor
final class EngineSignInPresenter: ObservableObject {
    private var controller: SignInWindowController?

    func present(_ url: URL, engine: HearthlogEngine) {
        guard controller == nil else { return }
        let controller = SignInWindowController(site: engine.site, policy: engine.policy, dataStore: engine.dataStore, url: url) { [weak self, weak engine] success in
            self?.controller = nil
            if success { engine?.reload() }
        }
        self.controller = controller
        controller.showWindow(nil)
    }
}
#endif
