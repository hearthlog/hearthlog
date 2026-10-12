import AppKit

/// The Mac menu bar. The standard items are fixed; File's create shortcuts and Go's sections come from
/// the page, which knows which features this site has, and each one opens a route that already exists.
@MainActor
final class AppMenu {
    private let appName: String
    private let fileMenu = NSMenu(title: "File")
    private let goMenu = NSMenu(title: "Go")
    private var destinations: [MenuEntry] = []
    private var actions: [MenuEntry] = []

    init(appName: String) {
        self.appName = appName
    }

    func install() {
        let main = NSMenu()
        main.addItem(submenuItem(appMenu()))
        main.addItem(submenuItem(fileMenu))
        main.addItem(submenuItem(editMenu()))
        main.addItem(submenuItem(viewMenu()))
        main.addItem(submenuItem(goMenu))
        let window = windowMenu()
        main.addItem(submenuItem(window))
        NSApp.mainMenu = main
        NSApp.windowsMenu = window
        rebuildDynamicMenus()
    }

    /// File, Go and the Dock menu as they stand, for the debugging aids.
    var summary: String {
        "File=\(fileMenu.items.map(\.title)) Go=\(goMenu.items.map(\.title)) Dock=\(dockSummary)"
    }

    /// The Dock icon's menu: every available section, its sub-pages as submenus, then a new window.
    func dockMenu() -> NSMenu {
        let menu = NSMenu(title: appName)
        for destination in destinations {
            menu.addItem(destinationItem(destination))
        }
        if !destinations.isEmpty { menu.addItem(.separator()) }
        menu.addItem(item("New Window", #selector(AppDelegate.newWindow(_:)), "", []))
        return menu
    }

    private func destinationItem(_ destination: MenuEntry) -> NSMenuItem {
        guard !destination.children.isEmpty else {
            // A Dock menu has no key equivalents, so sections open on a plain click.
            return pathItem(destination.title, destination.path, "", [])
        }
        let item = NSMenuItem(title: destination.title, action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: destination.title)
        for child in destination.children {
            submenu.addItem(pathItem(child.title, child.path, "", []))
        }
        item.submenu = submenu
        return item
    }

    private var dockSummary: String {
        dockMenu().items.filter { !$0.isSeparatorItem }.map { item in
            guard let submenu = item.submenu else { return item.title }
            return "\(item.title)[\(submenu.items.map(\.title).joined(separator: ","))]"
        }.joined(separator: " ")
    }

    func update(destinations: [MenuEntry], actions: [MenuEntry]) {
        guard destinations != self.destinations || actions != self.actions else { return }
        self.destinations = destinations
        self.actions = actions
        rebuildDynamicMenus()
    }

    // MARK: Menus

    private func appMenu() -> NSMenu {
        let menu = NSMenu(title: appName)
        menu.addItem(item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"))
        menu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        menu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"))
        return menu
    }

    private func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(item("Undo", Selector(("undo:")), "z"))
        menu.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        menu.addItem(.separator())
        menu.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        menu.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        menu.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        menu.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        return menu
    }

    private func viewMenu() -> NSMenu {
        let menu = NSMenu(title: "View")
        menu.addItem(item("Toggle Sidebar", #selector(AppDelegate.toggleSidebar(_:)), "s", [.command, .control]))
        menu.addItem(item("Reload", #selector(AppDelegate.reload(_:)), "r"))
        menu.addItem(.separator())
        menu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        return menu
    }

    private func windowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        menu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))))
        return menu
    }

    private func rebuildDynamicMenus() {
        fileMenu.removeAllItems()
        for (index, action) in actions.enumerated() {
            // The first two get the conventional New shortcuts.
            let (key, modifiers): (String, NSEvent.ModifierFlags) = index == 0 ? ("n", [.command]) : index == 1 ? ("n", [.command, .shift]) : ("", [])
            fileMenu.addItem(pathItem(action.title.capitalized, action.path, key, modifiers))
        }
        if !actions.isEmpty { fileMenu.addItem(.separator()) }
        fileMenu.addItem(item("New Window", #selector(AppDelegate.newWindow(_:)), "n", [.command, .option]))
        fileMenu.addItem(.separator())
        fileMenu.addItem(item("Close Window", #selector(NSWindow.performClose(_:)), "w"))

        goMenu.removeAllItems()
        goMenu.addItem(item("Back", #selector(AppDelegate.goBack(_:)), "["))
        goMenu.addItem(item("Forward", #selector(AppDelegate.goForward(_:)), "]"))
        if !destinations.isEmpty { goMenu.addItem(.separator()) }
        for (index, destination) in destinations.enumerated() {
            goMenu.addItem(pathItem(destination.title, destination.path, index < 9 ? String(index + 1) : "", [.command]))
        }
    }

    // MARK: Items

    private func submenuItem(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    private func item(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        return item
    }

    private func pathItem(_ title: String, _ path: String, _ key: String, _ modifiers: NSEvent.ModifierFlags) -> NSMenuItem {
        let item = item(title, #selector(AppDelegate.openPath(_:)), key, modifiers)
        item.representedObject = path
        return item
    }
}
