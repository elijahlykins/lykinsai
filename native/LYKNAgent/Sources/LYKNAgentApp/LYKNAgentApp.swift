import SwiftUI

@main
struct LYKNAgentApp: App {
    @StateObject private var session = AgentSession()

    var body: some Scene {
        WindowGroup("LYKN Agent") {
            ContentView()
                .environmentObject(session)
        }
        .windowResizability(.contentMinSize)
    }
}
