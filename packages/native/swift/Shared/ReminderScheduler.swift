import Foundation
import UserNotifications

/// Keeps the device's pending notifications equal to the page's latest reminder list.
/// Only requests this scheduler made (identifier prefix `stor.reminder.`) are replaced.
actor ReminderScheduler {
    static let shared = ReminderScheduler()

    private static let prefix = "stor.reminder."
    /// iOS keeps at most 64 pending local notifications.
    private static let limit = 60
    private var applied: [Reminder]?

    /// Asks for permission the first time; false if the person said no.
    func authorize() async -> Bool {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional:
            return true
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        default:
            return false
        }
    }

    /// The reminders worth scheduling: still in the future, soonest first, no more than the device keeps.
    nonisolated static func plan(_ reminders: [Reminder], now: Date) -> [Reminder] {
        reminders
            .compactMap { reminder in reminder.date.flatMap { $0 > now ? (reminder, $0) : nil } }
            .sorted { $0.1 < $1.1 }
            .prefix(limit)
            .map(\.0)
    }

    func apply(_ reminders: [Reminder], now: Date = Date()) async {
        let wanted = Self.plan(reminders, now: now)
        guard wanted != applied else { return }

        let center = UNUserNotificationCenter.current()
        // Nothing to schedule is not a reason to ask for permission.
        let allowed = wanted.isEmpty ? true : await authorize()
        guard allowed else {
            await removeAll(center)
            applied = []
            return
        }
        await removeAll(center)
        for reminder in wanted {
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default
            content.userInfo = ["path": reminder.path]
            let trigger = UNCalendarNotificationTrigger(dateMatching: reminder.at, repeats: false)
            try? await center.add(UNNotificationRequest(identifier: Self.prefix + reminder.id, content: content, trigger: trigger))
        }
        applied = wanted
    }

    private func removeAll(_ center: UNUserNotificationCenter) async {
        let ids = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(Self.prefix) }
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }
}
