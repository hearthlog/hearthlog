import Foundation

/// Decides what each navigation may do. The app's own origin loads in the web view; the
/// Cloudflare Access login opens in the sign-in window; every other page opens in the
/// default browser. Nothing else may load in a frame.
struct NavigationPolicy: Equatable {
    enum Decision: Equatable {
        /// Load it here.
        case allow
        /// Hand it to the system (default browser, Mail, Phone).
        case external
        /// Open the Access login in the sign-in window.
        case signIn
        case cancel
    }

    let origin: URL
    let accessHost: String?

    func decide(_ url: URL?, isMainFrame: Bool) -> Decision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        switch scheme {
        case "about":
            return url.absoluteString == "about:blank" ? .allow : .cancel
        case "blob":
            // blob:https://host/id belongs to the page that made it.
            guard let inner = URL(string: String(url.absoluteString.dropFirst("blob:".count))) else { return .cancel }
            return isOrigin(inner) ? .allow : .cancel
        case "data":
            return isMainFrame ? .cancel : .allow
        case "http", "https":
            if isOrigin(url) { return .allow }
            let host = url.host?.lowercased()
            // The app's own host over another scheme or port is never a link to follow.
            if host == origin.host?.lowercased() { return .cancel }
            if let accessHost, host == accessHost { return isMainFrame ? .signIn : .cancel }
            return isMainFrame ? .external : .cancel
        case "mailto", "tel", "sms":
            return isMainFrame ? .external : .cancel
        default:
            return .cancel
        }
    }

    /// The sign-in window is done once Access sends it back to the app (past `/cdn-cgi/`, which sets the cookie).
    func finishesSignIn(_ url: URL?) -> Bool {
        guard let url, isOrigin(url) else { return false }
        return !url.path.hasPrefix("/cdn-cgi/")
    }

    /// The sign-in window may follow the login across identity providers, but only over https. The app's
    /// own origin and the Access host also count over the app's scheme, which is http only in development.
    func allowsSignIn(_ url: URL?) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "about" { return url.absoluteString == "about:blank" }
        if scheme == "https" || isOrigin(url) { return true }
        return scheme == origin.scheme?.lowercased() && url.host?.lowercased() == accessHost
    }

    func isOrigin(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == origin.scheme?.lowercased(),
              let host = url.host?.lowercased(), host == origin.host?.lowercased()
        else { return false }
        return (url.port ?? Self.defaultPort(scheme)) == (origin.port ?? Self.defaultPort(scheme))
    }

    private static func defaultPort(_ scheme: String) -> Int? {
        scheme == "https" ? 443 : scheme == "http" ? 80 : nil
    }
}
