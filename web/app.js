const STORAGE_KEY = "yev_news_web_config";

const state = {
    baseUrl: "",
    token: "",
};

const els = {
    apiBaseUrl: document.getElementById("apiBaseUrl"),
    apiToken: document.getElementById("apiToken"),
    saveConfigBtn: document.getElementById("saveConfigBtn"),
    clearConfigBtn: document.getElementById("clearConfigBtn"),
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

function loadConfig() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        state.baseUrl = (data.baseUrl || "").replace(/\/$/, "");
        state.token = data.token || "";
    } catch {
        // ignore
    }
}

function saveConfig() {
    state.baseUrl = els.apiBaseUrl.value.trim().replace(/\/$/, "");
    state.token = els.apiToken.value.trim();

    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
            baseUrl: state.baseUrl,
            token: state.token,
        })
    );

    setStatus("Конфигурация сохранена", "ok");
}

function clearConfig() {
    localStorage.removeItem(STORAGE_KEY);
    state.baseUrl = "";
    state.token = "";
    els.apiBaseUrl.value = "";
    els.apiToken.value = "";
    setStatus("Конфигурация очищена", "ok");
}

function requireConfig() {
    if (!state.baseUrl || !state.token) {
        throw new Error("Заполните API Base URL и API Token в секции подключения.");
    }
}

async function apiGet(path) {
    requireConfig();

    const resp = await fetch(`${state.baseUrl}${path}`, {
        headers: {
            Authorization: `Bearer ${state.token}`,
        },
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return data;
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
      <h3><a href="${item.url}" target="_blank" rel="noopener noreferrer">${item.title || "Без заголовка"}</a></h3>
      <div class="digest-meta">
        <span>${item.source || "Unknown source"}</span>
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
            .map((b) => `<li>${b}</li>`)
            .join("");

        const links = (group.topLinks || [])
            .map(
                (l) => `
          <div class="link-item">
            <a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.title || l.url}</a>
            <div class="digest-meta">${l.source || ""} ${l.publishedAt ? `· ${fmtDate(l.publishedAt)}` : ""}</div>
          </div>
        `
            )
            .join("");

        card.innerHTML = `
      <h3>${group.value} <span class="meta">(${group.itemsCount || 0})</span></h3>
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
        setStatus(`Ошибка: ${error.message}`, "error");
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
        setStatus(`Ошибка запуска pipeline: ${error.message}`, "error");
    }
}

function bindEvents() {
    els.saveConfigBtn.addEventListener("click", saveConfig);
    els.clearConfigBtn.addEventListener("click", clearConfig);
    els.refreshBtn.addEventListener("click", refreshData);
    els.runBtn.addEventListener("click", runTodayPipeline);
}

function init() {
    loadConfig();
    els.apiBaseUrl.value = state.baseUrl;
    els.apiToken.value = state.token;
    bindEvents();

    if (state.baseUrl && state.token) {
        refreshData();
    } else {
        setStatus("Укажите API Base URL и API Token, затем нажмите «Обновить данные».");
    }
}

init();
