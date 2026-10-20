import AppKit
import Combine
import SwiftUI

/// Milestone 1 of the native apps: one window that shows what the hidden engine reports, to check
/// it against the web app on the same Mac. Built with `hearthlog apple:engine <site>`.
@main
struct EngineDemoApp: App {
    @StateObject private var engine = HearthlogEngine(
        site: SiteConfig.load(),
        inspectable: Bundle.main.object(forInfoDictionaryKey: "StorInspectable") as? Bool ?? false
    )
    @StateObject private var signIn = SignInPresenter()

    var body: some Scene {
        Window(engine.site.title, id: "engine") {
            EngineStatusView(engine: engine)
                .frame(minWidth: 460, minHeight: 420)
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
        .windowResizability(.contentMinSize)
    }
}

/// Opens the shell's sign-in window for the engine and reloads the engine once Access lets the person in.
@MainActor
final class SignInPresenter: ObservableObject {
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

struct EngineStatusView: View {
    @ObservedObject var engine: HearthlogEngine
    @State private var syncError: String?

    var body: some View {
        Form {
            Section("Engine") {
                LabeledContent("State", value: stateText)
                LabeledContent("Bridge", value: "version \(EngineBridge.version)")
                if case .ready(let context) = engine.state {
                    LabeledContent("Site", value: "\(context.title) (\(context.tenantId))")
                    LabeledContent("Log", value: context.logName ?? context.logId ?? "None")
                }
            }
            if let status = engine.status {
                Section("Sync") {
                    LabeledContent("Phase", value: status.phase.capitalized)
                    LabeledContent("Network", value: status.isOnline ? "Online" : "Offline")
                    LabeledContent("Waiting to upload", value: "\(status.pendingUploads)")
                    LabeledContent("Needs attention", value: "\(status.needsAttention)")
                    LabeledContent("Last synced") {
                        if let date = status.lastSynced { Text(date, style: .relative) + Text(" ago") } else { Text("Never") }
                    }
                    LabeledContent("Signed in", value: status.signedIn ? "Yes" : "No")
                    LabeledContent("Active", value: status.active ? "Yes" : "No")
                    if let message = status.errorMessage {
                        Text(message).foregroundStyle(.red)
                    }
                }
            }
            if let syncError {
                Text(syncError).foregroundStyle(.red)
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItem {
                Button("Sync Now", systemImage: "arrow.triangle.2.circlepath") {
                    Task {
                        do { try await engine.syncNow(); syncError = nil }
                        catch { syncError = error.localizedDescription }
                    }
                }
                .disabled(engine.status?.ready != true)
            }
            ToolbarItem {
                Button("Reload Engine", systemImage: "arrow.clockwise") { engine.reload() }
            }
        }
    }

    private var stateText: String {
        switch engine.state {
        case .starting: "Starting…"
        case .signInRequired: "Waiting for sign-in"
        case .ready: "Ready"
        case .failed(let message): message
        }
    }
}
