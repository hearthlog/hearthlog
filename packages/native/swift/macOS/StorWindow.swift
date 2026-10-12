import AppKit

/// The Mac window. A click on a background of the page (the shell's script reports when the pointer is
/// over one) moves the window. The mouse-down has to be handled here, before any view sees it and with
/// the very event that started it: a drag started later, from a message, is not reliable.
@MainActor
final class StorWindow: NSWindow {
    /// Set from the page: the pointer is over something that is not a control, text or a graphic.
    var backgroundHover = false
    /// The web view; only clicks that land inside it can be background clicks, so the window buttons
    /// and the native title bar strip keep behaving as they do in any Mac window.
    weak var pageView: NSView?

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, backgroundHover, startsBackgroundDrag(event) { return }
        super.sendEvent(event)
    }

    private func startsBackgroundDrag(_ event: NSEvent) -> Bool {
        #if STOR_DEV
        if let frameView = contentView?.superview {
            let hit = frameView.hitTest(event.locationInWindow)
            var chain: [String] = []
            var view = hit
            while let current = view, chain.count < 8 { chain.append(String(describing: type(of: current))); view = current.superview }
            DevTools.log("hit \(chain.joined(separator: " < ")) inPage=\(hit?.isDescendant(of: pageView ?? frameView) == true) frameView=\(type(of: frameView))")
        }
        #endif
        // Modified clicks are the page's (selection, context menus).
        guard event.modifierFlags.intersection([.control, .option, .command, .shift]).isEmpty,
              let pageView, let frameView = contentView?.superview,
              frameView.hitTest(event.locationInWindow)?.isDescendant(of: pageView) == true
        else { return false }
        #if STOR_DEV
        DevTools.log("background mouse-down clickCount=\(event.clickCount)")
        #endif
        if event.clickCount >= 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": miniaturize(nil)
            case "None": break
            default: zoom(nil)
            }
        } else {
            performDrag(with: event)
        }
        return true
    }
}
