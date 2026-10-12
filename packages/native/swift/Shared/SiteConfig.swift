import CryptoKit
import Foundation

/// The site an app build opens. `scripts/apple-site.ts` writes it into Info.plist as `StorSite`.
struct SiteConfig: Equatable {
    let id: String
    let title: String
    let origin: URL
    /// Cloudflare Access team host; navigating there opens the sign-in window.
    let accessHost: String?
    /// A development build pointed at another origin keeps its own data store.
    let isDevelopmentOrigin: Bool

    var host: String { origin.host?.lowercased() ?? "" }

    /// One persistent data store per site, so apps for different sites never share storage.
    var dataStoreIdentifier: UUID {
        let name = "app.stor.data-store.\(id)\(isDevelopmentOrigin ? ".development" : "")"
        var bytes = Array(SHA256.hash(data: Data(name.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return bytes.withUnsafeBytes { UUID(uuid: $0.load(as: uuid_t.self)) }
    }

    /// Reads `StorSite` from the bundle. A build without it is a build mistake, so this stops.
    /// Builds made with `--dev` may point at another origin and Access host through `STOR_ORIGIN` and `STOR_ACCESS_HOST`.
    static func load(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) -> SiteConfig {
        guard let info = bundle.object(forInfoDictionaryKey: "StorSite") as? [String: Any],
              let id = info["id"] as? String,
              let title = info["title"] as? String,
              let originString = info["origin"] as? String,
              let configured = URL(string: originString), configured.host != nil
        else { fatalError("Info.plist has no valid StorSite. Build with pnpm apple:mac or pnpm apple:ios.") }

        var origin = configured
        var accessHost = (info["accessHost"] as? String)?.lowercased()
        var isDevelopmentOrigin = false
        if bundle.object(forInfoDictionaryKey: "StorDevelopmentOverrides") as? Bool == true {
            if let override = environment["STOR_ORIGIN"].flatMap(URL.init(string:)), override.host != nil {
                origin = override
                isDevelopmentOrigin = true
            }
            if let override = environment["STOR_ACCESS_HOST"], !override.isEmpty { accessHost = override.lowercased() }
        }
        return SiteConfig(id: id, title: title, origin: origin, accessHost: accessHost, isDevelopmentOrigin: isDevelopmentOrigin)
    }
}
