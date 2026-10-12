import AppKit

/// Places the standard window buttons where the page's sidebar reserved room for them. The page
/// reports that spot (`[data-stor-lights]`), so the layout decides it and it follows the sidebar.
@MainActor
final class TrafficLights {
    /// Before the page reports: the expanded sidebar's brand row.
    static let fallback = CGPoint(x: 26, y: 38)

    private weak var window: NSWindow?
    private var anchor = TrafficLights.fallback
    private let buttonSpacing: CGFloat
    private var observers: [NSObjectProtocol] = []
    private var applyScheduled = false
    private var isApplying = false

    init(window: NSWindow) {
        self.window = window
        // Keep AppKit's original spacing: a frame notification may arrive while only one button
        // has been reset, so measuring the partly updated group would give the wrong spacing.
        if let close = window.standardWindowButton(.closeButton),
           let miniaturize = window.standardWindowButton(.miniaturizeButton) {
            buttonSpacing = miniaturize.frame.minX - close.frame.minX
        } else {
            buttonSpacing = 20
        }
        let center = NotificationCenter.default
        // AppKit lays the buttons out again on these, so put them back each time.
        for name in [NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification,
                     NSWindow.didExitFullScreenNotification, NSWindow.didBecomeKeyNotification,
                     NSWindow.didResignKeyNotification] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    if name == NSWindow.didResizeNotification {
                        // AppKit has finished this resize's layout. Restore the group before it
                        // is displayed; queued work can wait until the mouse is released.
                        self?.apply()
                    } else {
                        self?.scheduleApply()
                    }
                }
            })
        }
        let close = window.standardWindowButton(.closeButton)
        // Focus changes can reset just the buttons without changing their container's frame.
        let views: [NSView?] = [close, window.standardWindowButton(.miniaturizeButton),
                               window.standardWindowButton(.zoomButton), close?.superview,
                               close?.superview?.superview]
        for view in views.compactMap({ $0 }) {
            view.postsFrameChangedNotifications = true
            observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: view, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.scheduleApply() }
            })
        }
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    /// Width the three buttons take, so the page can leave exactly that much room. Spacing differs between macOS versions.
    static func extent(of window: NSWindow) -> CGFloat {
        guard let close = window.standardWindowButton(.closeButton),
              let zoom = window.standardWindowButton(.zoomButton)
        else { return 62 }
        let width = zoom.frame.maxX - close.frame.minX
        return width >= 40 ? ceil(width) : 62
    }

    func move(to anchor: CGPoint) {
        self.anchor = anchor
        apply()
    }

    private func scheduleApply() {
        guard !isApplying, !applyScheduled else { return }
        applyScheduled = true
        // Finish the current AppKit layout before moving the group; never move one button back
        // synchronously while AppKit is still resetting the others.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.applyScheduled = false
            self.apply()
        }
    }

    func apply() {
        guard !isApplying, let window, !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let miniaturize = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let container = close.superview
        else { return }
        isApplying = true
        defer { isApplying = false }
        let step = buttonSpacing
        // macOS only hit-tests a view inside its container, so a button moved below the title bar would stop
        // working. Grow the title bar container to hold them, and only as wide as they are, so the page's
        // own controls along the top edge stay reachable.
        if let titlebarView = close.superview, let titlebarContainer = titlebarView.superview, titlebarContainer !== window.contentView?.superview {
            let height = ceil(anchor.y + close.frame.height)
            let width = ceil(anchor.x + 2 * step + close.frame.width + 12)
            let frame = NSRect(x: 0, y: window.frame.height - height, width: width, height: height)
            if titlebarContainer.frame != frame { titlebarContainer.frame = frame }
            if titlebarView.frame != titlebarContainer.bounds { titlebarView.frame = titlebarContainer.bounds }
        }
        // The page measures from the window's top; window coordinates start at the bottom.
        let centerY = window.frame.height - anchor.y
        for (index, button) in [close, miniaturize, zoom].enumerated() {
            let point = container.convert(NSPoint(x: anchor.x + CGFloat(index) * step, y: centerY), from: nil)
            let origin = NSPoint(x: point.x, y: point.y - button.frame.height / 2)
            if button.frame.origin != origin { button.setFrameOrigin(origin) }
        }
    }
}
