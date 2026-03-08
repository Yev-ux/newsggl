import Foundation

final class APIClient {
    static let shared = APIClient()
    private init() {}

    enum APIError: LocalizedError {
        case badURL(String)
        case http(status: Int, message: String, requestId: String?, cfRay: String?)
        case runFailed(String)
        case invalidPayload(String)

        var errorDescription: String? {
            switch self {
            case .badURL(let s): return "Bad URL: \(s)"
            case .http(let status, let message, let requestId, let cfRay):
                var s = "HTTP \(status): \(message)"
                if let requestId { s += " (req_id: \(requestId))" }
                if let cfRay { s += " (cf-ray: \(cfRay))" }
                return s
            case .runFailed(let msg): return "Run failed: \(msg)"
            case .invalidPayload(let preview): return "Сервер вернул не-JSON ответ: \(preview)"
            }
        }
    }

    private struct RunResponse: Decodable {
        let ok: Bool
        let error: String?
        let skipped: Bool?
        let message: String?
    }

    struct StatusResponse: Decodable {
        let ok: Bool
        let date: String?
        let timezone: String?
        let windowHours: Int?
        let lastRunAt: String?
        let lastRunStatus: String?
        let lastRunError: String?
        let lastRunGroups: Int?
        let lastRunItems: Int?
    }

    private func makeRequest(route: String, method: String = "GET", query: [URLQueryItem] = [], body: Data? = nil, timeout: TimeInterval = 600) throws -> URLRequest {
        guard var components = URLComponents(url: Config.baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.badURL(Config.baseURL.absoluteString)
        }

        var items = components.queryItems ?? []
        items.append(URLQueryItem(name: "route", value: route))
        items.append(URLQueryItem(name: "auth", value: Config.token))
        items.append(URLQueryItem(name: "token", value: Config.token))
        items.append(contentsOf: query)
        components.queryItems = items

        guard let url = components.url else {
            throw APIError.badURL("route=\(route)")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout
        req.setValue("Bearer \(Config.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return req
    }
    private func fetchData(_ req: URLRequest, timeout: TimeInterval = 600) async throws -> Data {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config)

        let (data, resp) = try await session.data(for: req)

        guard let http = resp as? HTTPURLResponse else { return data }

        let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        let requestId = http.value(forHTTPHeaderField: "x-request-id")
        let cfRay = http.value(forHTTPHeaderField: "cf-ray")

        let rawBody = String(data: data, encoding: .utf8) ?? ""
        let bodyPreview = String(rawBody.prefix(400))

        if (200..<300).contains(http.statusCode) {
            if contentType.contains("text/html") {
                throw APIError.invalidPayload("HTML вместо JSON. Проверь Deploy Web App URL /exec и token.")
            }
            if !contentType.isEmpty && !contentType.contains("application/json") {
                throw APIError.invalidPayload(bodyPreview)
            }
            return data
        }

        if contentType.contains("text/html") {
            let msg: String
            if http.statusCode == 503 {
                msg = "Сервис перегружен (Worker exceeded resource limits). Попробуй ещё раз."
            } else {
                msg = "Сервер вернул HTML-ошибку."
            }
            throw APIError.http(status: http.statusCode, message: msg, requestId: requestId, cfRay: cfRay)
        }

        if contentType.contains("application/json") {
            if let pretty = extractJsonErrorMessage(from: data) {
                throw APIError.http(status: http.statusCode, message: pretty, requestId: requestId, cfRay: cfRay)
            }
        }

        throw APIError.http(status: http.statusCode, message: bodyPreview, requestId: requestId, cfRay: cfRay)
    }

    private func extractJsonErrorMessage(from data: Data) -> String? {
        if let r = try? JSONDecoder().decode(RunResponse.self, from: data), r.ok == false {
            return r.error ?? "unknown error"
        }

        if let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if let err = obj["error"] as? [String: Any],
               let msg = err["message"] as? String {
                return msg
            }

            if let msg = obj["message"] as? String {
                return msg
            }

            if let msg = obj["error"] as? String {
                return msg
            }
        }
        return nil
    }

    func getPreferences() async throws -> Preferences {
        let req = try makeRequest(route: "preferences")
        let data = try await fetchData(req)
        return try JSONDecoder().decode(Preferences.self, from: data)
    }

    func savePreferences(tickers: [String], topics: [String]) async throws {
        let payload = PreferencesSave(tickers: tickers, topics: topics)
        let body = try JSONEncoder().encode(payload)
        let req = try makeRequest(route: "preferences", method: "POST", body: body)
        _ = try await fetchData(req)
    }

    func getSummariesToday() async throws -> SummariesToday {
        let req = try makeRequest(route: "summaries_today")
        let data = try await fetchData(req)
        return try JSONDecoder().decode(SummariesToday.self, from: data)
    }

    func runDigest() async throws -> String? {
        // Full digest pipeline can take several minutes and pass multiple redirects.
        let req = try makeRequest(route: "run", timeout: 600)
        let data = try await fetchData(req, timeout: 600)
        let response: RunResponse
        do {
            response = try JSONDecoder().decode(RunResponse.self, from: data)
        } catch {
            let preview = String((String(data: data, encoding: .utf8) ?? "<non-utf8>").prefix(220))
            throw APIError.invalidPayload(preview)
        }

        if response.ok == false {
            throw APIError.runFailed(response.error ?? "unknown error")
        }
        return response.skipped == true ? (response.message ?? "Пропущено из-за cooldown") : nil
    }

    func getStatus() async throws -> StatusResponse {
        let req = try makeRequest(route: "status")
        let data = try await fetchData(req)
        return try JSONDecoder().decode(StatusResponse.self, from: data)
    }
}
