import Foundation

// Checks the parts of the shell that decide access and what gets scheduled. They need no window,
// web view or XCTest, so they run with the Command Line Tools: `pnpm apple:test`.

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    checks += 1
    if !condition() {
        failures += 1
        print("FAIL (line \(line)): \(message)")
    }
}

func url(_ string: String) -> URL { URL(string: string)! }

// MARK: NavigationPolicy

let policy = NavigationPolicy(origin: url("https://alpha.example.workers.dev"), accessHost: "your-team.cloudflareaccess.com")

func decision(_ string: String, main: Bool = true) -> NavigationPolicy.Decision { policy.decide(url(string), isMainFrame: main) }

expect(decision("https://alpha.example.workers.dev/invoices?tab=received") == .allow, "the app's pages load")
expect(decision("https://alpha.example.workers.dev:443/") == .allow, "an explicit default port is the same origin")
expect(decision("https://ALPHA.example.workers.dev/") == .allow, "host case does not matter")
expect(decision("blob:https://alpha.example.workers.dev/3f2c") == .allow, "the app's own blob URLs load")
expect(decision("about:blank") == .allow, "about:blank loads")
expect(decision("data:text/html,hi", main: false) == .allow, "data in a frame loads")

expect(decision("https://your-team.cloudflareaccess.com/cdn-cgi/access/login/x") == .signIn, "Access opens the sign-in window")
expect(decision("https://your-team.cloudflareaccess.com/cdn-cgi/access/login/x", main: false) == .cancel, "Access never loads in a frame")

expect(decision("https://example.com/") == .external, "other sites open in the browser")
expect(decision("mailto:a@example.com") == .external, "mail opens in Mail")
expect(decision("tel:+420123456789") == .external, "phone numbers open in Phone")
expect(decision("https://alpha.example.workers.dev.evil.example/") == .external, "a lookalike host is another site")
expect(decision("https://xalpha.example.workers.dev/") == .external, "a sibling host is another site")
expect(decision("https://example.com/", main: false) == .cancel, "other sites never load in a frame")

expect(decision("http://alpha.example.workers.dev/") == .cancel, "the app's host is never reached over http")
expect(decision("https://alpha.example.workers.dev:8443/") == .cancel, "the app's host on another port is not the app")
expect(decision("javascript:alert(1)") == .cancel, "javascript: is refused")
expect(decision("file:///etc/passwd") == .cancel, "file: is refused")
expect(decision("data:text/html,hi") == .cancel, "data: never becomes a page")
expect(decision("blob:https://evil.example/3f2c") == .cancel, "another site's blob URL is refused")
expect(policy.decide(nil, isMainFrame: true) == .cancel, "no URL is refused")

expect(policy.finishesSignIn(url("https://alpha.example.workers.dev/")), "back at the app ends the sign-in")
expect(!policy.finishesSignIn(url("https://alpha.example.workers.dev/cdn-cgi/access/authorized?token=x")), "the cookie-setting step must complete first")
expect(!policy.finishesSignIn(url("https://example.com/")), "another site does not end the sign-in")

expect(policy.allowsSignIn(url("https://accounts.example.com/login")), "the login may pass through an identity provider over https")
expect(!policy.allowsSignIn(url("http://accounts.example.com/login")), "but not over http")
expect(!policy.allowsSignIn(url("file:///etc/passwd")), "or from disk")
expect(policy.allowsSignIn(url("about:blank")), "about:blank is fine")

let development = NavigationPolicy(origin: url("http://127.0.0.1:5180"), accessHost: "localhost")
expect(development.decide(url("http://127.0.0.1:5180/x"), isMainFrame: true) == .allow, "development origin loads")
expect(development.allowsSignIn(url("http://localhost:5192/login")), "the development Access host works over the app's scheme")
expect(!development.allowsSignIn(url("http://evil.example/")), "other hosts still need https")

// MARK: ShellMessage

func message(_ type: String, _ body: [String: Any]) -> ShellMessage? { ShellMessage(["type": type, "body": body]) }

