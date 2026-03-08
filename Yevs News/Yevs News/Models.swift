//
//  Models.swift
//  Yevs News
//
//  Created by YEVGENIY POLLE on 25/1/2026.
//

import Foundation

struct Preferences: Codable {
    let userId: String?
    let tickers: [String]
    let topics: [String]
    let updatedAt: String?
}

struct PreferencesSave: Codable {
    let tickers: [String]
    let topics: [String]
}

struct SummariesToday: Codable {
    let date: String
    let tickers: [SummaryGroup]
    let topics: [SummaryGroup]
}

struct SummaryGroup: Codable, Identifiable {
    var id: String { value }
    let value: String
    let bullets: [String]
    let topLinks: [TopLink]
    let itemsCount: Int
}

struct TopLink: Codable, Identifiable {
    var id: String { url }
    let title: String
    let url: String
    let source: String?
    let publishedAt: String?
}
