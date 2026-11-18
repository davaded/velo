import SwiftUI

@main
struct VeloMobileApp: App {
    @StateObject private var store = VeloStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootSessionsView(store: store)
                .onOpenURL { url in
                    store.handleIncomingURL(url)
                }
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .active {
                        store.ensureConnectedOnForeground()
                    }
                }
        }
    }
}
