import { XMLParser } from "fast-xml-parser";

import { handleGetSummariesToday, generateGroupSummaries, getAlmatyDateYMD } from "./summaries";


export interface Env {
  news_digest: D1Database;
  API_KEY: string;

  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}


function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    },
  });
}

function unauthorized() {
  return json({ error: "Unauthorized" }, 401);
}

function getBearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] || "";
}

// ---------- PATCH: query params helpers ----------
function intParam(url: URL, key: string, def: number, min?: number, max?: number) {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  let v = n;
  if (typeof min === "number") v = Math.max(min, v);
  if (typeof max === "number") v = Math.min(max, v);
  return v;
}

function boolParam(url: URL, key: string, def = false) {
  const raw = url.searchParams.get(key);
  if (raw == null) return def;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function normalizeCommaList(v: any, opts?: { upper?: boolean }): string[] {
  const upper = Boolean(opts?.upper);

  const splitOne = (s: string) =>
    s
      .split(/[,\n;]+/g)
      .map((p) => p.trim())
      .filter(Boolean);

  const raw: string[] = Array.isArray(v)
    ? v.map((x) => String(x))
    : typeof v === "string"
      ? splitOne(v)
      : [];

  const cleaned = raw.flatMap((x) => splitOne(String(x)));
  const normalized = cleaned.map((s) => (upper ? s.toUpperCase() : s));
  return [...new Set(normalized)];
}


// ---------- /PATCH ----------

function toAlmatyDateYYYYMMDD() {
  return getAlmatyDateYMD();
}

function stripTracking(urlStr: string) {
  try {
    const u = new URL(urlStr);
    const drop = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "gclid",
      "fbclid",
      "yclid",
    ]);
    for (const k of [...u.searchParams.keys()]) {
      if (drop.has(k)) u.searchParams.delete(k);
    }
    // иногда у Google News есть странные параметры — оставим минимально
    return u.toString();
  } catch {
    return urlStr;
  }
}

async function sha256Hex(input: string) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureUserRow(db: D1Database, userId: string) {
  await db
    .prepare(
      `INSERT INTO user_preferences (user_id, tickers, topics)
       VALUES (?, '[]', '[]')
       ON CONFLICT(user_id) DO NOTHING`
    )
    .bind(userId)
    .run();
}

type FeedItem = {
  title: string;
  url: string;
  publishedAt: string; // ISO
  sourceName: string;
  matchedTickers: string[];
  matchedTopics: string[];
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // достаточно для RSS/Atom
});

