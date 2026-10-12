import AppKit
import WebKit

/// The Cloudflare Access login, in its own window. It shares the app's data store, so the session
/// cookie Access sets is the one the app's web view sends. The window closes itself as soon as
/// Access sends the person back to the app.
@MainActor
final class SignInWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate {
    private let policy: NavigationPolicy
    private let webView: WKWebView
    private let onFinished: (Bool) -> Void
    private var finished = false

    init(site: SiteConfig, policy: NavigationPolicy, dataStore: WKWebsiteDataStore, url: URL, onFinished: @escaping (Bool) -> Void) {
        self.policy = policy
        self.onFinished = onFinished

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        webView = WKWebView(frame: .zero, configuration: configuration)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 700),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Sign in to \(site.title)"
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        super.init(window: window)

        window.delegate = self
        webView.navigationDelegate = self
        webView.load(URLRequest(url: url))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        if policy.finishesSignIn(url) {
            finish(success: true)
            return .cancel
        }
        return policy.allowsSignIn(url) ? .allow : .cancel
    }

    func windowWillClose(_ notification: Notification) {
        finish(success: false)
    }

    private func finish(success: Bool) {
        guard !finished else { return }
        finished = true
        onFinished(success)
        if success { close() }
    }
}
