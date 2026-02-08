import Foundation

final class APIClient {
    static let shared = APIClient()
    private init() {}

    enum APIError: LocalizedError {
        case badURL(String)
        case http(status: Int, message: String, requestId: String?, cfRay: String?)
        case runFailed(String)

        var errorDescription: String? {
            switch self {
            case .badURL(let s): return "Bad URL: \(s)"
            case .http(let status, let message, let requestId, let cfRay):
                var s = "HTTP \(status): \(message)"
                if let requestId { s += " (req_id: \(requestId))" }
                if let cfRay { s += " (cf-ray: \(cfRay))" }
                return s
            case .runFailed(let msg): return "Run failed: \(msg)"
            }
        }
    }

    private func makeRequest(relative: String, method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard let url = URL(string: relative, relativeTo: Config.baseURL) else {
            throw APIError.badURL(relative)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 90
        req.setValue("Bearer \(Config.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return req
    }

    private func fetchData(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: req)

        guard let http = resp as? HTTPURLResponse else { return data }
        if (200..<300).contains(http.statusCode) { return data }

        let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        let requestId = http.value(forHTTPHeaderField: "x-request-id")
        let cfRay = http.value(forHTTPHeaderField: "cf-ray")

        // превью тела (чтобы никогда не выводить километры)
        let rawBody = String(data: data, encoding: .utf8) ?? ""
        let bodyPreview = String(rawBody.prefix(400))

        // Cloudflare часто возвращает HTML при 503/5xx
        if contentType.contains("text/html") {
            let msg: String
            if http.statusCode == 503 {
                msg = "Сервис перегружен (Worker exceeded resource limits). Попробуй ещё раз или уменьши rssLimit."
            } else {
                msg = "Сервер вернул HTML-ошибку."
            }
            throw APIError.http(status: http.statusCode, message: msg, requestId: requestId, cfRay: cfRay)
        }

        // Если это JSON, попробуем вытащить нормальную ошибку
        if contentType.contains("application/json") {
            if let pretty = extractJsonErrorMessage(from: data) {
                throw APIError.http(status: http.statusCode, message: pretty, requestId: requestId, cfRay: cfRay)
            }
        }

        // fallback
        throw APIError.http(status: http.statusCode, message: bodyPreview, requestId: requestId, cfRay: cfRay)
    }

    private func extractJsonErrorMessage(from data: Data) -> String? {
        // 1) твой формат /run: { ok:false, error:"..." }
        if let r = try? JSONDecoder().decode(RunResponse.self, from: data), r.ok == false {
            return r.error ?? "unknown error"
        }
        // 2) общий формат: { error: { message: ... } } или { message: ... }
        if
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        {
            if let err = obj["error"] as? [String: Any],
               let msg = err["message"] as? String { return msg }
            if let msg = obj["message"] as? String { return msg }
        }
        return nil
    }


    // MARK: - Existing API

    func getPreferences() async throws -> Preferences {
        let req = try makeRequest(relative: "/preferences")
        let data = try await fetchData(req)
        return try JSONDecoder().decode(Preferences.self, from: data)
    }

    func savePreferences(tickers: [String], topics: [String]) async throws {
        let payload = PreferencesSave(tickers: tickers, topics: topics)
        let body = try JSONEncoder().encode(payload)
        let req = try makeRequest(relative: "/preferences", method: "POST", body: body)
        _ = try await fetchData(req)
    }

    func getSummariesToday() async throws -> SummariesToday {
        let req = try makeRequest(relative: "/summaries/today")
        let data = try await fetchData(req)
        return try JSONDecoder().decode(SummariesToday.self, from: data)
    }

    // MARK: - Run pipeline (all stages)

    private struct RunStats: Decodable {
        let queriesTotal: Int?
    }

    private struct RunResponse: Decodable {
        let ok: Bool
        let error: String?
        let date: String?
        let stats: RunStats?
    }

    /// Запускает ВСЕ шаги как в терминале: offset-страницы + финальный summaries.
    /// Автоматически считает, сколько страниц нужно, из stats.queriesTotal.
    func runAllStages(rssLimit: Int = 10, onProgress: ((Int, Int) -> Void)? = nil) async throws {
        // 1) первый шаг — чтобы узнать queriesTotal
        onProgress?(1, 1)
        let firstReq = try makeRequest(relative: "/run?rss_offset=0&rss_limit=\(rssLimit)")
        let firstData = try await fetchData(firstReq)
        let first = try JSONDecoder().decode(RunResponse.self, from: firstData)
        if first.ok == false {
            throw APIError.runFailed(first.error ?? "unknown error")
        }

        let total = max(1, first.stats?.queriesTotal ?? rssLimit)  // fallback
        let pages = Int(ceil(Double(total) / Double(rssLimit)))
        let totalSteps = pages + 1  // + финальный шаг

        // 2) остальные страницы
        if pages > 1 {
            for page in 1..<pages {
                onProgress?(page + 1, totalSteps)
                let offset = page * rssLimit
                let req = try makeRequest(relative: "/run?rss_offset=\(offset)&rss_limit=\(rssLimit)")
                let data = try await fetchData(req)
                let r = try JSONDecoder().decode(RunResponse.self, from: data)
                if r.ok == false {
                    throw APIError.runFailed(r.error ?? "unknown error")
                }
            }
        }

        // 3) финальный шаг — построить summaries
        onProgress?(totalSteps, totalSteps)
        let finalReq = try makeRequest(relative: "/run?final=1&rss_limit=0")
        let finalData = try await fetchData(finalReq)
        let final = try JSONDecoder().decode(RunResponse.self, from: finalData)
        if final.ok == false {
            throw APIError.runFailed(final.error ?? "unknown error")
        }
    }

    /// Оставим совместимость с текущей кнопкой — она вызывает runDigest() :contentReference[oaicite:2]{index=2}
    func runDigest() async throws {
        try await runAllStages(rssLimit: 20, onProgress: nil)
    }
}

