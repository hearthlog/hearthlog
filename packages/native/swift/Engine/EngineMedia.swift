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
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: site.origin)?.absoluteURL else {
            throw EngineCallError(code: "invalid_arguments", message: "\(path) is not a path on this site.")
        }
        let cookies = await siteCookies()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        // One byte is enough to learn which way the gateway answers.
        request.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        for (name, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: name) }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: RedirectRefusal(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw EngineCallError.badReply("the media answer is not HTTP") }

        switch http.statusCode {
        case 300..<400:
            guard let location = http.value(forHTTPHeaderField: "Location"), let target = URL(string: location, relativeTo: url)?.absoluteURL else {
                throw EngineCallError.badReply("the media redirect has no location")
            }
            if policy.decide(target, isMainFrame: true) == .signIn {
                throw EngineCallError(code: "signed_out", message: "Sign in to \(site.title) again to play this video.")
            }
            return ResolvedMedia(url: target, headers: [])
        case 200, 206:
            let cookie = HTTPCookie.requestHeaderFields(with: cookies)["Cookie"]
            return ResolvedMedia(url: url, headers: cookie.map { ["Cookie: \($0)"] } ?? [])
        case 401, 403:
            throw EngineCallError(code: "signed_out", message: "Sign in to \(site.title) again to play this video.")
        default:
            throw EngineCallError(code: "failed", message: "The video is not available (\(http.statusCode)).")
        }
    }
}

/// Stops at the gateway's redirect, so its storage link is read rather than followed with the site's cookie.
private final class RedirectRefusal: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}
