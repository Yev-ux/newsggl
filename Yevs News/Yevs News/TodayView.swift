//
//  TodayView.swift
//  Yevs News
//
//  Created by YEVGENIY POLLE on 25/1/2026.
//

import SwiftUI

struct TodayView: View {
    @State private var data: SummariesToday?
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var searchText = ""
    @State private var filter: FilterMode = .all

    private var filteredTickers: [SummaryGroup] {
        guard let data else { return [] }
        return applySearch(to: data.tickers)
    }

    private var filteredTopics: [SummaryGroup] {
        guard let data else { return [] }
        return applySearch(to: data.topics)
    }

    private func applySearch(to items: [SummaryGroup]) -> [SummaryGroup] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter { g in
            if g.value.lowercased().contains(q) { return true }
            if g.bullets.joined(separator: " ").lowercased().contains(q) { return true }
            return false
        }
    }
    
    

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Загрузка...")
                } else if let errorText {
                    VStack(spacing: 12) {
                        Text("Ошибка").font(.headline)
                        Text(errorText).foregroundColor(.red).multilineTextAlignment(.center)
                        Button("Повторить") { Task { await load() } }
                    }
                    .padding()
                } else if let data {
                    List {
                        if filter == .all || filter == .tickers {
                            Section("Тикеры") {
                                if filteredTickers.isEmpty {
                                    Text(searchText.isEmpty ? "Пока пусто" : "Ничего не найдено")
                                        .foregroundColor(.secondary)
                                } else {
                                    ForEach(filteredTickers) { g in
                                        NavigationLink {
                                            GroupDetailView(kindTitle: "Тикер", group: g)
                                        } label: {
                                            SummaryGroupRow(group: g)
                                        }
                                    }
                                }
                            }
                        }

                        if filter == .all || filter == .topics {
                            Section("Темы") {
                                if filteredTopics.isEmpty {
                                    Text(searchText.isEmpty ? "Пока пусто" : "Ничего не найдено")
                                        .foregroundColor(.secondary)
                                } else {
                                    ForEach(filteredTopics) { g in
                                        NavigationLink {
                                            GroupDetailView(kindTitle: "Тема", group: g)
                                        } label: {
                                            SummaryGroupRow(group: g)
                                        }
                                    }
                                }
                            }
                        }
                    }

                } else {
                    Text("Нет данных. Нажми Обновить.")
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Сводка")
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Поиск по тикерам/темам")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Обновить") { Task { await load() } }
                }

                ToolbarItem(placement: .topBarLeading) {
                    Picker("", selection: $filter) {
                        ForEach(FilterMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 240)
                }
            }

            .task {
                // автозагрузка при первом открытии
                if data == nil { await load() }
            }
        }
    }

    private func load() async {
        do {
            isLoading = true; errorText = nil
            data = try await APIClient.shared.getSummariesToday()
            isLoading = false
        } catch {
            isLoading = false
            errorText = error.localizedDescription
        }
    }

    private func refresh() async {
        do {
            isLoading = true; errorText = nil
            try await APIClient.shared.runDigest()
            data = try await APIClient.shared.getSummariesToday()
            isLoading = false
        } catch {
            isLoading = false
            errorText = error.localizedDescription
        }
    }
}

enum FilterMode: String, CaseIterable, Identifiable {
    case all = "Все"
    case tickers = "Тикеры"
    case topics = "Темы"

    var id: String { rawValue }
}



struct SummaryGroupRow: View {
    let group: SummaryGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(group.value).font(.headline)
                Spacer()
                Text("\(group.itemsCount)")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            ForEach(group.bullets, id: \.self) { b in
                Text("• \(b)")
                    .font(.subheadline)
                    .foregroundColor(.primary)
            }

            if !group.topLinks.isEmpty {
                Text("Ссылок: \(group.topLinks.count) →")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
    
}

