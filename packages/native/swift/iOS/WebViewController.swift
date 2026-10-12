import UIKit
import UserNotifications
import WebKit

/// The whole app on iOS: the site, edge to edge. The page draws its own header and dock (as glass),
/// so this only supplies what the page can't: sheets, share, haptics, reminders and the app badge.
@MainActor
final class WebViewController: UIViewController, StorWebHostDelegate {
    let host: StorWebHost
    private let flush = BackgroundFlush()
    private var signIn: SignInViewController?

    init(site: SiteConfig) {
        #if DEBUG
        let inspectable = true
        #else
        let inspectable = false
        #endif
        host = StorWebHost(site: site, kind: .ios, inspectable: inspectable)
        super.init(nibName: nil, bundle: nil)
        host.delegate = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        host.webView.frame = view.bounds
        host.webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.webView)
    }

    /// The phone layout and its dock are portrait; an iPad turns freely.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .phone ? .portrait : .all
    }

    // MARK: Lifecycle

    func didEnterBackground() {
        flush.begin()
    }

    func willEnterForeground() {
        flush.end()
        host.dispatch(["type": "resume"])
    }

    // MARK: Messages

    func host(_ host: StorWebHost, received message: ShellMessage) {
        switch message {
        case .appearance(let preference, _, let background):
            overrideUserInterfaceStyle = preference == .dark ? .dark : preference == .light ? .light : .unspecified
            if let color = UIColor(hex: background) {
                view.backgroundColor = color
                host.webView.underPageBackgroundColor = color
            }
        case .badge(let count):
            setBadge(count)
        case .reminders(let reminders):
            Task { await ReminderScheduler.shared.apply(reminders) }
        case .outbox(let pending):
            flush.pending = pending
        case .haptic(let success):
            UINotificationFeedbackGenerator().notificationOccurred(success ? .success : .warning)
        case .menu, .lights, .drag, .backgroundHover:
            break
        }
    }

    private func setBadge(_ count: Int) {
        Task {
            // Showing a number needs the notification permission; clearing one does not.
            if count > 0, !(await ReminderScheduler.shared.authorize()) { return }
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
        }
    }

    // MARK: StorWebHostDelegate

    func host(_ host: StorWebHost, openWindowFor configuration: WKWebViewConfiguration, url: URL) -> WKWebView? {
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = host
        webView.uiDelegate = host
        webView.isInspectable = host.webView.isInspectable
        let popup = PopupViewController(webView: webView, title: host.site.title)
        presenter.present(UINavigationController(rootViewController: popup), animated: true)
        return webView
    }

    func host(_ host: StorWebHost, showSignIn url: URL) {
        guard signIn == nil else { return }
        let controller = SignInViewController(site: host.site, policy: host.policy, dataStore: host.dataStore, url: url) { [weak self] success in
            guard let self else { return }
            self.signIn = nil
            if success { self.host.reloadAfterSignIn() }
        }
        signIn = controller
        presenter.present(UINavigationController(rootViewController: controller), animated: true)
    }

    func host(_ host: StorWebHost, openExternally url: URL) {
        UIApplication.shared.open(url)
    }

    /// Downloads land in a temporary folder and leave through the share sheet, which offers Save to Files.
    func host(_ host: StorWebHost, chooseDestinationFor suggestedFilename: String) async -> URL? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)) != nil else { return nil }
        let name = (suggestedFilename as NSString).lastPathComponent
        return directory.appendingPathComponent(name.isEmpty ? "download" : name)
    }

    func host(_ host: StorWebHost, savedDownload url: URL) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        presenter.present(sheet, animated: true)
    }

    func host(_ host: StorWebHost, present dialog: JSDialog) async -> JSDialogResult {
        await withCheckedContinuation { continuation in
            let alert: UIAlertController
            switch dialog {
            case .alert(let message):
                alert = UIAlertController(title: host.site.title, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: .ok(nil)) })
            case .confirm(let message):
                alert = UIAlertController(title: host.site.title, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: .cancel) })
                alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: .ok(nil)) })
            case .prompt(let message, let defaultText):
                alert = UIAlertController(title: host.site.title, message: message, preferredStyle: .alert)
                alert.addTextField { $0.text = defaultText }
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: .cancel) })
                alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                    continuation.resume(returning: .ok(alert?.textFields?.first?.text))
                })
            }
            presenter.present(alert, animated: true)
        }
    }

    /// Whatever is on top, so a sheet can open over another sheet.
    private var presenter: UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        return top
    }
}

/// A window the page opened itself, such as a PDF in its own viewer.
@MainActor
final class PopupViewController: UIViewController {
    private let webView: WKWebView

    init(webView: WKWebView, title: String) {
        self.webView = webView
        super.init(nibName: nil, bundle: nil)
        self.title = title
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        webView.frame = view.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(webView)
    }
}

private extension UIColor {
    /// `#rgb` or `#rrggbb`, as the page's theme tokens are written.
    convenience init?(hex: String?) {
        guard var text = hex?.trimmingCharacters(in: .whitespaces), text.hasPrefix("#") else { return nil }
        text.removeFirst()
        if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
        guard text.count == 6, let value = Int(text, radix: 16) else { return nil }
        self.init(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}
