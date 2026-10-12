import WebKit

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A dialog the page asked for with `alert`, `confirm` or `prompt`.
enum JSDialog {
    case alert(String)
    case confirm(String)
    case prompt(String, defaultText: String?)
}

enum JSDialogResult {
    case ok(String?)
    case cancel
}

/// The platform half of the shell: windows, panels and system services. The web view and the
/// rules around it live in `StorWebHost`, which is the same on the Mac and on iOS.
@MainActor
protocol StorWebHostDelegate: AnyObject {
    func host(_ host: StorWebHost, received message: ShellMessage)
    /// A page asked for a new window (`window.open`, `target="_blank"`) on the app's own origin.
    func host(_ host: StorWebHost, openWindowFor configuration: WKWebViewConfiguration, url: URL) -> WKWebView?
    func host(_ host: StorWebHost, showSignIn url: URL)
    func host(_ host: StorWebHost, openExternally url: URL)
    /// Where to save a download, or nil to cancel it.
    func host(_ host: StorWebHost, chooseDestinationFor suggestedFilename: String) async -> URL?
    func host(_ host: StorWebHost, savedDownload url: URL)
    func host(_ host: StorWebHost, present dialog: JSDialog) async -> JSDialogResult
    #if os(macOS)
    func host(_ host: StorWebHost, chooseFilesFor parameters: WKOpenPanelParameters) async -> [URL]?
    #endif
}

/// Owns the `WKWebView` that shows the site and applies the shell's rules to it: which pages may
/// load, where downloads go, which permissions the app's own origin gets, and how the page and the
/// shell talk to each other.
@MainActor
final class StorWebHost: NSObject {
    static let messageHandlerName = "stor"
    static let bridgeVersion = 1

