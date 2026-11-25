import SwiftUI

@main
struct VeloMobileApp: App {
    @StateObject private var store = VeloStore()
    @StateObject private var appearance = VeloAppearanceSettings.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootSessionsView(store: store)
                .environmentObject(appearance)
                .preferredColorScheme(appearance.preferredColorScheme)
                .onOpenURL { url in
                    store.handleIncomingURL(url)
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        store.ensureConnectedOnForeground()
                    case .background:
                        store.handleAppDidEnterBackground()
                    default:
                        break
                    }
                }
        }
    }
}