function parseDateToIso(d: any): string | null {
  if (!d) return null;
  const s = String(d).trim();
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function ensureArray<T>(v: any): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function extractFromRssOrAtom(xml: string, sourceName: string): Array<{ title: string; link: string; iso: string | null }> {
  const obj = xmlParser.parse(xml);

  // RSS 2.0: rss.channel.item
  const channel = obj?.rss?.channel;
  if (channel) {
    const items = ensureArray<any>(channel.item);
    return items.map((it) => ({
      title: String(it?.title ?? "").trim(),
      link: String(it?.link ?? "").trim(),
      iso: parseDateToIso(it?.pubDate) ?? parseDateToIso(it?.date) ?? parseDateToIso(it?.published),
    }));
  }

  // Atom: feed.entry
  const feed = obj?.feed;
  if (feed) {
    const entries = ensureArray<any>(feed.entry);
    return entries.map((e) => {
      let link = "";
      // atom link может быть массивом объектов с @rel / @href
      const links = ensureArray<any>(e?.link);
      const alt = links.find((l) => l?.["@_rel"] === "alternate") ?? links[0];
      if (typeof alt === "string") link = alt;
      else link = String(alt?.["@_href"] ?? "").trim();

      return {
        title: String(e?.title?.["#text"] ?? e?.title ?? "").trim(),
        link,
        iso: parseDateToIso(e?.updated) ?? parseDateToIso(e?.published),
      };
    });
  }

  return [];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- PATCH: merge helpers for incremental daily_digests ----------
function uniqByUrlKeepLatest(items: any[]) {
  const m = new Map<string, any>();
  for (const it of items) {
    const url = String(it?.url || "");
    if (!url) continue;
    const prev = m.get(url);
    if (!prev) {
      m.set(url, it);
    } else {
      const tp = Date.parse(prev?.publishedAt || "") || 0;
      const tn = Date.parse(it?.publishedAt || "") || 0;
      if (tn >= tp) m.set(url, it);
    }
  }
  return [...m.values()];
}

function sortByPublishedDescAny(a: any, b: any) {
  const ta = Date.parse(a?.publishedAt || "") || 0;
  const tb = Date.parse(b?.publishedAt || "") || 0;
  return tb - ta;
}
// ---------- /PATCH ----------









type Region = "RU" | "US" | "KZ";

function buildGoogleNewsRssUrl(query: string, region: Region = "RU") {
  const q = encodeURIComponent(query);

  if (region === "US") {
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }

  if (region === "KZ") {
    return `https://news.google.com/rss/search?q=${q}&hl=ru&gl=KZ&ceid=KZ:ru`;
  }

  return `https://news.google.com/rss/search?q=${q}&hl=ru&gl=RU&ceid=RU:ru`;
}



function buildYahooFinanceRssUrl(ticker: string) {
  const s = encodeURIComponent(ticker.trim().toUpperCase());
  return `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${s}&region=US&lang=en-US`;
}





const EXTRA_RSS_FEEDS: Array<{ name: string; url: string }> = [
  // США / рынки
  { name: "Reuters:TopNews", url: "https://www.reuters.com/rssFeed/topNews" },
  { name: "MarketWatch:TopStories", url: "https://feeds.marketwatch.com/marketwatch/topstories" },
  { name: "Investing:StockMarket", url: "https://www.investing.com/rss/news_25.rss" },

  // Регуляторы/инфо
  { name: "NasdaqTrader:Headlines", url: "https://www.nasdaqtrader.com/rss.aspx?categorylist=0&feed=currentheadlines" },
  { name: "NasdaqTrader:TradeHalt", url: "https://www.nasdaqtrader.com/rss.aspx?name=TradeHalt" },
  { name: "Fed:PressAll", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { name: "SEC:PressReleases", url: "https://www.sec.gov/news/pressreleases.rss" },
];








async function runDigest(env: Env, opts?: {
  rssOffset?: number;
  rssLimit?: number;
  final?: boolean;
}) {
  const userId = "yev";
  await ensureUserRow(env.news_digest, userId);

  const pref = await env.news_digest
    .prepare(`SELECT tickers, topics FROM user_preferences WHERE user_id = ?`)
    .bind(userId)
    .first<any>();

  const tickers = normalizeCommaList(JSON.parse(pref?.tickers || "[]"), { upper: true });
  const topics = normalizeCommaList(JSON.parse(pref?.topics || "[]"));

  const queries: Array<{ kind: "ticker" | "topic" | "extra"; value: string; rssUrl: string; sourceName: string }> = [
    // Тикеры: RU Google + US Google + KZ Google + Yahoo Finance
    ...tickers.flatMap((t) => ([
      {
        kind: "ticker" as const,
        value: t,
        rssUrl: buildGoogleNewsRssUrl(`${t} stock`, "RU"),
        sourceName: `GoogleNewsRU:${t}`,
      },
      {
        kind: "ticker" as const,
        value: t,
        rssUrl: buildGoogleNewsRssUrl(`${t} stock`, "KZ"),
        sourceName: `GoogleNewsKZ:${t}`,
      },

      {
        kind: "ticker" as const,
        value: t,
        rssUrl: buildGoogleNewsRssUrl(`${t} stock`, "US"),
        sourceName: `GoogleNewsUS:${t}`,
      },
      {
        kind: "ticker" as const,
        value: t,
        rssUrl: buildYahooFinanceRssUrl(t),
        sourceName: `YahooFinance:${t}`,
      },
    ])),

    // Темы: RU Google + US Google + KZ Google
    ...topics.flatMap((t) => ([
      {
        kind: "topic" as const,
        value: t,
        rssUrl: buildGoogleNewsRssUrl(t, "RU"),
        sourceName: `GoogleNewsRU:${t}`,
      },
      {
        kind: "topic" as const,
        value: t,
        rssUrl: buildGoogleNewsRssUrl(t, "US"),
        sourceName: `GoogleNewsUS:${t}`,
      },
      {
        kind: "topic" as const,
        value: t,
        rssUrl: buildGoogleNewsRssUrl(t, "KZ"),
        sourceName: `GoogleNewsKZ:${t}`,
      },
    ])),

    // Доп. источники (не Google)
    ...EXTRA_RSS_FEEDS.map((s) => ({
      kind: "extra" as const,
      value: s.name,
      rssUrl: s.url,
      sourceName: s.name,
    })),
  ];

  // ---------- PATCH: pagination controls ----------
  const rssOffset = Math.max(0, opts?.rssOffset ?? 0);
  const rssLimit = Math.max(0, opts?.rssLimit ?? queries.length);
  const final = Boolean(opts?.final);
  const pageQueries = rssLimit === 0 ? [] : queries.slice(rssOffset, rssOffset + rssLimit);
  // ---------- /PATCH ----------





  if (tickers.length === 0 && topics.length === 0) {
    return { ok: false, error: "Нет тикеров/тем. Сначала сделай POST /preferences." };
  }

  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const date = toAlmatyDateYYYYMMDD();

  // если это финальный шаг без RSS — просто берём уже накопленные items и строим summaries
  if (final && pageQueries.length === 0) {
    const existing = await env.news_digest
      .prepare(`SELECT items FROM daily_digests WHERE date = ?`)
      .bind(date)
      .first<any>();

    const mergedItems = existing ? JSON.parse(existing.items || "[]") : [];

    try {
      await generateGroupSummaries({
        env,
        dateAlmaty: date,
        items: mergedItems,
        tickers,
        topics,
        topN: 12,
      });
    } catch (e) {
      console.error("[summaries] generation failed:", e);
    }

    return { ok: true, date, stats: { finalOnly: true }, paging: { rssOffset, rssLimit, final } };
  }


  // ---------- PATCH: fetch only current page (or none when rssLimit=0) ----------
  const fetched = await mapLimit(pageQueries, 8, async (q) => {
    try {
      const r = await fetch(q.rssUrl, {
        headers: { "user-agent": "yev-news-digest/1.0" },
      });
      if (!r.ok) return { q, ok: false as const, status: r.status, text: "" };
      const text = await r.text();
      return { q, ok: true as const, status: r.status, text };
    } catch (e: any) {
      return { q, ok: false as const, status: 0, text: String(e?.message || e) };
    }
  });

  // ---------- /PATCH ----------


  const items: FeedItem[] = [];

  for (const f of fetched) {
    if (!f.ok) continue;
    const rawItems = extractFromRssOrAtom(f.text, f.q.sourceName);

    for (const it of rawItems) {
      if (!it.title || !it.link) continue;
      const iso = it.iso;
      if (!iso) continue;                 // <- важное изменение
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts)) continue; // <- и это
      if (ts < cutoffMs) continue;

      const cleanUrl = stripTracking(it.link);

      const titleLower = it.title.toLowerCase();

      const matchedTickers: string[] = [];
      const matchedTopics: string[] = [];

      if (f.q.kind === "ticker") matchedTickers.push(f.q.value);
      else if (f.q.kind === "topic") matchedTopics.push(f.q.value);
      else {
        // extra feed: матчим по заголовку
        for (const t of tickers) {
          if (titleLower.includes(t.toLowerCase())) matchedTickers.push(t);
        }
        for (const tp of topics) {
          if (titleLower.includes(tp.toLowerCase())) matchedTopics.push(tp);
        }
      }


      const uniqTickers = [...new Set(matchedTickers)];
      const uniqTopics = [...new Set(matchedTopics)];



      items.push({
        title: it.title,
        url: cleanUrl,
        publishedAt: iso,
        sourceName: f.q.sourceName,
        matchedTickers: uniqTickers,
        matchedTopics: uniqTopics,
      });


    }
  }

  // дедуп по canonical url (и на всякий — по title+source)
  const byKey = new Map<string, FeedItem>();
  for (const it of items) {
    const k1 = it.url;
    const k2 = `${it.sourceName}::${it.title}`.toLowerCase();
    const key = k1 || k2;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, it);
    else {
      // оставим более свежую
      if (Date.parse(it.publishedAt) > Date.parse(prev.publishedAt)) byKey.set(key, it);
    }
  }

  let unique = [...byKey.values()];

  // сортируем: сначала по количеству совпадений, потом по свежести
  unique.sort((a, b) => {
    const sa = (a.matchedTickers.length + a.matchedTopics.length) * 1000 + Date.parse(a.publishedAt);
    const sb = (b.matchedTickers.length + b.matchedTopics.length) * 1000 + Date.parse(b.publishedAt);
    return sb - sa;
  });

  // лимит (чтобы не раздувать)
  unique = unique.slice(0, 200);

  // ---------- PATCH: batch insert into news_items to save subrequests ----------
  // Если unique пустой (например rssLimit=0) — просто пропускаем.
  let inserted = 0;
  if (unique.length > 0) {
    const stmts = [];
    for (const it of unique) {
      const canonical = it.url;
      const fp = await sha256Hex(`${canonical}`);
      stmts.push(
        env.news_digest
          .prepare(
            `INSERT OR IGNORE INTO news_items
              (title, url, canonical_url, published_at, source_id, summary_raw, matched_tickers, matched_topics, fingerprint)
             VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
          )
          .bind(
            it.title,
            it.url,
            canonical,
            it.publishedAt,
            JSON.stringify(it.matchedTickers),
            JSON.stringify(it.matchedTopics),
            fp
          )
      );
    }
    // batch = 1 subrequest вместо сотен
    // @ts-ignore
    const results = await env.news_digest.batch(stmts);
    // @ts-ignore
    for (const r of results || []) inserted += (r?.meta?.changes || 0);
  }
  // ---------- /PATCH ----------


  const digestItems = unique.map((it) => ({
    title: it.title,
    url: it.url,
    publishedAt: it.publishedAt,
    source: it.sourceName,
    matchedTickers: it.matchedTickers,
    matchedTopics: it.matchedTopics,
  }));

  // ---------- PATCH: incremental merge into daily_digests ----------
  const existing = await env.news_digest
    .prepare(`SELECT items, stats FROM daily_digests WHERE date = ?`)
    .bind(date)
    .first<any>();

  const existingItems = existing ? JSON.parse(existing.items || "[]") : [];
  const mergedItems = uniqByUrlKeepLatest([...existingItems, ...digestItems]).sort(sortByPublishedDescAny).slice(0, 200);

  const prevStats = existing ? JSON.parse(existing.stats || "{}") : {};
  const stats = {
    // page stats
    page: { rssOffset, rssLimit, fetchedFeeds: fetched.length },
    // totals-ish
    totalFetched: (prevStats.totalFetched || 0) + items.length,
    unique: mergedItems.length,
    inserted: (prevStats.inserted || 0) + inserted,
    tickersCount: tickers.length,
    topicsCount: topics.length,
    queriesTotal: queries.length,
  };

  await env.news_digest
    .prepare(
      `INSERT INTO daily_digests (date, items, stats)
         VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           items = excluded.items,
           stats = excluded.stats,
           created_at = datetime('now')`
    )
    .bind(date, JSON.stringify(mergedItems), JSON.stringify(stats))
    .run();
  // ---------- /PATCH ----------

  // ---------- PATCH: summaries only on final (or separate call with rssLimit=0&final=1) ----------
  if (final) {
    try {
      await generateGroupSummaries({
        env,
        dateAlmaty: date,
        items: mergedItems, // используем уже накопленную ленту за сегодня
        tickers,
        topics,
        topN: 12,
      });
    } catch (e) {
      console.error("[summaries] generation failed:", e);
    }
  }
  // ---------- /PATCH ----------



  return {
    ok: true,
    date,
    stats,
    sample: digestItems.slice(0, 5),
    paging: { rssOffset, rssLimit, final },
  };
}


export default {

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const rssLimit = 20;

      // 3 страницы RSS
      await runDigest(env, { rssOffset: 0, rssLimit, final: false });
      await runDigest(env, { rssOffset: 20, rssLimit, final: false });
      await runDigest(env, { rssOffset: 40, rssLimit, final: false });
      await runDigest(env, { rssOffset: 60, rssLimit, final: false });


      // финальный шаг: только summaries
      await runDigest(env, { rssOffset: 0, rssLimit: 0, final: true });
    })());
  },




  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return json({ ok: true });

    const token = getBearer(req);
    if (!env.API_KEY || token !== env.API_KEY) return unauthorized();

    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // DEBUG: таблицы
    if (path === "/debug/tables" && req.method === "GET") {
      const res = await env.news_digest
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`)
        .all<any>();
      return json({ tables: res.results.map((r) => r.name) });
    }

    // GET preferences
    if (path === "/preferences" && req.method === "GET") {
      const userId = "yev";
      await ensureUserRow(env.news_digest, userId);

      const row = await env.news_digest
        .prepare(`SELECT user_id, tickers, topics, updated_at FROM user_preferences WHERE user_id = ?`)
        .bind(userId)
        .first<any>();

      return json({
        userId: row.user_id,
        tickers: JSON.parse(row.tickers || "[]"),
        topics: JSON.parse(row.topics || "[]"),
        updatedAt: row.updated_at,
      });
    }

    // POST preferences
    if (path === "/preferences" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as any;
      const normTickers = normalizeCommaList(body.tickers, { upper: true });
      const normTopics = normalizeCommaList(body.topics);

      const userId = "yev";
      await ensureUserRow(env.news_digest, userId);

      await env.news_digest
        .prepare(
          `UPDATE user_preferences
           SET tickers = ?, topics = ?, updated_at = datetime('now')
           WHERE user_id = ?`
        )
        .bind(JSON.stringify(normTickers), JSON.stringify(normTopics), userId)
        .run();

      return json({ ok: true, tickers: normTickers, topics: normTopics });
    }

    // GET digest today
    if (path === "/digest/today" && req.method === "GET") {
      const date = toAlmatyDateYYYYMMDD();

      const row = await env.news_digest
        .prepare(`SELECT date, created_at, items, stats FROM daily_digests WHERE date = ?`)
        .bind(date)
        .first<any>();

      if (!row) return json({ date, createdAt: null, items: [], stats: {} });

      return json({
        date: row.date,
        createdAt: row.created_at,
        items: JSON.parse(row.items || "[]"),
        stats: JSON.parse(row.stats || "{}"),
      });
    }

    // ✅ RUN: собрать дайджест сейчас
    if (path === "/run" && req.method === "GET") {
      // ---------- PATCH: read paging params ----------
      const rss_offset = intParam(url, "rss_offset", 0, 0, 5000);
      const rss_limit = intParam(url, "rss_limit", 20, 0, 200); // 20 безопасно для Free
      const final = boolParam(url, "final", false);
      const result = await runDigest(env, { rssOffset: rss_offset, rssLimit: rss_limit, final });
      // ---------- /PATCH ----------


      return json(result, result.ok ? 200 : 400);
    }

    // ✅ summaries today
    if (path === "/summaries/today" && req.method === "GET") {
      return handleGetSummariesToday(req, env);
    }

    // ✅ RUN PLAN: вернуть список шагов для приложения
    if (path === "/run/plan" && req.method === "GET") {
      const rssLimit = intParam(url, "rss_limit", 20, 0, 50); // 50 максимум
      const pages = intParam(url, "pages", 4, 1, 10);         // 10 максимум

      const steps = [];
      for (let i = 0; i < pages; i++) {
        const offset = i * rssLimit;
        steps.push(`/run?rss_offset=${offset}&rss_limit=${rssLimit}`);
      }
      steps.push(`/run?final=1&rss_limit=0`);

      return json({ ok: true, steps, rssLimit, pages });
    }





    return json({ error: "Not found" }, 404);
  },
};
