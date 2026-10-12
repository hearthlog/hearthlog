import UIKit

/// Asks iOS for a little more time when the app is sent away with changes still waiting to upload.
/// The page does the uploading; this only keeps the app running while it has some left.
@MainActor
final class BackgroundFlush {
    var pending = 0 {
        didSet { if pending == 0 { end() } }
    }

    private var task = UIBackgroundTaskIdentifier.invalid

    func begin() {
        guard pending > 0, task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "stor.outbox") { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}
