import UIKit

/// Referenced by name from Info.plist (`UISceneDelegateClassName`), so the Objective-C name is fixed.
@objc(StorSceneDelegate)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    static weak var current: SceneDelegate?

    var window: UIWindow?
    private var controller: WebViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let controller = WebViewController(site: SiteConfig.load())
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        self.controller = controller
        Self.current = self

        // A reminder that launched the app opens its page; otherwise the start page.
        let launchPath = connectionOptions.notificationResponse?.notification.request.content.userInfo["path"] as? String
        controller.host.load(path: launchPath ?? "/")
    }

    func open(path: String) {
        controller?.host.navigate(to: path)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        controller?.didEnterBackground()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        controller?.willEnterForeground()
    }
}
