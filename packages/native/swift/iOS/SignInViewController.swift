import UIKit
import WebKit

/// The Cloudflare Access login, in a sheet. It shares the app's data store, so the session cookie
/// Access sets is the one the app's web view sends. The sheet closes itself as soon as Access sends
/// the person back to the app.
@MainActor
final class SignInViewController: UIViewController, WKNavigationDelegate {
    private let policy: NavigationPolicy
    private let webView: WKWebView
    private let url: URL
    private let onFinished: (Bool) -> Void
    private var finished = false

    init(site: SiteConfig, policy: NavigationPolicy, dataStore: WKWebsiteDataStore, url: URL, onFinished: @escaping (Bool) -> Void) {
        self.policy = policy
        self.url = url
        self.onFinished = onFinished
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        title = "Sign in to \(site.title)"
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        webView.frame = view.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        view.addSubview(webView)
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        if policy.finishesSignIn(url) {
            finish(success: true)
            return .cancel
        }
        return policy.allowsSignIn(url) ? .allow : .cancel
    }

    /// Swiping the sheet away or tapping Cancel ends the sign-in without a session.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController?.isBeingDismissed == true { finish(success: false) }
    }

    private func finish(success: Bool) {
        guard !finished else { return }
        finished = true
        onFinished(success)
        if success { navigationController?.dismiss(animated: true) }
    }
}
