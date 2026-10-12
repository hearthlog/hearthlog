import Foundation

enum ShellKind: String {
    case mac, ios
}

enum Appearance: String {
    case light, dark, system
}

/// A notification the page wants scheduled. `at` is wall-clock time in the device's time zone.
struct Reminder: Hashable {
    var id: String
    var title: String
    var body: String
    var at: DateComponents
    var path: String

    var date: Date? { Calendar.current.date(from: at) }
}

struct MenuEntry: Hashable {
    var id: String
    var title: String
    var path: String
    /// A section's sub-pages; the Mac Dock menu shows them as a submenu.
    var children: [MenuEntry] = []
}

/// What the page tells the shell. Decoded from `{ type, body }` posted on the `stor` handler;
/// anything malformed is dropped.
enum ShellMessage: Equatable {
    case appearance(preference: Appearance, resolved: Appearance, background: String?)
    case badge(Int)
    case reminders([Reminder])
    case menu(destinations: [MenuEntry], actions: [MenuEntry])
    /// Left edge of the first window control and its vertical centre, in points from the window's top left.
    case lights(x: Double, y: Double)
    case outbox(pending: Int)
    case haptic(success: Bool)
    /// Whether the pointer is over a background of the page (see `WindowDragScript`); a click there moves the window.
    case backgroundHover(on: Bool)
    /// What earlier pages sent from their own drag handler. The shell drags by itself now and ignores it.
    case drag(clickCount: Int)

    init?(_ message: Any) {
        guard let envelope = message as? [String: Any],
              let type = envelope["type"] as? String,
              let body = envelope["body"] as? [String: Any]
        else { return nil }

        switch type {
        case "appearance":
            guard let preference = (body["preference"] as? String).flatMap(Appearance.init),
                  let resolved = (body["resolved"] as? String).flatMap(Appearance.init)
            else { return nil }
            self = .appearance(preference: preference, resolved: resolved, background: body["background"] as? String)
        case "badge":
            guard let count = Self.int(body["count"]) else { return nil }
            self = .badge(max(0, count))
        case "reminders":
            guard let items = body["items"] as? [[String: Any]] else { return nil }
            self = .reminders(items.compactMap(Self.reminder))
        case "menu":
            guard let destinations = body["destinations"] as? [[String: Any]],
                  let actions = body["actions"] as? [[String: Any]]
            else { return nil }
            self = .menu(destinations: destinations.compactMap(Self.entry), actions: actions.compactMap(Self.entry))
        case "lights":
            guard let x = Self.double(body["x"]), let y = Self.double(body["y"]), x.isFinite, y.isFinite else { return nil }
            self = .lights(x: x, y: y)
        case "outbox":
            guard let pending = Self.int(body["pending"]) else { return nil }
            self = .outbox(pending: max(0, pending))
        case "haptic":
            self = .haptic(success: (body["kind"] as? String) == "success")
        case "backgroundHover":
            self = .backgroundHover(on: (body["on"] as? Bool) ?? false)
        case "drag":
            self = .drag(clickCount: Self.int(body["clickCount"]) ?? 1)
        default:
            return nil
        }
    }

    private static func int(_ value: Any?) -> Int? { (value as? NSNumber)?.intValue }
    private static func double(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }

    private static func entry(_ raw: [String: Any]) -> MenuEntry? {
        guard let id = raw["id"] as? String, let title = raw["title"] as? String, let path = raw["path"] as? String,
              isAppPath(path)
        else { return nil }
        let children = (raw["children"] as? [[String: Any]])?.compactMap(entry) ?? []
        return MenuEntry(id: id, title: title, path: path, children: children)
    }

    private static func reminder(_ raw: [String: Any]) -> Reminder? {
        guard let id = raw["id"] as? String, let title = raw["title"] as? String,
              let body = raw["body"] as? String, let path = raw["path"] as? String, isAppPath(path),
              let at = (raw["at"] as? String).flatMap(components)
        else { return nil }
        return Reminder(id: id, title: title, body: body, at: at, path: path)
    }

    /// `YYYY-MM-DDTHH:mm` as calendar components, without choosing a time zone.
    static func components(_ text: String) -> DateComponents? {
        let parts = text.split(whereSeparator: { "-T:".contains($0) }).compactMap { Int($0) }
        guard parts.count == 5, (1...12).contains(parts[1]), (1...31).contains(parts[2]),
              (0...23).contains(parts[3]), (0...59).contains(parts[4])
        else { return nil }
        return DateComponents(calendar: .current, timeZone: .current, year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4])
    }

    /// An in-app route: absolute and never `//host`.
    static func isAppPath(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.hasPrefix("//")
    }
}
