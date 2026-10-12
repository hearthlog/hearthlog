import AppKit
import WebKit

/// One window onto the site. The title bar is hidden and the content runs under it: the page draws
/// the sidebar, the window's glass shows through it, and the standard window buttons sit on the
/// sidebar's brand row.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate, StorWebHostDelegate {
    let host: StorWebHost
    private(set) var pendingUploads = 0

    private unowned let app: AppDelegate
    private let lights: TrafficLights
    private var signIn: SignInWindowController?
    private var titleObservation: NSKeyValueObservation?

    /// Smaller than this the page would switch to its phone layout, which a Mac window never shows.
    static let minimumSize = NSSize(width: 860, height: 560)

    init(site: SiteConfig, app: AppDelegate, inspectable: Bool, restoresFrame: Bool) {
        self.app = app
        let window = StorWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = site.title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        window.contentMinSize = Self.minimumSize

        host = StorWebHost(site: site, kind: .mac, inspectable: inspectable, lightsWidth: TrafficLights.extent(of: window))
        lights = TrafficLights(window: window)

        // The glass behind the page, with one canvas tint across the window and a translucent sidebar.
        let glass = NSVisualEffectView()
        glass.material = .sidebar
        glass.blendingMode = .behindWindow
        glass.state = .followsWindowActiveState
        host.webView.frame = glass.bounds
        host.webView.autoresizingMask = [.width, .height]
        glass.addSubview(host.webView)
        window.contentView = glass
        window.pageView = host.webView

        window.center()
        if restoresFrame { window.setFrameAutosaveName("StorWindow.\(site.id)") }

        super.init(window: window)
        window.delegate = self
        host.delegate = self
        titleObservation = host.webView.observe(\.title, options: [.new]) { [weak window] webView, _ in
            if let title = webView.title, !title.isEmpty { window?.title = title }
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        lights.apply()
    }

    // MARK: Window

    func windowDidBecomeKey(_ notification: Notification) { host.setAttribute("data-stor-inactive", false) }
    func windowDidResignKey(_ notification: Notification) { host.setAttribute("data-stor-inactive", true) }
    func windowWillEnterFullScreen(_ notification: Notification) { host.setAttribute("data-stor-fullscreen", true) }
    func windowDidExitFullScreen(_ notification: Notification) {
        host.setAttribute("data-stor-fullscreen", false)
        lights.apply()
    }
    func windowWillClose(_ notification: Notification) { app.windowClosed(self) }

    // MARK: StorWebHostDelegate

    func host(_ host: StorWebHost, received message: ShellMessage) {
        switch message {
        case .lights(let x, let y): lights.move(to: CGPoint(x: x, y: y))
        case .backgroundHover(let on): (window as? StorWindow)?.backgroundHover = on
        case .outbox(let pending): pendingUploads = pending
        case .haptic, .drag: break
        case .appearance, .badge, .reminders, .menu: app.handle(message)
        }
    }

    func host(_ host: StorWebHost, openWindowFor configuration: WKWebViewConfiguration, url: URL) -> WKWebView? {
        app.openPopup(configuration: configuration, host: host)
    }

    func host(_ host: StorWebHost, showSignIn url: URL) {
        #if STOR_DEV
        DevTools.log("sign-in window for \(url)")
        #endif
        if let signIn {
            signIn.showWindow(nil)
            return
        }
        let controller = SignInWindowController(site: host.site, policy: host.policy, dataStore: host.dataStore, url: url) { [weak self] success in
            guard let self else { return }
            self.signIn = nil
            #if STOR_DEV
            DevTools.log("sign-in finished success=\(success)")
            #endif
            if success { self.host.reloadAfterSignIn() }
        }
        signIn = controller
        controller.showWindow(nil)
    }

    func host(_ host: StorWebHost, openExternally url: URL) {
        NSWorkspace.shared.open(url)
    }

    func host(_ host: StorWebHost, chooseDestinationFor suggestedFilename: String) async -> URL? {
        #if STOR_DEV
        // No panel for automated runs.
        if let directory = DevTools.environment["STOR_DEV_DOWNLOAD_DIR"] {
            DevTools.log("download \(suggestedFilename)")
            return URL(fileURLWithPath: directory).appendingPathComponent(suggestedFilename)
        }
        #endif
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        return await run(panel) == .OK ? panel.url : nil
    }

    func host(_ host: StorWebHost, savedDownload url: URL) {
        #if STOR_DEV
        DevTools.log("download saved \(url.lastPathComponent)")
        #endif
    }

    func host(_ host: StorWebHost, chooseFilesFor parameters: WKOpenPanelParameters) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        return await run(panel) == .OK ? panel.urls : nil
    }

    func host(_ host: StorWebHost, present dialog: JSDialog) async -> JSDialogResult {
        let alert = NSAlert()
        alert.messageText = host.site.title
        var field: NSTextField?
        switch dialog {
        case .alert(let message):
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
        case .confirm(let message):
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
        case .prompt(let message, let defaultText):
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
            input.stringValue = defaultText ?? ""
            alert.accessoryView = input
            field = input
        }
        let response: NSApplication.ModalResponse
        if let window { response = await alert.beginSheetModal(for: window) } else { response = alert.runModal() }
        return response == .alertFirstButtonReturn ? .ok(field?.stringValue) : .cancel
    }

    /// Shows a save or open panel as a sheet on this window.
    private func run(_ panel: NSSavePanel) async -> NSApplication.ModalResponse {
        if let window { return await panel.beginSheetModal(for: window) }
        return await panel.begin()
    }
}

/// A window the page opened itself, such as a PDF in its own viewer. It shares the site's data store
/// and follows the same navigation rules as the main window.
@MainActor
final class PopupWindowController: NSWindowController, NSWindowDelegate {
    private let onClose: (PopupWindowController) -> Void

    init(webView: WKWebView, title: String, onClose: @escaping (PopupWindowController) -> Void) {
        self.onClose = onClose
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 1040),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        webView.frame = NSRect(origin: .zero, size: window.contentLayoutRect.size)
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.center()
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func windowWillClose(_ notification: Notification) { onClose(self) }
}
