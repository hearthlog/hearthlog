import AppKit
import UserNotifications
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSMenuItemValidation {
    let site = SiteConfig.load()

    private lazy var menu = AppMenu(appName: site.title)
    private var controllers: [MainWindowController] = []
    private var popups: [PopupWindowController] = []
    #if STOR_DEV
    private var popupTitles: [NSKeyValueObservation] = []
    #endif

    private var inspectable: Bool {
        #if STOR_DEV
        true
        #else
        Bundle.main.object(forInfoDictionaryKey: "StorInspectable") as? Bool ?? false
        #endif
    }

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        menu.install()
        openWindow(path: "/")
        NSApp.activate()
    }

    /// The date may have moved on while the app was in the background, so the page plans its reminders again.
    func applicationDidBecomeActive(_ notification: Notification) {
        controllers.forEach { $0.host.dispatch(["type": "resume"]) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openWindow(path: "/") }
        return true
    }

    /// Right-clicking the Dock icon lists the pages the page reported, with a section's sub-pages.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        menu.dockMenu()
    }

    /// Closing the last window keeps the app, so sync and reminders carry on.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let pending = controllers.map(\.pendingUploads).max() ?? 0
        guard pending > 0 else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "Quit \(site.title)?"
        alert.informativeText = "\(pending) \(pending == 1 ? "change hasn't" : "changes haven't") been sent yet. \(pending == 1 ? "It is" : "They are") saved on this Mac and will upload the next time the app opens."
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    // MARK: Windows

    @discardableResult
    func openWindow(path: String) -> MainWindowController {
        let isFirst = controllers.isEmpty
        let controller = MainWindowController(site: site, app: self, inspectable: inspectable, restoresFrame: isFirst)
        // Another window opens just down and right of the one in front, so it never hides it exactly.
        if let window = controller.window, let front = activeController?.window {
            window.setFrameTopLeftPoint(NSPoint(x: front.frame.minX + 28, y: front.frame.maxY - 28))
        }
        controllers.append(controller)
        controller.host.load(path: path)
        controller.showWindow(nil)
        #if STOR_DEV
        DevTools.schedule(for: controller)
        #endif
        return controller
    }

    func windowClosed(_ controller: MainWindowController) {
        controllers.removeAll { $0 === controller }
    }

    func openPopup(configuration: WKWebViewConfiguration, host: StorWebHost) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = host
        webView.uiDelegate = host
        webView.isInspectable = inspectable
        let popup = PopupWindowController(webView: webView, title: site.title) { [weak self] closed in
            self?.popups.removeAll { $0 === closed }
        }
        popups.append(popup)
        popup.showWindow(nil)
        #if STOR_DEV
        DevTools.log("popup opened")
        popupTitles.append(webView.observe(\.title) { webView, _ in DevTools.log("popup title \(webView.title ?? "")") })
        #endif
        return webView
    }

    private var activeController: MainWindowController? {
        controllers.first { $0.window === NSApp.keyWindow } ?? controllers.first { $0.window?.isVisible == true }
    }

    var menuSummary: String { menu.summary }

    // MARK: Messages from the page that concern the whole app

    func handle(_ message: ShellMessage) {
        #if STOR_DEV
        DevTools.log("message \(message)")
        #endif
        switch message {
        case .appearance(let preference, _, _):
            NSApp.appearance = preference == .system ? nil : NSAppearance(named: preference == .dark ? .darkAqua : .aqua)
        case .badge(let count):
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        case .reminders(let reminders):
            #if STOR_DEV
            if DevTools.environment["STOR_DEV_NO_NOTIFICATIONS"] == "1" {
                DevTools.log("reminders planned \(ReminderScheduler.plan(reminders, now: Date()).map(\.id))")
                break
            }
            #endif
            Task { await ReminderScheduler.shared.apply(reminders) }
        case .menu(let destinations, let actions):
            menu.update(destinations: destinations, actions: actions)
        case .lights, .outbox, .haptic, .drag, .backgroundHover:
            break
        }
    }

    // MARK: Menu actions

    @objc func newWindow(_ sender: Any?) {
        openWindow(path: "/")
    }

    @objc func openPath(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        open(path: path)
    }

    @objc func toggleSidebar(_ sender: Any?) {
        activeController?.host.dispatch(["type": "toggle-sidebar"])
    }

    @objc func reload(_ sender: Any?) {
        activeController?.host.webView.reload()
    }

    @objc func goBack(_ sender: Any?) {
        activeController?.host.webView.goBack()
    }

    @objc func goForward(_ sender: Any?) {
        activeController?.host.webView.goForward()
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(goBack(_:)): return activeController?.host.webView.canGoBack ?? false
        case #selector(goForward(_:)): return activeController?.host.webView.canGoForward ?? false
        case #selector(toggleSidebar(_:)), #selector(reload(_:)): return activeController != nil
        default: return true
        }
    }

    private func open(path: String) {
        if let controller = activeController {
            controller.host.navigate(to: path)
            controller.window?.makeKeyAndOrderFront(nil)
        } else {
            openWindow(path: path)
        }
        NSApp.activate()
    }

    // MARK: Notifications

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let path = response.notification.request.content.userInfo["path"] as? String else { return }
        await MainActor.run { open(path: path) }
    }
}
