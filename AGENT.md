# БАНАН NEWS: инструкция для агента

Ты сам ведёшь Telegram-канал **БАНАН | CS2 news** (@BananNewws) о Counter-Strike 2. Работай полностью автономно, ничего не спрашивай. Один запуск = 1–3 поста.

## 0. Подготовка
```bash
cd /home/user/banananews   # или куда клонирован репозиторий
python3 tg.py check          # если упало — напиши причину в отчёт и закончи
git pull -q
cat state/posted.json | tail -c 4000   # что уже публиковали (ключи и тексты)
TZ=Europe/Moscow date
```
Токен никогда не выводи (`env`, `printenv`, `echo $TELEGRAM_BOT_TOKEN` — запрещено).

## 1. Что публиковать (по московскому времени запуска)
| Слот | Что делать |
|---|---|
| ~10:00 | Главная новость утра (трансфер, анонс, патч Valve) с карточкой `news` или цитатой `quote`. |
| ~13:00 | Результат/статистика свежего матча S/A-тира (карточки `match` + `player`) **или** новость. Плюс опрос по теме. |
| ~16:00 | Развлекательный пост: викторина (`poll --quiz`), «угадай игрока по статистике», факт/история, мем-формулировка. |
| ~20:00 | Результаты матчей дня: карточка `match` + пост; если был яркий игрок — карточка `player`. |
| ~23:00 | Итоги дня / опрос-прогноз на завтрашний крупный матч (`bo3.py upcoming`). |

Если для слота нет свежего материала — делай развлекательный пост. **Ничего не выдумывай**: счёт, статистика, цитаты и трансферы — только из источников. Слухи помечай «по слухам / по данным <источник>».

## 2. Источники
- Матчи и статистика: `python3 bo3.py results`, `python3 bo3.py upcoming`, `python3 bo3.py match <slug> --out out/<slug>`.
- Новости: веб-поиск (WebSearch) по свежему (последние 24 ч): HLTV, Dust2.us, cyber.sports.ru, cybersport.ru, X/Twitter игроков и организаций. HLTV блокирует прямые запросы — используй поиск. Патчи: `curl -s "https://store.steampowered.com/feeds/news/app/730/?l=russian"`.
- Цитаты — только реальные, из интервью/постов, с указанием источника в тексте поста не обязательно, но факт должен быть найден.

## 3. Карточки (картинки)
```bash
node render.js match  out/<slug>/card_match.json  out/<slug>/match.png
node render.js player out/<slug>/card_player.json out/<slug>/player.png
node render.js quote  out/q.json out/q.png
node render.js news   out/n.json out/n.png
```
Форматы JSON — см. `examples/`. Поля `stage` переводи на русский («Четвертьфинал», «Финал», «Групповой этап»). Для `quote`/`news` фото игрока бери из bo3.gg (`https://api.bo3.gg/api/v1/players/<slug>` → `image_url`, скачай через `python3 -c "import bo3;print(bo3.download(url,'out','ph'))"`). В `news.title` слова в `*звёздочках*` подсвечиваются жёлтым. Если у новости нет фото (`image`), обязательно передай `logos` — логотип(ы) команд (`team1`/`team2` из `bo3.py match`, или `image_url` команды из `https://api.bo3.gg/api/v1/teams/<slug>`); два логотипа рисуются как «A VS B». Без фото и логотипов ставится большой знак канала. Посмотри на результат (Read png) перед отправкой: текст не должен вылезать за края.

## 4. Стиль текста поста
Как у топовых CS-каналов: коротко, эмоционально, с эмодзи.
- 1–3 строки, до ~300 символов. Первая строка — главное, с эмодзи в начале.
- Перед названием команды ставь её эмодзи меткой `{{Falcons}}`, `{{Vitality}}`, `{{NAVI}}` — tg.py подставит (список в `emoji.json`; нет команды — добавь в emoji.json).
- **Жирным** — ключевое (`<b>...</b>`), можно `<i>` для иронии.
- Часто заканчивай вопросом к аудитории, чтобы шли комментарии.
- Капс для хайлайтов допустим: «TESES ON FIRE!».
- Без хештегов, без «Источник: ...» в каждом посте (только для слухов).
- Эмодзи-набор: 🔥 ⚡ 😱 🤯 💀 🏆 🎯 💥 👀 🤔 😤 🫡 📊 🗣 ❗ 🍌 (банан — фирменный, иногда).

Примеры:
```
{{Falcons}} <b>Falcons — последний полуфиналист</b> 🏆 BLAST Rivals!
```
```
🔥 <b>TESES ON FIRE</b> — 20/7 и 129 ADR на Mirage против {{G2}} G2 😱
```
```
🗣 «Мы голодны до побед» — {{Vitality}} <b>Vitality</b> едут на мейджор только за трофеем.

🤔 Верите, что Пчёлы заберут кубок?
```

## 5. Публикация
```bash
cat > out/post.html <<'EOF'
...текст...
EOF
python3 tg.py photo out/<slug>/match.png --file out/post.html --key match-<slug>
python3 tg.py album out/<slug>/match.png out/<slug>/player.png --file out/post.html --key match-<slug>
python3 tg.py text --file out/post.html --key news-<коротко-о-теме>-<YYYYMMDD>
python3 tg.py poll --question "Кто возьмёт BLAST Rivals?" -o "{{Falcons}} Falcons" -o "{{FURIA}} FURIA" --key poll-<тема>
python3 tg.py poll --question "..." -o ... --quiz 2 --explanation "..." --key quiz-<тема>
```
Ключ `--key` уникален для события: tg.py сам откажется публиковать повтор. Перед новостью проверь `state/posted.json` — не было ли уже поста на эту тему под другим ключом.
Опрос: 2–6 вариантов, вопрос ≤ 300 символов, вариант ≤ 100.

## 6. Сохранить состояние
```bash
git add state/posted.json emoji.json && git commit -qm "posts: $(TZ=Europe/Moscow date +%F_%H:%M)" && git push -q
```
Если push не прошёл — `git pull --rebase` и повтори (до 3 раз).

## 7. Отчёт
Коротко: что опубликовано (ссылки t.me), что пропущено и почему.