    let site: SiteConfig
    let policy: NavigationPolicy
    let dataStore: WKWebsiteDataStore
    let webView: WKWebView
    weak var delegate: StorWebHostDelegate?

    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    init(site: SiteConfig, kind: ShellKind, inspectable: Bool, lightsWidth: CGFloat? = nil) {
        self.site = site
        policy = NavigationPolicy(origin: site.origin, accessHost: site.accessHost)
        dataStore = WKWebsiteDataStore(forIdentifier: site.dataStoreIdentifier)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        #if STOR_DEV
        // Scripted runs have no user gesture, which window.open normally needs.
        if ProcessInfo.processInfo.environment["STOR_DEV_ALLOW_POPUPS"] == "1" {
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        }
        #endif
        #if STOR_DEV
        let legacyPage = ProcessInfo.processInfo.environment["STOR_DEV_LEGACY_PAGE"] == "1"
        #else
        let legacyPage = false
        #endif
        configuration.userContentController.addUserScript(WKUserScript(
            source: legacyPage ? "" : Self.bootstrapScript(kind: kind, site: site.id, lightsWidth: lightsWidth),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        if kind == .mac {
            configuration.userContentController.addUserScript(WKUserScript(
                source: WindowDragScript.source,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        #if os(iOS)
        // Service workers and script messages need App-Bound Domains on iOS; the tenant host is
        // listed in Info.plist as WKAppBoundDomains.
        if Bundle.main.object(forInfoDictionaryKey: "WKAppBoundDomains") != nil {
            configuration.limitsNavigationsToAppBoundDomains = true
        }
        configuration.allowsInlineMediaPlayback = true
        #endif

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isInspectable = inspectable
        webView.allowsBackForwardNavigationGestures = true
        #if os(macOS)
        webView.allowsMagnification = false
        // The window's glass shows through the transparent page (see app.css, html[data-stor-shell="mac"]).
        webView.setValue(false, forKey: "drawsBackground")
        #else
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        #endif
        super.init()

        configuration.userContentController.add(MessageProxy(host: self), name: Self.messageHandlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    // MARK: Loading

    func load(path: String = "/") {
        guard ShellMessage.isAppPath(path), let url = URL(string: path, relativeTo: site.origin)?.absoluteURL else { return }
        webView.load(URLRequest(url: url))
    }

    /// Back from the sign-in window: the cookie is set, so open the page again.
    func reloadAfterSignIn() {
        if webView.url == nil || webView.url?.scheme == "about" {
            load()
        } else {
            webView.reload()
        }
    }

    // MARK: Talking to the page

    /// Sends an event the page listens for (`window` event `stor-shell`).
    func dispatch(_ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('stor-shell', { detail: \(json) }))", completionHandler: nil)
    }

    func navigate(to path: String) {
        guard ShellMessage.isAppPath(path) else { return }
        dispatch(["type": "navigate", "path": path])
    }

    /// Marks window state on `<html>` so CSS can react (`data-stor-inactive`, `data-stor-fullscreen`).
    func setAttribute(_ name: String, _ on: Bool) {
        webView.evaluateJavaScript("document.documentElement.toggleAttribute('\(name)', \(on))", completionHandler: nil)
    }

    private static func bootstrapScript(kind: ShellKind, site: String, lightsWidth: CGFloat?) -> String {
        let lights = lightsWidth.map { ", lights: \(Int($0))" } ?? ""
        return """
        (() => {
            if (window.storShell) return;
            Object.defineProperty(window, 'storShell', {
                value: Object.freeze({ kind: '\(kind.rawValue)', site: '\(site)', version: \(bridgeVersion)\(lights) }),
                enumerable: false,
            });
        })();
        """
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        // Only the app's own page may drive the shell, never an embedded frame from elsewhere.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host.lowercased() == site.host,
              let parsed = ShellMessage(message.body)
        else { return }
        delegate?.host(self, received: parsed)
    }

    private static func errorPage(for site: SiteConfig) -> String {
        """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        :root { color-scheme: light dark; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center; padding: 24px; box-sizing: border-box; }
        p { margin: 0 0 16px; color: GrayText; } h1 { margin: 0 0 6px; font-size: 20px; }
        a { display: inline-block; padding: 10px 18px; border-radius: 999px; background: AccentColor; color: AccentColorText; text-decoration: none; font-weight: 600; }
        </style>
        <main><h1>\(site.title) can't open yet</h1><p>Connect to the internet once so the app can download itself.</p>
        <a href="\(site.origin.absoluteString)">Try again</a></main>
        """
    }
}

/// `WKUserContentController` retains its handlers, so the host must not be one directly.
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var host: StorWebHost?

    init(host: StorWebHost) { self.host = host }

    @MainActor
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        host?.receive(message)
    }
}

// MARK: - Navigation

extension StorWebHost: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.shouldPerformDownload { return .download }
        let url = navigationAction.request.url
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        switch policy.decide(url, isMainFrame: isMainFrame) {
        case .allow:
            return .allow
        case .external:
            if let url { delegate?.host(self, openExternally: url) }
            return .cancel
        case .signIn:
            if let url { delegate?.host(self, showSignIn: url) }
            return .cancel
        case .cancel:
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if let response = navigationResponse.response as? HTTPURLResponse,
           response.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true {
            return .download
        }
        return navigationResponse.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showErrorPageIfNeeded(webView, error: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showErrorPageIfNeeded(webView, error: error)
    }

    /// A first launch without a connection has nothing cached to show. Cancelled loads and loads our
    /// own policy interrupted are not failures.
    private func showErrorPageIfNeeded(_ webView: WKWebView, error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        guard webView === self.webView, webView.url == nil || webView.url?.scheme == "about" else { return }
        webView.loadHTMLString(Self.errorPage(for: site), baseURL: nil)
    }
}

// MARK: - Downloads

extension StorWebHost: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        guard let destination = await delegate?.host(self, chooseDestinationFor: suggestedFilename) else { return nil }
        // WebKit refuses to write over a file; the person already agreed to replace it.
        try? FileManager.default.removeItem(at: destination)
        downloadDestinations[ObjectIdentifier(download)] = destination
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let destination = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        delegate?.host(self, savedDownload: destination)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let destination = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: destination)
        }
    }
}

// MARK: - UI

extension StorWebHost: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        switch policy.decide(url, isMainFrame: true) {
        case .allow:
            return delegate?.host(self, openWindowFor: configuration, url: url)
        case .external:
            delegate?.host(self, openExternally: url)
            return nil
        case .signIn, .cancel:
            return nil
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        _ = await delegate?.host(self, present: .alert(message))
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        if case .ok = await delegate?.host(self, present: .confirm(message)) { return true }
        return false
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        if case .ok(let text) = await delegate?.host(self, present: .prompt(prompt, defaultText: defaultText)) { return text ?? "" }
        return nil
    }

    /// The barcode scanner asks for the camera; only the app's own origin may have it.
    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        origin.host.lowercased() == site.host && type == .camera ? .grant : .deny
    }

    #if os(macOS)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        await delegate?.host(self, chooseFilesFor: parameters)
    }
    #endif
}
