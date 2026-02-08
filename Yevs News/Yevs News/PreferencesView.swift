import SwiftUI

struct PreferencesView: View {
    enum BulkKind { case tickers, topics }
    @State private var tickers: [String] = []
    @State private var topics: [String] = []

    @State private var newTicker = ""
    @State private var newTopic = ""

    @State private var searchText = ""

    @State private var isLoading = false
    @State private var status: String?

    @State private var showBulk = false
    @State private var bulkKind: BulkKind = .tickers
    @State private var bulkText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Тикеры") {
                    addRow(
                        placeholder: "NVDA",
                        text: $newTicker,
                        autocap: .characters
                    ) {
                        addTicker(newTicker)
                        newTicker = ""
                    }

                    Button("Импорт списка тикеров…") {
                        bulkKind = .tickers
                        bulkText = tickers.joined(separator: ", ")
                        showBulk = true
                    }

                    if filteredTickers.isEmpty {
                        Text(tickers.isEmpty ? "Пока тикеров нет" : "Ничего не найдено")
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(filteredTickers, id: \.self) { t in
                            Text(t)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        tickers.removeAll { $0 == t }
                                    } label: {
                                        Label("Удалить", systemImage: "trash")
                                    }
                                }
                        }
                    }
                }

                Section("Темы") {
                    addRow(
                        placeholder: "ИИ",
                        text: $newTopic,
                        autocap: .sentences
                    ) {
                        addTopic(newTopic)
                        newTopic = ""
                    }

                    Button("Импорт списка тем…") {
                        bulkKind = .topics
                        bulkText = topics.joined(separator: ", ")
                        showBulk = true
                    }

                    if filteredTopics.isEmpty {
                        Text(topics.isEmpty ? "Пока тем нет" : "Ничего не найдено")
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(filteredTopics, id: \.self) { t in
                            Text(t)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        topics.removeAll { $0 == t }
                                    } label: {
                                        Label("Удалить", systemImage: "trash")
                                    }
                                }
                        }
                    }
                }

                if let status {
                    Section { Text(status).foregroundColor(.secondary) }
                }

                Section {
                    Button(isLoading ? "Сохранение..." : "Сохранить") {
                        Task { await save() }
                    }
                    .disabled(isLoading)

                    Button(isLoading ? "Обновление..." : "Обновить дайджест сейчас") {
                        Task { await runNow() }
                    }
                    .disabled(isLoading)
                }
            }
            .navigationTitle("Preferences")
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Поиск тикеров/тем")
            .scrollDismissesKeyboard(.interactively)
            .task { await load() }
            .sheet(isPresented: $showBulk) { bulkSheet }
        }
    }

    // MARK: - UI helpers

    @ViewBuilder
    private func addRow(
        placeholder: String,
        text: Binding<String>,
        autocap: TextInputAutocapitalization,
        onAdd: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            TextField("Добавить… (например \(placeholder))", text: text)
                .textInputAutocapitalization(autocap)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit(onAdd)

            Button("Добавить", action: onAdd)
                .disabled(text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var bulkSheet: some View {
        NavigationStack {
            Form {
                Section(bulkKind == .tickers ? "Импорт тикеров" : "Импорт тем") {
                    Text("Можно вставлять через запятую, точку с запятой или с новой строки.")
                        .font(.footnote)
                        .foregroundColor(.secondary)

                    TextEditor(text: $bulkText)
                        .frame(minHeight: 220)
                }
            }
            .navigationTitle("Импорт")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { showBulk = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Применить") {
                        applyBulk()
                        showBulk = false
                    }
                }
            }
        }
    }

    // MARK: - Derived

    private var filteredTickers: [String] {
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return tickers }
        return tickers.filter { $0.localizedCaseInsensitiveContains(searchText) }
    }

    private var filteredTopics: [String] {
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return topics }
        return topics.filter { $0.localizedCaseInsensitiveContains(searchText) }
    }

    // MARK: - Normalization

    private func splitItems(_ text: String) -> [String] {
        text
            .split { ch in ch == "," || ch == ";" || ch == "\n" }
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func addTicker(_ raw: String) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !t.isEmpty else { return }
        if !tickers.contains(t) { tickers.append(t) }
        tickers.sort()
    }

    private func addTopic(_ raw: String) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        if !topics.contains(t) { topics.append(t) }
        topics.sort { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    private func applyBulk() {
        let items = splitItems(bulkText)

        switch bulkKind {
        case .tickers:
            for i in items { addTicker(i) }
        case .topics:
            for i in items { addTopic(i) }
        }
    }

    // MARK: - API

    private func load() async {
        do {
            isLoading = true; status = nil
            let p = try await APIClient.shared.getPreferences()
            tickers = p.tickers.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            topics  = p.topics.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

            tickers = Array(Set(tickers)).sorted()
            topics  = Array(Set(topics)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }

            isLoading = false
        } catch {
            isLoading = false
            status = "Ошибка загрузки: \(error.localizedDescription)"
        }
    }

    private func save() async {
        do {
            isLoading = true; status = nil
            try await APIClient.shared.savePreferences(
                tickers: tickers,
                topics: topics
            )
            isLoading = false
            status = "Сохранено ✅"
        } catch {
            isLoading = false
            status = "Ошибка сохранения: \(error.localizedDescription)"
        }
    }

    private func runNow() async {
        do {
            isLoading = true
            status = "Запускаю обновление…"

            try await APIClient.shared.runAllStages(rssLimit: 20) { step, total in
                Task { @MainActor in
                    status = "Обновление: шаг \(step)/\(total)…"
                }
            }

            isLoading = false
            status = "Готово ✅ Теперь открой вкладку «Сегодня» и нажми «Обновить»."
        } catch {
            isLoading = false
            status = "Ошибка обновления: \(error.localizedDescription)"
        }
    }
}

