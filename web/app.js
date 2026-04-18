const API_BASE_URL =
    "https://script.google.com/macros/s/AKfycbwE-LGIoSUFGECTZ64DWb3rW-iERnjFrE5-XMfn8OIPkF1PxNBYwLmdw-ezULTxK_jWQQ/exec";
const API_TOKEN = "yev_super_secret_12345";

const els = {
    refreshBtn: document.getElementById("refreshBtn"),
    runBtn: document.getElementById("runBtn"),
    status: document.getElementById("status"),
    digestList: document.getElementById("digestList"),
    digestMeta: document.getElementById("digestMeta"),
    tickersList: document.getElementById("tickersList"),
    tickersMeta: document.getElementById("tickersMeta"),
    topicsList: document.getElementById("topicsList"),
    topicsMeta: document.getElementById("topicsMeta"),
};

function setStatus(message, tone = "") {
    els.status.textContent = message;
    els.status.className = `status ${tone}`.trim();
}

async function apiGet(path) {
    const requestUrl = buildRequestUrl(path);
    const resp = await fetch(requestUrl, {
        method: "GET",
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return data;
}

function buildRequestUrl(path) {
    const base = new URL(API_BASE_URL);

    // For Google Apps Script /exec deployments:
    // API expects query param route + auth/token, not path-based routing.
    if (base.pathname.endsWith("/exec")) {
        const [routePath, routeQueryRaw = ""] = String(path).split("?");
        const route = routePath.replace(/^\//, "");
        const routeQuery = new URLSearchParams(routeQueryRaw);

        const url = new URL(API_BASE_URL);
        url.searchParams.set("route", route);
        url.searchParams.set("auth", API_TOKEN);
        url.searchParams.set("token", API_TOKEN);

        for (const [k, v] of routeQuery.entries()) {
            url.searchParams.set(k, v);
        }
        return url.toString();
    }

    // Fallback for regular REST backends.
    return `${API_BASE_URL}${path}`;
}

function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(d);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function renderDigest(items) {
    els.digestList.innerHTML = "";

    if (!items?.length) {
        els.digestList.innerHTML = '<div class="empty">Пока нет digest items за сегодня.</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const item of items) {
        const card = document.createElement("article");
        card.className = "digest-item";
        card.innerHTML = `
      <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "Без заголовка")}</a></h3>
      <div class="digest-meta">
        <span>${escapeHtml(item.source || "Unknown source")}</span>
        <span> · ${fmtDate(item.publishedAt)}</span>
      </div>
    `;
        fragment.append(card);
    }

    els.digestList.append(fragment);
}

function renderSummaryGroup(targetEl, groups) {
    targetEl.innerHTML = "";

    if (!groups?.length) {
        targetEl.innerHTML = '<div class="empty">Нет summary групп на сегодня.</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const group of groups) {
        const card = document.createElement("article");
        card.className = "summary-item";

        const bullets = (group.bullets || [])
            .map((b) => `<li>${escapeHtml(b)}</li>`)
            .join("");

        const links = (group.topLinks || [])
            .map(
                (l) => `
          <div class="link-item">
            <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.title || l.url)}</a>
            <div class="digest-meta">${escapeHtml(l.source || "")} ${l.publishedAt ? `· ${fmtDate(l.publishedAt)}` : ""}</div>
          </div>
        `
            )
            .join("");

        card.innerHTML = `
      <h3>${escapeHtml(group.value)} <span class="meta">(${group.itemsCount || 0})</span></h3>
      <ul class="bullets">${bullets}</ul>
      <div class="links">${links || '<div class="empty">Нет ссылок</div>'}</div>
    `;
        fragment.append(card);
    }

    targetEl.append(fragment);
}

async function refreshData() {
    try {
        setStatus("Загружаю digest и summaries…");

        const [digest, summaries] = await Promise.all([
            apiGet("/digest/today"),
            apiGet("/summaries/today"),
        ]);

        renderDigest(digest.items || []);
        renderSummaryGroup(els.tickersList, summaries.tickers || []);
        renderSummaryGroup(els.topicsList, summaries.topics || []);

        els.digestMeta.textContent = `${digest.date || ""} · ${(digest.items || []).length} items`;
        els.tickersMeta.textContent = `${(summaries.tickers || []).length} групп`;
        els.topicsMeta.textContent = `${(summaries.topics || []).length} групп`;

        setStatus("Данные обновлены", "ok");
    } catch (error) {
        const hint = error?.message === "Failed to fetch"
            ? " Проверь CORS и что API URL доступен извне."
            : "";
        setStatus(`Ошибка: ${error.message}${hint}`, "error");
    }
}

async function runTodayPipeline() {
    try {
        setStatus("Запрашиваю run plan…");
        const plan = await apiGet("/run/plan");

        if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
            throw new Error("run plan пустой");
        }

        let index = 0;
        for (const step of plan.steps) {
            index += 1;
            setStatus(`Выполняю шаг ${index}/${plan.steps.length}: ${step}`);
            await apiGet(step);
        }

        setStatus("Сборка завершена, обновляю данные…", "ok");
        await refreshData();
    } catch (error) {
        const hint = error?.message === "Failed to fetch"
            ? " Проверь CORS и доступность /exec."
            : "";
        setStatus(`Ошибка запуска pipeline: ${error.message}${hint}`, "error");
    }
}

function bindEvents() {
    els.refreshBtn.addEventListener("click", refreshData);
    els.runBtn.addEventListener("click", runTodayPipeline);
}

function init() {
    bindEvents();
    setStatus("API конфигурация зашита по умолчанию. Загружаю данные…");
    refreshData();
}

init();
