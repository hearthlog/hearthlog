import Foundation

/// The native engine bridge, version 2: the Swift half of `packages/runtime/src/native/bridge.ts`.
/// An app calls functions by name and gets one JSON reply back; the engine page posts `native:*`
/// messages on the `stor` handler. Nothing here needs a web view, so the checks cover it.
enum EngineBridge {
    static let version = 2
    /// The route the hidden engine web view loads (`ENGINE_PATH`).
    static let path = "/native-engine"
}

struct EngineContext: Codable, Equatable {
    var tenantId: String
    var title: String
    var origin: String
    var logId: String?
    var logName: String?
}

struct EngineStatus: Codable, Equatable {
    /// offline, idle, syncing, pending, blocked, waiting, error or synced.
    var phase: String
    var ready: Bool
    var active: Bool
    var isOnline: Bool
    var isSyncing: Bool
    var hasCompletedSync: Bool
    var pendingUploads: Int
    var needsAttention: Int
    var errorMessage: String?
    /// ISO 8601, or nil before the first sync.
    var lastSyncedAt: String?
    var signedIn: Bool
    var logId: String?

    var lastSynced: Date? { lastSyncedAt.flatMap(EngineDates.parse) }
}

enum EngineDates {
    /// `Date.prototype.toISOString` always writes milliseconds.
    static func parse(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)
    }
}

/// What the engine page tells the app. Decoded from `{ type, body }`; anything malformed is dropped.
enum EngineMessage: Equatable {
    case ready(bridgeVersion: Int, context: EngineContext, apis: [String: Int])
    case status(EngineStatus)
    case failed(message: String)

    private struct Envelope: Decodable { var type: String }
    private struct Typed<Body: Decodable>: Decodable { var body: Body }
    private struct Ready: Decodable { var bridgeVersion: Int; var context: EngineContext; var apis: [String: Int] }
    private struct Failed: Decodable { var message: String }

    /// `message` is a `WKScriptMessage` body: dictionaries, arrays, strings, numbers and booleans.
    init?(_ message: Any) {
        guard JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message)
        else { return nil }
        self.init(json: data)
    }

    init?(json data: Data) {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
        switch envelope.type {
        case "native:ready":
            guard let ready = try? decoder.decode(Typed<Ready>.self, from: data).body else { return nil }
            self = .ready(bridgeVersion: ready.bridgeVersion, context: ready.context, apis: ready.apis)
        case "native:status":
            guard let status = try? decoder.decode(Typed<EngineStatus>.self, from: data).body else { return nil }
            self = .status(status)
        case "native:failed":
            guard let failed = try? decoder.decode(Typed<Failed>.self, from: data).body else { return nil }
            self = .failed(message: failed.message)
        default:
            return nil
        }
    }
}

/// A call the engine refused or could not finish. `code` is the bridge's error code
/// (`unknown_function`, `invalid_arguments`, `not_ready`, `failed`) or `bad_reply`.
struct EngineCallError: Error, Equatable, LocalizedError {
    var code: String
    var message: String

    var errorDescription: String? { message }

    static func badReply(_ detail: String) -> EngineCallError {
        EngineCallError(code: "bad_reply", message: "The engine sent a reply the app cannot read: \(detail)")
    }
}

/// A call without arguments.
struct NoArguments: Encodable, Equatable {}

/// A call whose reply carries no value.
struct NoValue: Decodable, Equatable {
    init() {}
    init(from decoder: Decoder) throws {}
}

enum EngineReply {
    private struct Failure: Decodable { var code: String; var message: String }
    private struct Envelope<Value: Decodable>: Decodable {
        var ok: Bool
        var value: Value?
        var error: Failure?
    }

    /// Decodes `{ ok: true, value }` to the value, or throws the `{ ok: false, error }` it carries.
    static func decode<Value: Decodable>(_ type: Value.Type, from json: String) throws -> Value {
        let envelope: Envelope<Value>
        do {
            envelope = try JSONDecoder().decode(Envelope<Value>.self, from: Data(json.utf8))
        } catch {
            throw EngineCallError.badReply(String(describing: error))
        }
        if !envelope.ok {
            let failure = envelope.error ?? Failure(code: "failed", message: "The engine call failed.")
            throw EngineCallError(code: failure.code, message: failure.message)
        }
        if let value = envelope.value { return value }
        if let none = NoValue() as? Value { return none }
        throw EngineCallError.badReply("the reply has no value")
    }

    /// Arguments travel as JSON text, never as WebKit-bridged objects.
    static func encode<Arguments: Encodable>(_ arguments: Arguments) throws -> String {
        let data = try JSONEncoder().encode(arguments)
        guard let text = String(data: data, encoding: .utf8) else { throw EngineCallError.badReply("arguments are not UTF-8") }
        return text
    }
}
