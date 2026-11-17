# Фирменные шаблоны БАНАН NEWS

По указанию владельца сюда скопированы готовые HTML-шаблоны и логотип из исходного проекта. Оригинальные файлы не менялись. Чёрный фон, жёлтый акцент #FFC928, Montserrat 900 Italic, фото с градиентом, логотип БН и фирменный нижний блок.

Шрифты сохранены локально с лицензиями OFL: превью не зависит от Google Fonts и не подменяет Montserrat системным шрифтом.

Проверка оформления:

```bash
node scripts/preview-brand.mjs news artifacts/iem-brand.json artifacts/iem-brand.png
```

Нужен Chromium. Скрипт использует CHROMIUM_EXECUTABLE_PATH, системный /usr/bin/chromium или браузер Playwright (`npx playwright install chromium`). Это локальный инструмент проверки макета, не Cloudflare Worker: HTML/Chromium не объявляются совместимыми с Worker. Боевой WASM-рендерер ещё не заменён — сначала владелец оценивает фирменное превью. Никаких отправок в Telegram эта команда не делает.
