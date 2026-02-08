type Kind = "ticker" | "topic";

function log(...args: any[]) {
    console.log("[summaries]", ...args);
}
function logErr(...args: any[]) {
    console.error("[summaries]", ...args);
}





export type NewsItemLike = {
    title: string;
    description?: string | null;
    url: string;
    source?: string | null;
    publishedAt: string; // ISO
    matchedTickers?: string[];
    matchedTopics?: string[];

    // на случай, если у тебя это хранится строкой JSON
    matched_tickers?: string;
    matched_topics?: string;
};

export type EnvLike = {
    news_digest: D1Database;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
};

function safeJsonArray(v: unknown): string[] {
    try {
        if (Array.isArray(v)) return v.filter((x) => typeof x === "string") as string[];
        if (typeof v === "string" && v.trim().startsWith("[")) {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
        }
    } catch { }
    return [];
}

function getMatches(item: NewsItemLike, kind: Kind): string[] {
    if (kind === "ticker") return safeJsonArray(item.matchedTickers ?? item.matched_tickers);
    return safeJsonArray(item.matchedTopics ?? item.matched_topics);
}

function getYMDInTZ(d: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(d);

    const y = parts.find((p) => p.type === "year")?.value ?? "1970";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${day}`;
}

function sortByPublishedDesc(a: NewsItemLike, b: NewsItemLike): number {
    const ta = Date.parse(a.publishedAt) || 0;
    const tb = Date.parse(b.publishedAt) || 0;
    return tb - ta;
}

function pickTopLinks(items: NewsItemLike[], limit = 5) {
    return items.slice(0, limit).map((x) => ({
        title: x.title,
        url: x.url,
        source: x.source ?? "",
        publishedAt: x.publishedAt,
    }));
}

/**
 * Вытаскиваем текст из Responses API:
 * response.output[...].content[...]{type:"output_text", text:"..."} :contentReference[oaicite:1]{index=1}
 */
function extractOutputText(resp: any): string {
    const out = resp?.output;
    if (!Array.isArray(out)) return "";
    for (const item of out) {
        const content = item?.content;
        if (!Array.isArray(content)) continue;
        const chunk = content.find((c: any) => c?.type === "output_text" && typeof c?.text === "string");
        if (chunk?.text) return chunk.text as string;
    }
    return "";
}

function trunc(s: unknown, n: number) {
    const t = (s ?? "").toString();
    return t.length > n ? t.slice(0, n) + "…" : t;
}

function buildCompact(items: NewsItemLike[], maxDesc = 320) {
    return items.map((x) => ({
        title: trunc(x.title, 220),
        description: trunc(x.description ?? "", maxDesc),
        source: trunc(x.source ?? "", 60),
        publishedAt: x.publishedAt,
        // url НЕ шлём в OpenAI (он не нужен для буллетов)
    }));
}

function takeByCharBudget(items: NewsItemLike[], budget = 14000) {
    const out: NewsItemLike[] = [];
    let used = 0;

    for (const it of items) {
        const piece = `${it.title}\n${it.description ?? ""}\n`;
        if (used + piece.length > budget) break;
        out.push(it);
        used += piece.length;
    }
    return out;
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OpenAIErrorInfo = {
    status: number;          // HTTP status, 0 if network/unknown
    message: string;
    code?: string;
    type?: string;
    param?: string;
    requestId?: string;
    // truncated raw body (useful when message missing)
    raw?: string;
};

class OpenAIRequestError extends Error {
    public status: number;
    public code?: string;
    public type?: string;
    public param?: string;
    public requestId?: string;
    public raw?: string;

    constructor(info: OpenAIErrorInfo) {
        super(info.message || `OpenAI error (HTTP ${info.status})`);
        this.name = "OpenAIRequestError";
        this.status = info.status;
        this.code = info.code;
        this.type = info.type;
        this.param = info.param;
        this.requestId = info.requestId;
        this.raw = info.raw;
    }
}

function tryParseOpenAIErrorBody(text: string): Partial<OpenAIErrorInfo> {
    // OpenAI обычно возвращает JSON вида { error: { message, type, code, param } }
    try {
        const j = JSON.parse(text);
        const err = (j as any)?.error;
        if (err && typeof err === "object") {
            const msg = typeof err.message === "string" ? err.message : "";
            return {
                message: msg,
                code: typeof err.code === "string" ? err.code : undefined,
                type: typeof err.type === "string" ? err.type : undefined,
                param: typeof err.param === "string" ? err.param : undefined,
            };
        }
    } catch { }
    return {};
}

function normalizeAiError(e: any): OpenAIErrorInfo {
    if (e instanceof OpenAIRequestError) {
        return {
            status: e.status,
            message: e.message || "OpenAIRequestError",
            code: e.code,
            type: e.type,
            param: e.param,
            requestId: e.requestId,
            raw: e.raw,
        };
    }

    const msg = (e && typeof e.message === "string") ? e.message : String(e);
    return { status: 0, message: msg };
}

function buildAiErrorBullet(e: any): string {
    const info = normalizeAiError(e);
    const parts: string[] = [];
    if (info.status) parts.push(`HTTP ${info.status}`);
    if (info.code) parts.push(info.code);
    else if (info.type) parts.push(info.type);

    let base = parts.length ? `${parts.join(" ")}: ` : "";
    let message = (info.message || info.raw || "unknown error").replace(/\s+/g, " ").trim();

    // если message пустой, попробуем raw
    if (!message && info.raw) message = info.raw.replace(/\s+/g, " ").trim();

    let out = `${base}${message}`;
    if (info.requestId) out += ` (req_id=${info.requestId})`;

    // в UI держим коротко (чтобы не разваливать карточку)
    return trunc(out, 320);
}


async function fetchWithRetry(url: string, init: RequestInit, tries = 5) {
    let lastErr: any = null;

    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url, init);
            if (r.ok) return r;

            const status = r.status || 0;
            const requestId =
                r.headers.get("x-request-id") ||
                r.headers.get("x-requestid") ||
                r.headers.get("request-id") ||
                undefined;

            const bodyText = await r.text().catch(() => "");
            const parsed = tryParseOpenAIErrorBody(bodyText);

            const err = new OpenAIRequestError({
                status,
                message: parsed.message || `OpenAI error (HTTP ${status})`,
                code: parsed.code,
                type: parsed.type,
                param: parsed.param,
                requestId,
                raw: bodyText.slice(0, 2000),
            });

            lastErr = err;

            const retryable = [408, 429, 500, 502, 503, 504].includes(status);
            if (!retryable) throw err;

            const backoff = 600 * Math.pow(2, i) + Math.floor(Math.random() * 300);
            await sleep(backoff);
        } catch (e: any) {
            // Если это уже разобранная ошибка OpenAI и она НЕ retryable — выходим сразу
            if (e instanceof OpenAIRequestError) {
                const retryable = [408, 429, 500, 502, 503, 504].includes(e.status);
                if (!retryable) throw e;
            }

            // fetch() мог кинуть ошибку сети / DNS / TLS
            lastErr = e;

            const backoff = 600 * Math.pow(2, i) + Math.floor(Math.random() * 300);
            // на последней попытке — просто выкидываем
            if (i === tries - 1) break;
            await sleep(backoff);
        }
    }

    throw lastErr ?? new Error("OpenAI request failed");
}


async function upsertDailyGroupSummary(env: EnvLike, row: {
    date: string;
    kind: Kind;
    value: string;
    bullets: string[];
    topLinks: any[];
    itemsCount: number;
    model: string;
}) {
    await env.news_digest.prepare(
        `INSERT INTO daily_group_summaries
      (date, kind, value, bullets, top_links, items_count, model, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(date, kind, value) DO UPDATE SET
       bullets=excluded.bullets,
       top_links=excluded.top_links,
       items_count=excluded.items_count,
       model=excluded.model,
       created_at=excluded.created_at`
    ).bind(
        row.date,
        row.kind,
        row.value,
        JSON.stringify(row.bullets),
        JSON.stringify(row.topLinks),
        row.itemsCount,
        row.model,
        new Date().toISOString()
    ).run();
}





async function openaiSummarizeBullets(args: {
    env: EnvLike;
    kind: Kind;
    value: string;
    items: NewsItemLike[];
}): Promise<{ bullets: string[]; model: string }> {
    const model = (args.env.OPENAI_MODEL || "gpt-4o-mini").trim();
    const apiKey = args.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is missing");
    }

    // компактный вход (обрезаем текст, url не шлём)
    const compact = buildCompact(args.items, 320);

    const system = [
        "Ты — агрегатор новостей.",
        "Задача: по списку новостей ниже написать 2–5 КОРОТКИХ буллета на русском: «что произошло за последние 24 часа».",
        "СТРОГО по фактам из заголовков/описаний. Никаких догадок, причин, прогнозов, оценок и внешних знаний.",
        "Если новостей мало или нет явных событий — честно напиши, что существенных новостей мало/нет.",
        "Формат ответа — JSON по заданной схеме (только массив bullets).",
    ].join("\n");

    const user = [
        `Группа: kind=${args.kind}, value=${args.value}`,
        "Новости (JSON):",
        JSON.stringify(compact),
    ].join("\n");

    // Responses API: POST /v1/responses :contentReference[oaicite:2]{index=2}
    // Structured Outputs через text.format json_schema :contentReference[oaicite:3]{index=3}


    log("OpenAI -> request", {
        kind: args.kind,
        value: args.value,
        model,
        itemsInGroup: args.items.length,
        itemsSent: compact.length,
        approxChars: JSON.stringify(compact).length,
    });




    const r = await fetchWithRetry("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            store: false,
            temperature: 0.2,
            max_output_tokens: 350,
            input: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            text: {
                format: {
                    type: "json_schema",
                    name: "group_summary",
                    strict: true,
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            bullets: {
                                type: "array",
                                minItems: 2,
                                maxItems: 5,
                                items: { type: "string" },
                            },
                        },
                        required: ["bullets"],
                    },
                },
            },
        }),
    });

    if (!r.ok) {
        const errText = await r.text().catch(() => "");
        logErr("OpenAI <- error", {
            kind: args.kind,
            value: args.value,
            status: r.status,
            errText: errText.slice(0, 2000),
        });
        throw new Error(`OpenAI error ${r.status}: ${errText}`);
    }

    log("OpenAI <- ok", { kind: args.kind, value: args.value, status: r.status });




    const data = await r.json();

    // 1) пробуем достать текст максимально надёжно
    const text =
        (typeof (data as any)?.output_text === "string" && (data as any).output_text) ||
        extractOutputText(data) ||
        "";

    // 2) парсим безопасно
    let parsed: any = null;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        const preview = trunc(text, 400);
        logErr("bad JSON from OpenAI", {
            model,
            value: args.value,
            preview,
            rawKeys: Object.keys(data ?? {}),
        });

        // Пусть общий try/catch сохранит это как openai_error и покажет в приложении.
        throw new Error(`OpenAI returned invalid JSON (model=${model}) preview=${preview}`);
    }

    const bullets = Array.isArray(parsed?.bullets) ? parsed.bullets.filter((x: any) => typeof x === "string") : [];
    if (bullets.length < 2) {
        // на всякий случай (чтобы не сломать контракт)
        return {
            bullets: [
                `За последние 24ч существенных новостей по ${args.value} мало/нет.`,
                `Публикаций за 24ч: ${args.items.length}.`,
            ],
            model,
        };
    }

    return { bullets: bullets.slice(0, 5), model };
}

export async function generateGroupSummaries(args: {
    env: EnvLike;
    dateAlmaty: string;               // YYYY-MM-DD (Asia/Almaty)
    items: NewsItemLike[];            // unique items за 24ч (после дедупа)
    tickers: string[];
    topics: string[];
    topN?: number;                    // 10-15
}): Promise<void> {
    const topN = args.topN ?? 30;

    const groups: Array<{ kind: Kind; value: string }> = [
        ...args.tickers.map((v) => ({ kind: "ticker" as const, value: v })),
        ...args.topics.map((v) => ({ kind: "topic" as const, value: v })),
    ];

    for (const g of groups) {
        // Идемпотентность: если уже есть — пропускаем
        const prev = await args.env.news_digest.prepare(
            `SELECT model FROM daily_group_summaries
   WHERE date=?1 AND kind=?2 AND value=?3 LIMIT 1`
        ).bind(args.dateAlmaty, g.kind, g.value).first<any>();

        const prevModel = (prev?.model ?? "").toString();

        // Пропускаем только если уже есть "нормальная" сводка.
        // error/none разрешаем пересчитывать.
        if (prev && prevModel !== "openai_error" && prevModel !== "none") continue;

        // items для группы
        const groupItems = args.items
            .filter((it) => getMatches(it, g.kind).includes(g.value))
            .sort(sortByPublishedDesc);

        const itemsCount = groupItems.length;
        const topItems = takeByCharBudget(groupItems, 14000).slice(0, topN);
        const topLinks = pickTopLinks(topItems, 5);

        // Если мало/нет данных — без OpenAI (экономим и не галлюцинируем)
        if (itemsCount < 2) {
            const bullets = [
                `За последние 24ч существенных новостей по ${g.value} мало/нет.`,
                `Публикаций за 24ч: ${itemsCount}.`,
            ];

            await upsertDailyGroupSummary(args.env, {
                date: args.dateAlmaty,
                kind: g.kind,
                value: g.value,
                bullets,
                topLinks,
                itemsCount,
                model: "none",
            });

            continue;
        }

        // OpenAI может упасть — не ломаем /run
        try {
            const { bullets, model } = await openaiSummarizeBullets({
                env: args.env,
                kind: g.kind,
                value: g.value,
                items: topItems,
            });

            await upsertDailyGroupSummary(args.env, {
                date: args.dateAlmaty,
                kind: g.kind,
                value: g.value,
                bullets,
                topLinks,
                itemsCount,
                model,
            });
        } catch (e) {
            const info = normalizeAiError(e);
            logErr("OpenAI failed", {
                kind: g.kind,
                value: g.value,
                status: info.status,
                code: info.code,
                type: info.type,
                requestId: info.requestId,
                message: trunc(info.message || info.raw || "", 900),
            });

            const bullets = [
                `Не удалось сгенерировать саммари по ${g.value} (ошибка AI).`,
                `Публикаций за 24ч: ${itemsCount}.`,
                `AI error: ${buildAiErrorBullet(e)}`,
            ];

            await upsertDailyGroupSummary(args.env, {
                date: args.dateAlmaty,
                kind: g.kind,
                value: g.value,
                bullets,
                topLinks,
                itemsCount,
                model: "openai_error",
            });
        } finally {
            await sleep(400); // 300–800мс норм
        }
        log("start", { date: args.dateAlmaty, kind: g.kind, value: g.value });




    }
}

export async function handleGetSummariesToday(request: Request, env: EnvLike): Promise<Response> {
    const date = getYMDInTZ(new Date(), "Asia/Almaty");

    const userId = "yev"; // у тебя так же в воркере

    // 1) берем актуальные предпочтения
    const pref = await env.news_digest
        .prepare(`SELECT tickers, topics FROM user_preferences WHERE user_id = ?1`)
        .bind(userId)
        .first<any>();

    const allowedTickers = new Set<string>(safeJsonArray(pref?.tickers));
    const allowedTopics = new Set<string>(safeJsonArray(pref?.topics));

    // 2) берём все summaries на сегодня


    const rows = await env.news_digest.prepare(
        `SELECT date, kind, value, bullets, top_links, items_count
     FROM daily_group_summaries
     WHERE date=?1
     ORDER BY kind, items_count DESC, value ASC`
    ).bind(date).all();

    const tickers: any[] = [];
    const topics: any[] = [];

    for (const r of rows.results as any[]) {
        // 3) фильтр по актуальным спискам
        if (r.kind === "ticker" && !allowedTickers.has(r.value)) continue;
        if (r.kind === "topic" && !allowedTopics.has(r.value)) continue;



        const obj = {
            value: r.value,
            bullets: JSON.parse(r.bullets || "[]"),
            topLinks: JSON.parse(r.top_links || "[]"),
            itemsCount: r.items_count ?? 0,
        };
        if (r.kind === "ticker") tickers.push(obj);
        else if (r.kind === "topic") topics.push(obj);
    }

    return new Response(JSON.stringify({ date, tickers, topics }, null, 2), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type,authorization",
        },
    });
}

export function getAlmatyDateYMD(): string {
    return getYMDInTZ(new Date(), "Asia/Almaty");
}
