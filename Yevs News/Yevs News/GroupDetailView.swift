//
//  GroupDetailView.swift
//  Yevs News
//
//  Created by YEVGENIY POLLE on 25/1/2026.
//

import SwiftUI

struct GroupDetailView: View {
    let kindTitle: String   // "Тикер" или "Тема"
    let group: SummaryGroup

    var body: some View {
        List {
            Section("\(kindTitle): \(group.value)") {
                HStack {
                    Text("Публикаций за 24ч")
                    Spacer()
                    Text("\(group.itemsCount)")
                        .foregroundColor(.secondary)
                }
            }

            Section("Коротко") {
                ForEach(group.bullets, id: \.self) { b in
                    Text("• \(b)")
                }
            }

            Section("Ссылки") {
                if group.topLinks.isEmpty {
                    Text("Нет ссылок")
                        .foregroundColor(.secondary)
                } else {
                    ForEach(group.topLinks) { l in
                        if let url = URL(string: l.url) {
                            Link(destination: url) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(l.title)
                                        .font(.body)
                                        .lineLimit(3)

                                    HStack(spacing: 8) {
                                        if let source = l.source, !source.isEmpty {
                                            Text(source)
                                        }
                                        if let published = l.publishedAt, !published.isEmpty {
                                            Text(published.prefix(10))
                                        }
                                    }
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(group.value)
        .navigationBarTitleDisplayMode(.inline)
    }
}
