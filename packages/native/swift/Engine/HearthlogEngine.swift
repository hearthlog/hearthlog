import WebKit

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A native app's engine: a web view nobody sees, on the site's engine route, running the
/// unchanged runtime (local database, outbox, sync, realtime, projections). The app reads it
/// through `call` and follows it through `state` and `status`; it never touches the data itself.
///
/// The engine shares the site's data store with the Mac shell, so both open one local database.
@MainActor
final class HearthlogEngine: NSObject, ObservableObject {
    enum State: Equatable {
        case starting
        /// Access wants the person to sign in at this URL; call `reload()` once they have.
        case signInRequired(URL)
        case ready(EngineContext)
        case failed(String)
    }

    @Published private(set) var state: State = .starting
    @Published private(set) var status: EngineStatus?
    /// Module API versions the site reported (`stash: 1`), for compatibility checks.
    @Published private(set) var apis: [String: Int] = [:]

    let site: SiteConfig
    let policy: NavigationPolicy
    let dataStore: WKWebsiteDataStore
    let webView: WKWebView

    init(site: SiteConfig, inspectable: Bool = false) {
        self.site = site
        policy = NavigationPolicy(origin: site.origin, accessHost: site.accessHost)
        dataStore = WKWebsiteDataStore(forIdentifier: site.dataStoreIdentifier)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        // Never on screen, so WebKit would otherwise throttle and then suspend it.
        configuration.preferences.inactiveSchedulingPolicy = WKPreferences.InactiveSchedulingPolicy.none
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.bootstrapScript(site: site.id),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        webView.isInspectable = inspectable
        super.init()

        configuration.userContentController.add(EngineMessageProxy(engine: self), name: Self.messageHandlerName)
        webView.navigationDelegate = self
    }

    static let messageHandlerName = "stor"

    var engineURL: URL { URL(string: EngineBridge.path, relativeTo: site.origin)!.absoluteURL }

    // MARK: Lifecycle

    /// Loads the engine page unless it is already running.
    func startIfNeeded() {
        guard webView.url == nil else { return }
        start()
    }

    func start() {
        state = .starting
        status = nil
        webView.load(URLRequest(url: engineURL))
    }

    /// Back from the sign-in window, or retrying after a failure.
    func reload() {
        start()
    }

    // MARK: Calls

    /// Calls a bridge function by name: `engine.status`, or a module's `stash.scenes.list`.
    func call<Arguments: Encodable, Value: Decodable>(_ name: String, _ arguments: Arguments, as type: Value.Type = Value.self) async throws -> Value {
        let argumentsJSON = try EngineReply.encode(arguments)
        // The completion-handler form, wrapped by hand: with its handler defaulted, the compiler
        // picks it over the `async` overload and the reply is lost.
        let json: String = try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(
                "if (!window.hearthlogNative) throw new Error('not_ready'); return await window.hearthlogNative.call(name, args);",
                arguments: ["name": name, "args": argumentsJSON],
                in: nil,
                in: .page
            ) { result in
                switch result {
                case .success(let value as String):
                    continuation.resume(returning: value)
                case .success:
                    continuation.resume(throwing: EngineCallError.badReply("the reply is not text"))
                case .failure:
                    continuation.resume(throwing: EngineCallError(code: "not_ready", message: "The engine is not running yet."))
                }
            }
        }
        return try EngineReply.decode(Value.self, from: json)
    }

    func call<Value: Decodable>(_ name: String, as type: Value.Type = Value.self) async throws -> Value {
        try await call(name, NoArguments(), as: type)
    }

    @discardableResult
    func syncNow() async throws -> EngineStatus {
        let status: EngineStatus = try await call("engine.syncNow")
        self.status = status
        return status
    }

    /// Sync and realtime run only while the app is active, as they do in a visible browser tab.
    func setActive(_ active: Bool) async {
        struct Arguments: Encodable { var active: Bool }
        if let status: EngineStatus = try? await call("engine.setActive", Arguments(active: active)) {
            self.status = status
        }
    }

    // MARK: Messages

    fileprivate func receive(_ message: WKScriptMessage) {
        // Only the site's own engine page may report, never a frame from elsewhere.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host.lowercased() == site.host,
              let parsed = EngineMessage(message.body)
        else { return }
        switch parsed {
        case .ready(let bridgeVersion, let context, let apis):
            guard bridgeVersion == EngineBridge.version else {
                state = .failed("This app needs engine bridge \(EngineBridge.version); the site runs \(bridgeVersion). Update the app or the site.")
                return
            }
            self.apis = apis
            state = .ready(context)
        case .status(let status):
            self.status = status
        case .failed(let message):
            state = .failed(message)
        }
    }

    private static func bootstrapScript(site: String) -> String {
        let id = (try? EngineReply.encode(site)) ?? "\"\""
        return """
        (() => {
            if (window.storShell) return;
            Object.defineProperty(window, 'storShell', {
                value: Object.freeze({ kind: '\(Self.kind)', site: \(id), version: \(EngineBridge.version), role: 'engine' }),
                enumerable: false,
            });
        })();
        """
    }

    #if os(macOS)
    private static let kind = "mac"
    #else
    private static let kind = "ios"
    #endif
}

/// `WKUserContentController` retains its handlers, so the engine must not be one directly.
private final class EngineMessageProxy: NSObject, WKScriptMessageHandler {
    weak var engine: HearthlogEngine?

    init(engine: HearthlogEngine) { self.engine = engine }

    @MainActor
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        engine?.receive(message)
    }
}

// MARK: - Navigation

extension HearthlogEngine: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        switch policy.decide(url, isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true) {
        case .allow:
            return .allow
        case .signIn:
            if let url { state = .signInRequired(url) }
            return .cancel
        case .external, .cancel:
            // The engine shows no pages, so it follows no links out.
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    /// WebKit ended the page's process (memory pressure, a crash): start over.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        start()
    }

    private func fail(_ error: Error) {
        let nsError = error as NSError
        // Cancelled loads and loads the policy above stopped are not failures.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        if case .signInRequired = state { return }
        state = .failed("\(site.title) can't open yet. Connect to the internet once so the app can download itself.")
    }
}
