# Codex CLI и подписка ChatGPT

Worker не может выполнять Linux CLI и не хранит ChatGPT-токены. Нужен отдельный постоянно работающий VPS: ваш домашний компьютер может быть выключен. GitHub-hosted runner эфемерен, интерактивный ChatGPT login и безопасное сохранение/обновление состояния авторизации нельзя считать надёжными. Проект НЕ переносит auth.json в GitHub Secrets и НЕ использует браузерную автоматизацию. GitHub Actions выполняет CI/deploy, генерация запускается отдельным runner.

Официальные документы: https://developers.openai.com/codex/auth/ и https://developers.openai.com/codex/noninteractive/ . При реализации проверены локальные `codex exec --help` и `codex login --help`: поддерживаются `--device-auth`, `--sandbox read-only`, `--output-schema`, `--output-last-message`, stdin `-` и `--skip-git-repo-check`. Реальный inference с подпиской владельца и работа на GitHub-hosted runner в этой задаче не проверялись. Не выдаём наличие адаптера за успешную авторизацию вашего аккаунта.

На отдельном Linux сервере (Node 22+):

```bash
npm install -g @openai/codex
codex --version
codex login --device-auth
codex login status
# Авторизуйтесь через свой ChatGPT-аккаунт, без API-ключа.
cd /opt/banananews/cs2-autoposter
WORKER_URL=https://YOUR-WORKER.workers.dev RUNNER_TOKEN=YOUR_PRIVATE_RUNNER_TOKEN npm run runner -- --once
```

Не вставляйте секреты в историю shell: для постоянного запуска используйте chmod 600 EnvironmentFile. `runner/cs2-editor.service` — пример systemd. Создайте пользователя cs2editor, каталог `/var/lib/cs2-editor/tmp`, приватный CODEX_HOME и выполните device login именно от этого пользователя с этим CODEX_HOME. В `/etc/cs2-editor.env`: WORKER_URL, RUNNER_TOKEN, CODEX_HOME, TMPDIR. Полезные environment-файлы не коммитить. Путь `/usr/bin/node` поправьте, если Node установлен иначе. Зафиксируйте проверенную версию Codex на своём сервере после первого успешного теста.

Runner создаёт пустую временную директорию, передаёт исходный текст как недоверенные данные, запускает `codex exec` через spawn без shell, read-only sandbox, JSON Schema и таймаут 120 секунд. Telegram, Worker admin и OpenAI API keys не передаются дочернему процессу. stdout/stderr модели не пишутся в журнал. Системный промпт — `prompts/editor.md`. Изменения промпта не требуют правки кода. При ошибке lease истекает и задание снова доступно, не более трёх попыток. После исчерпания попыток оно остаётся failed и не публикуется. Общее состояние хранится в D1.

Ограничения: CLI обновляется; закрепите свою успешно проверенную версию. Использование лимитов подписки не безлимитно. При logout, исчерпании квоты или недоступности сети runner может потребовать ваше действие. Срочные результаты матчей работают на предзаготовленном шаблоне. Обычные новости ждут восстановления Codex. Для автоматического старта включите `systemctl enable --now cs2-editor` после ручной проверки авторизации. Проверьте политику подписки и организации для unattended использования; обходов ограничений нет.
