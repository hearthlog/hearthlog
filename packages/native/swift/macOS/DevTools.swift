#if STOR_DEV
import AppKit
import WebKit

/// Debugging aids for builds made with `--dev` (never in a release build). Set in the environment:
///   STOR_ORIGIN           open this origin instead of the site's, for example http://127.0.0.1:5180
///   STOR_DEV_DELAY        seconds to wait for the page before the steps below (default 6)
///   STOR_DEV_EVAL         body of an async JavaScript function; its returned string is printed as `EVAL <value>`
///   STOR_DEV_EVAL_FILE    the same, read from a file
///   STOR_DEV_NAVIGATE     a route to open through the shell, as the Go menu does
///   STOR_ACCESS_HOST      treat this host as the Cloudflare Access login
///   STOR_DEV_CLICK        "x,y;x,y" window points (from the top left) to send a mouse-down to, after the eval
///   STOR_DEV_LEGACY_PAGE=1   do not define window.storShell, as a page that predates the shell sees it
///   STOR_DEV_DOWNLOAD_DIR save downloads here without a panel
///   STOR_DEV_ALLOW_POPUPS=1  let scripts call window.open without a user gesture
///   STOR_DEV_NO_NOTIFICATIONS=1  do not schedule reminders (that asks for permission); log them instead
///   STOR_DEV_SETTLE       seconds to wait after the eval before the screenshot (default 0)
///   STOR_DEV_SCREENSHOT   write a PNG of the window, with its window controls and glass
///   STOR_DEV_EXIT=1       quit afterwards
@MainActor
enum DevTools {
    static let environment = ProcessInfo.processInfo.environment

    static func log(_ message: String) {
        print("LOG", message)
    }

    static func schedule(for controller: MainWindowController) {
        let environment = Self.environment
        guard environment["STOR_DEV_EVAL"] != nil || environment["STOR_DEV_EVAL_FILE"] != nil || environment["STOR_DEV_SCREENSHOT"] != nil || environment["STOR_DEV_NAVIGATE"] != nil else { return }
        let delay = Double(environment["STOR_DEV_DELAY"] ?? "") ?? 6
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            Task { @MainActor in
                if let path = environment["STOR_DEV_NAVIGATE"] {
                    controller.host.navigate(to: path)
                    try? await Task.sleep(for: .seconds(1))
                }
                let script = environment["STOR_DEV_EVAL"] ?? environment["STOR_DEV_EVAL_FILE"].flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }
                if let body = script {
                    do {
                        let value = try await controller.host.webView.callAsyncJavaScript(body, contentWorld: .page)
                        print("EVAL", value ?? "nil")
                    } catch {
                        print("EVAL error:", error.localizedDescription)
                    }
                }
                if let clicks = environment["STOR_DEV_CLICK"], let window = controller.window {
                    for (index, spec) in clicks.split(separator: ";").enumerated() {
                        let parts = spec.split(separator: ",").compactMap { Double($0) }
                        guard parts.count == 2,
                              let event = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: parts[0], y: window.frame.height - parts[1]), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: index + 1, clickCount: 1, pressure: 1)
                        else { continue }
                        log("click \(spec)")
                        window.sendEvent(event)
                    }
                }
                try? await Task.sleep(for: .seconds(Double(environment["STOR_DEV_SETTLE"] ?? "") ?? 0))
                if let window = controller.window, let close = window.standardWindowButton(.closeButton) {
                    var chain: [String] = []
                    var view: NSView? = close
                    while let current = view { chain.append("\(type(of: current)) \(current.frame)"); view = current.superview }
                    print("TITLEBAR", chain.joined(separator: " < "))
                }
                if let window = controller.window {
                    let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { window.standardWindowButton($0)?.frame }
                    print("STATE badge=\(NSApp.dockTile.badgeLabel ?? "none") menus=\((NSApp.delegate as? AppDelegate)?.menuSummary ?? "")")
                    print("WINDOW key=\(window.isKeyWindow) visible=\(window.isVisible) occluded=\(!window.occlusionState.contains(.visible)) appActive=\(NSApp.isActive) frame=\(window.frame) buttons=\(buttons.map { "\($0.origin.x),\($0.origin.y)" })")
                }
                if let path = environment["STOR_DEV_SCREENSHOT"], let window = controller.window {
                    print("SCREENSHOT", capture(window, to: path) ? path : "failed")
                }
                if environment["STOR_DEV_EXIT"] == "1" { exit(0) }
            }
        }
    }

    private static func capture(_ window: NSWindow, to path: String) -> Bool {
        let options: CGWindowImageOption = [.boundsIgnoreFraming, .bestResolution]
        guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), options),
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }
}
#endif
