# Web frontend (GitHub Pages)

Этот каталог содержит **изолированный статический веб-интерфейс** для существующего backend API.

## Что делает этот frontend

- Загружает `GET /digest/today`.
- Загружает `GET /summaries/today`.
- По кнопке `Запустить сборку today` вызывает `GET /run/plan` и затем выполняет шаги `GET /run?...`.
- Отображает digest items и summary группы (тикеры/темы) в мобильном friendly UI.
- Использует фиксированные `API_BASE_URL` и `API_TOKEN`, зашитые в `web/app.js` (без ручного ввода в UI).
- Для Google Apps Script `/exec` автоматически отправляет запросы в формате `?route=...&auth=...&token=...` (без `Authorization` header, чтобы избежать CORS preflight проблем).
- Поддерживает fallback route-имена для GAS (`summaries_today`, `digest_today`, `run_plan`) на случай, если backend не использует slash-роуты.
- Если прямой браузерный запрос блокируется CORS (`Failed to fetch`), frontend автоматически пробует публичный CORS proxy (`api.allorigins.win`) как fallback.
- Для запуска pipeline добавлен дополнительный fallback: fire-and-forget вызов `/run` через `mode: "no-cors"` (без чтения тела ответа), затем авто-обновление данных.

## Локальный запуск

Из корня репозитория:

```bash
python3 -m http.server 8080 -d web
```

Откройте: `http://localhost:8080`.

> Примечание: из-за CORS backend должен отвечать с `Access-Control-Allow-Origin`.

## GitHub Pages

В репозитории добавлен workflow `.github/workflows/deploy-web-pages.yml`, который:

- публикует директорию `/web` в GitHub Pages;
- запускается при push в `main` и вручную (`workflow_dispatch`).

Для активации:

1. GitHub → Settings → Pages.
2. Source: **GitHub Actions**.
3. Сделайте push изменений с этой папкой и workflow.

После деплоя сайт будет доступен по URL Pages вашего репозитория.