expect(message("badge", ["count": 3]) == .badge(3), "badge decodes")
expect(message("badge", ["count": -2]) == .badge(0), "a negative badge becomes zero")
expect(message("badge", [:]) == nil, "badge without a count is dropped")
expect(ShellMessage("not a dictionary") == nil, "garbage is dropped")
expect(ShellMessage(["type": "badge"]) == nil, "a message without a body is dropped")
expect(message("unknown", [:]) == nil, "unknown types are dropped")
expect(message("lights", ["x": 26.5, "y": 38]) == .lights(x: 26.5, y: 38), "lights decode")
expect(message("outbox", ["pending": 4]) == .outbox(pending: 4), "outbox decodes")
expect(message("haptic", ["kind": "success"]) == .haptic(success: true), "haptic success decodes")
expect(message("drag", ["clickCount": 2]) == .drag(clickCount: 2), "the old per-page drag still decodes")
expect(message("backgroundHover", ["on": true]) == .backgroundHover(on: true), "hovering a background decodes")
expect(message("backgroundHover", ["on": false]) == .backgroundHover(on: false), "leaving a background decodes")
expect(message("backgroundHover", [:]) == .backgroundHover(on: false), "a hover without a value is not a background")
expect(message("appearance", ["preference": "dark", "resolved": "dark", "background": "#181d27"]) == .appearance(preference: .dark, resolved: .dark, background: "#181d27"), "appearance decodes")
expect(message("appearance", ["preference": "purple", "resolved": "dark"]) == nil, "an unknown appearance is dropped")

if case .menu(let destinations, let actions)? = message("menu", [
    "destinations": [
        ["id": "invoices", "title": "Invoices", "path": "/invoices", "children": [
            ["id": "issued", "title": "Issued", "path": "/invoices"],
            ["id": "received", "title": "Received", "path": "/invoices?tab=received"],
            ["id": "bad", "title": "Bad", "path": "//evil.example"],
        ]],
        ["id": "finance", "title": "Finance", "path": "/finance"],
        ["id": "x", "title": "Evil", "path": "//evil.example"],
    ],
    "actions": [["id": "new", "title": "New", "path": "/finance?newTransaction=1"], ["id": "y", "title": "Bad", "path": "https://evil.example"]],
]) {
    expect(destinations.map(\.id) == ["invoices", "finance"], "menu entries that are not in-app routes are dropped")
    expect(destinations.first?.children.map(\.id) == ["issued", "received"], "sub-pages decode and bad routes are dropped")
    expect(destinations.last?.children.isEmpty == true, "a section without sub-pages has none")
    expect(actions.map(\.id) == ["new"], "menu actions that are not in-app routes are dropped")
} else {
    expect(false, "menu decodes")
}

expect(ShellMessage.components("2026-10-08T09:00")?.hour == 9, "reminder time decodes")
expect(ShellMessage.components("2026-13-08T09:00") == nil, "an impossible month is refused")
expect(ShellMessage.components("2026-10-08T25:00") == nil, "an impossible hour is refused")
expect(ShellMessage.components("soon") == nil, "free text is refused")

if case .reminders(let reminders)? = message("reminders", ["items": [
    ["id": "a", "title": "A", "body": "", "at": "2026-10-08T09:00", "path": "/invoices"],
    ["id": "b", "title": "B", "body": "", "at": "yesterday", "path": "/invoices"],
    ["id": "c", "title": "C", "body": "", "at": "2026-10-09T09:00", "path": "https://evil.example"],
]]) {
    expect(reminders.map(\.id) == ["a"], "reminders with a bad time or route are dropped")
} else {
    expect(false, "reminders decode")
}

// MARK: Reminder planning

func reminder(_ id: String, daysFromNow days: Int, hour: Int = 9, now: Date) -> Reminder {
    let date = Calendar.current.date(byAdding: .day, value: days, to: now)!
    var parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
    parts.hour = hour
    parts.minute = 0
    parts.calendar = .current
    parts.timeZone = .current
    return Reminder(id: id, title: id, body: "", at: parts, path: "/finance")
}

let now = Date()
let planned = ReminderScheduler.plan([
    reminder("later", daysFromNow: 5, now: now),
    reminder("past", daysFromNow: -2, now: now),
    reminder("soon", daysFromNow: 1, now: now),
], now: now)
expect(planned.map(\.id) == ["soon", "later"], "past reminders are dropped and the rest are in date order")

let many = (1...80).map { reminder("r\($0)", daysFromNow: $0, now: now) }
let kept = ReminderScheduler.plan(many.reversed(), now: now)
expect(kept.count == 60, "no more than 60 reminders are kept")
expect(kept.first?.id == "r1" && kept.last?.id == "r60", "the nearest ones are the ones kept")

// MARK: SiteConfig

func site(_ id: String, development: Bool = false) -> SiteConfig {
    SiteConfig(id: id, title: id, origin: url("https://\(id).example"), accessHost: nil, isDevelopmentOrigin: development)
}

expect(site("alpha").dataStoreIdentifier == site("alpha").dataStoreIdentifier, "a site keeps its data store")
expect(site("alpha").dataStoreIdentifier != site("delta").dataStoreIdentifier, "sites never share a data store")
expect(site("alpha").dataStoreIdentifier != site("alpha", development: true).dataStoreIdentifier, "a development build never shares the real data")

print(failures == 0 ? "All \(checks) checks passed." : "\(failures) of \(checks) checks failed.")
exit(failures == 0 ? 0 : 1)
