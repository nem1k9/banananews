# БАНАН NEWS: автономный CS2-канал

Агент Claude по расписанию запускается в облаке, ищет новости и результаты матчей (bo3.gg + веб-поиск), рисует карточки и публикует посты и опросы в @BananNewws.

- `AGENT.md`: инструкция, по которой агент работает при каждом запуске
- `bo3.py`: результаты, расписание и статистика матчей
- `render.js` + `templates/`: карточки `match`, `player`, `quote`, `news` (1080px)
- `monitor.py`: что нового с прошлого запуска (ленты новостей + bo3.gg)
- `tg.py`: публикация (текст, фото, альбом, опрос, викторина) и защита от повторов по ленте канала
- `emoji.json`: эмодзи команд для текста

Нужны переменные окружения `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHANNEL` (по умолчанию `@BananNewws`).

Проверка: `for t in match player quote news; do node render.js $t examples/$t.json /tmp/$t.png; done`

Кастомные эмодзи (логотипы команд в тексте): с Bot API 9.4 достаточно Telegram Premium у владельца бота (для чатов/групп; для каналов проверяется на практике). ID берутся из эмодзи-пака: `python3 tg.py pack <имя_пака>`, затем вписываются в `custom_id` в `emoji.json`. Если Telegram откажет, tg.py сам отправит пост с обычными эмодзи.

## TikTok (каждая новость отдельным постом)
`tiktok.py` + `.github/workflows/tiktok.yml`: каждый час берёт новые посты канала с картинкой (не старше 6 ч), делает вертикальную картинку с призывом подписаться на Telegram, кладёт её на GitHub Pages (ветка `gh-pages`) и публикует отдельным фото-постом с музыкой от TikTok. Не больше 12 постов в сутки; уже опубликованное — в `gh-pages:tiktok/posted.json`.
Нужны секреты `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_STATE_KEY`; подключение аккаунта — страница `tiktok-login.html` на GitHub Pages, затем Actions → TikTok → Run workflow с кодом. До аудита приложения TikTok публикует только приватно.
