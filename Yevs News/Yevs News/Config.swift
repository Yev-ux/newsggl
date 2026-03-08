//
//  Untitled.swift
//  Yevs News
//
//  Created by YEVGENIY POLLE on 25/1/2026.
//

import Foundation

enum Config {
    static var baseURL: URL {
        let s = info("API_BASE_URL")
        guard let url = URL(string: s) else { fatalError("Bad API_BASE_URL: \(s)") }
        return url
    }

    static var token: String {
        info("API_TOKEN")
    }

    private static func info(_ key: String) -> String {
        guard let v = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { fatalError("Missing \(key) in Info.plist") }
        return v
    }
}
