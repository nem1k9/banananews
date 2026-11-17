# CS2 News Autoposter

Новый самостоятельный проект. Старые скрипты репозитория не используются и не меняются. По умолчанию **dry-run**: ни одна команда быстрого старта не отправляет сообщения в Telegram.

Worker + D1 + Durable Objects обслуживают новости, матчи, PNG, outbox и защищённую панель. Отдельный VPS запускает официальный `codex exec` с вашим ChatGPT login для обычных новостей и подготовки матчей. Компьютер владельца может быть выключен. API OpenAI не используется, но VPS, Cloudflare и лицензированный live-провайдер могут требовать оплаты.

## Быстрый запуск демонстрации

Node.js 22+, Linux/macOS/WSL. Команды выполняются из **cs2-autoposter/**:

```bash
npm ci
cp .env.example .dev.vars
# Замените три ключа доступа на разные случайные строки >=24 символов.
# MODE=dry-run, Telegram-поля оставьте пустыми.
npm run db:migrate
npm run dev
```

Откройте локальный сервер на порту **8787** в браузере, введите ADMIN_TOKEN из `.dev.vars`. В панели Settings включите автоматическую обработку. Во вкладке Live Matches нажмите «Начать NAVI × Vitality», затем «NAVI побеждает 2:1». Posts покажет PNG, текст, dry-run и задержки. Повторное завершение не создаёт второй пост. Начните новый матч с другим ID через API, если нужна новая симуляция.

Автоматическая проверка в другом терминале:

```bash
# Задайте ADMIN_TOKEN безопасно из своей .dev.vars, не печатая его.
set -a
. ./.dev.vars
set +a
npm run demo
```

Создаются `artifacts/demo.png` и `artifacts/demo.json`. Для реального тестового Telegram-канала — [docs/TELEGRAM.md](docs/TELEGRAM.md); токен и test channel должен предоставить владелец. Основной канал не используется для тестов.

## Проверки

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir artifacts/worker
```

Интеграционные тесты исполняются в workerd с настоящими локальными D1/DO и WASM-рендерингом; внешняя сеть запрещена, Telegram/Steam ответы подменяются управляемыми HTTP-фикстурами. Проверяются конечный PNG, NAVI 2:1, гонки и дедуп, отмены, 429, неопределённая отправка и восстановление, авторизация и lease. Это не доказательство реального подключения к вашему Telegram или live-провайдеру.

Для окружения с read-only домашней директорией можно задать `XDG_CONFIG_HOME=/workspace/.config` перед npm/npx. Не меняйте HOME. Wrangler и тесты хранят рабочие данные в .wrangler, эти данные не коммитятся.

## Развёртывание Cloudflare

1. Сохраните проект в приватном GitHub-репозитории. Существующая ветка в этом репозитории — `claude/banannews-telegram-monitor-lrrhnv`.
2. `npx wrangler login` на доверенной машине. `npx wrangler d1 create cs2-autoposter`.
3. Замените нулевой `database_id` в `wrangler.jsonc` реальным ID. Оставьте MODE=dry-run.
4. Создайте отдельные секреты командами `npx wrangler secret put ADMIN_TOKEN`, `... RUNNER_TOKEN`, `... PROVIDER_WEBHOOK_TOKEN`. Wrangler запрашивает значение без сохранения в коде. Каждый ключ >=24 случайных символов.
5. `npx wrangler d1 migrations apply DB --remote`; `npm run deploy`.
6. Откройте выданный Cloudflare адрес, войдите в панель, запустите demo. Перезапустите браузер/Worker и проверьте, что история сохранилась.
7. Настройте VPS с Codex по [docs/CODEX.md](docs/CODEX.md), установите CODEX_ENABLED=true в wrangler vars, разверните снова. Выполните end-to-end news job с вашим аккаунтом до включения автопостинга.
8. Для тестовой доставки задайте secrets Telegram, MODE=test и allowlist тестового канала. После подтверждённой проверки production включается отдельно: см. Telegram docs.
9. Для результатов настоящих матчей нужен лицензированный адаптер с полными подтверждёнными данными; обычный PandaScore REST сам по себе не объявлен готовым источником финальных round scores. [docs/SOURCES.md](docs/SOURCES.md).

**GitHub workflows:** заготовки находятся внутри `cs2-autoposter/.github/workflows`, чтобы не трогать старый проект. GitHub не исполняет workflows из вложенной папки. Когда будете готовы подключить CI/CD, выполните `node scripts/install-workflows.mjs --install` из этой папки и закоммитьте созданные два НОВЫХ файла корневого `.github/workflows`. Скрипт никогда не перезаписывает существующие файлы. Сейчас эти корневые файлы не созданы. Настройте environment `cs2-autoposter`, secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID и variable D1_DATABASE_ID. Deploy запускается вручную; секундный мониторинг никогда не использует Actions. Workflow по умолчанию разворачивает dry-run, а не production.

## Что требуется для production

- Cloudflare account, D1, подходящий план CPU для WASM-рендера и секреты.
- Отдельный тестовый канал, затем явно настроенный production-канал и бот.
- Лицензированный live-источник с подтверждёнными событиями и разрешённой частотой; измерение задержек на нём.
- Постоянный VPS с реально проверенным ChatGPT login Codex CLI и доступными лимитами подписки.
- Ваши PNG-экспорты PSD и права на фото/логотипы для финального фирменного стиля.

**Цель 20 секунд не гарантируется**: provider discovery + Worker processing + Telegram. Реальное время окончания может быть неизвестно. Встроенный mock подтверждает только локальную механику; показатели dry-run не являются измерением боевой доставки. Система не обещает обходить лимиты подписки или исключать повторный вход в аккаунт.

## Документация

- [Архитектура, задержки и надёжность](docs/ARCHITECTURE.md)
- [Telegram и безопасная обработка uncertain](docs/TELEGRAM.md)
- [Источники и адаптеры](docs/SOURCES.md)
- [JSON-шаблоны и PSD-экспорты](docs/TEMPLATES.md)
- [Codex CLI и облачный runner](docs/CODEX.md)

## Основные API

Все `/api/*` требуют bearer ADMIN_TOKEN, кроме `/api/runner/*` (RUNNER_TOKEN). `GET /api/state`, `GET /api/posts/:id/image`, `POST /api/demo`, `/api/settings`, `/api/test-post`, `/api/scan`, `/api/sources/toggle`, `/api/watch`, `/api/posts/reconcile`. Webhook `/webhooks/live` требует PROVIDER_WEBHOOK_TOKEN. Доступные JSON-контракты определены zod-схемами в src. Не открывайте ключи в query string или ссылках.
