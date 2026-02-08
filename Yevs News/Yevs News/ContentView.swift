import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Сегодня", systemImage: "newspaper") }

            PreferencesView()
                .tabItem { Label("Тикеры/Темы", systemImage: "slider.horizontal.3") }
        }
    }
}

