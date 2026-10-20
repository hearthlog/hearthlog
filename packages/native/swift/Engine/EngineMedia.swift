import WebKit

/// Where a player fetches a site's media from, and what it must send.
struct ResolvedMedia: Equatable {
    var url: URL
    /// `Name: value` headers for every request to `url`: the site's cookie when the gateway proxies the bytes, else none.
    var headers: [String]
}

extension HearthlogEngine {
    /// The cookies the site set for its own host (Access's among them), for native requests to the gateway.
    func siteCookies() async -> [HTTPCookie] {
        await dataStore.httpCookieStore.allCookies().filter { cookie in
            let domain = cookie.domain.lowercased().drop(while: { $0 == "." })
            return site.host == domain || site.host.hasSuffix(".\(domain)")
        }
    }

    /// Resolves a site path that serves media (a stored video's `streamPath`). The gateway normally answers with a
    /// short-lived storage link, which a player fetches with no cookie at all; a site that proxies media answers with
    /// the bytes, and then the player sends the site's cookie, to the site only.
    func resolveMedia(_ path: String) async throws -> ResolvedMedia {
        // One byte is enough to learn which way the gateway answers.
        let answer = try await askSite(path, range: "bytes=0-0")
        if let target = answer.redirect { return ResolvedMedia(url: target, headers: []) }
        return ResolvedMedia(url: answer.url, headers: answer.cookie.map { ["Cookie: \($0)"] } ?? [])
    }

    /// The bytes of a small site resource, such as a private cover photo: read from storage without the site's
    /// cookie when the gateway redirects there, else from the site.
    func siteData(_ path: String) async throws -> Data {
        let answer = try await askSite(path, range: nil)
        guard let target = answer.redirect else { return answer.data }
        let (data, response) = try await Self.storageSession.data(from: target)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw EngineCallError(code: "failed", message: "Storage did not return \(path).")
        }
        return data
    }

    /// Requests to the site: cookies set by hand, redirects read rather than followed.
    private static let siteSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: RedirectRefusal(), delegateQueue: nil)
    }()

    /// Requests to storage links: no cookies at all.
    private static let storageSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        return URLSession(configuration: configuration)
    }()

    private struct SiteAnswer {
        var url: URL
        var redirect: URL?
        var data: Data
        var cookie: String?
    }

    /// Requests a site path with the site's cookies and without following a redirect.
    private func askSite(_ path: String, range: String?) async throws -> SiteAnswer {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: site.origin)?.absoluteURL else {
            throw EngineCallError(code: "invalid_arguments", message: "\(path) is not a path on this site.")
        }
        let cookie = HTTPCookie.requestHeaderFields(with: await siteCookies())["Cookie"]
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        if let range { request.setValue(range, forHTTPHeaderField: "Range") }
        if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let (data, response) = try await Self.siteSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw EngineCallError.badReply("the site's answer is not HTTP") }

        switch http.statusCode {
        case 300..<400:
            guard let location = http.value(forHTTPHeaderField: "Location"), let target = URL(string: location, relativeTo: url)?.absoluteURL else {
                throw EngineCallError.badReply("the redirect has no location")
            }
            if policy.decide(target, isMainFrame: true) == .signIn {
                throw EngineCallError(code: "signed_out", message: "Sign in to \(site.title) again.")
            }
            return SiteAnswer(url: url, redirect: target, data: Data(), cookie: cookie)
        case 200, 206:
            return SiteAnswer(url: url, redirect: nil, data: data, cookie: cookie)
        case 401, 403:
            throw EngineCallError(code: "signed_out", message: "Sign in to \(site.title) again.")
        default:
            throw EngineCallError(code: "failed", message: "\(path) is not available (\(http.statusCode)).")
        }
    }
}

/// Stops at the gateway's redirect, so its storage link is read rather than followed with the site's cookie.
private final class RedirectRefusal: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}
