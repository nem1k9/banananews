let token = "",
  state,
  tab = "dashboard";
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (x) =>
  x ? new Date(x).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" }) : "—";
const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
const empty = (t) => `<div class="empty">${t}</div>`;
let urls = [];
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}
async function load() {
  try {
    state = await api("state");
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#mode").textContent = state.mode.toUpperCase();
    render();
  } catch (e) {
    $("#notice").textContent = e.message;
    throw e;
  }
}
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  token = $("#token").value;
  try {
    await load();
    $("#token").value = "";
  } catch {
    $("#login-error").textContent =
      "Проверьте ключ доступа и доступность сервера.";
    token = "";
  }
};
$("#logout").onclick = () => {
  token = "";
  state = null;
  $("#app").hidden = true;
  $("#login").hidden = false;
  urls.forEach(URL.revokeObjectURL);
};
$("#refresh").onclick = () => load().catch(() => {});
document.querySelectorAll("nav button").forEach(
  (b) =>
    (b.onclick = () => {
      tab = b.dataset.tab;
      document
        .querySelectorAll("nav button")
        .forEach((x) => x.classList.toggle("active", x === b));
      render();
    }),
);
const titles = {
  dashboard: ["Рабочий пульс", "События, доставка и состояние редакции."],
  matches: [
    "Live Matches",
    "Подготовка заранее. Публикация по подтверждённому результату.",
  ],
  posts: ["Публикации", "История доставки и задержка обработки."],
  sources: ["Источники", "Официальные каналы и состояние подключения."],
  settings: ["Настройки", "Управление редакцией и тестирование доставки."],
};
function postRow(p) {
  return `<div class="row"><div><strong>${esc(p.caption.replace(/<[^>]*>/g, "").split("\n")[0])}</strong><p>${date(p.created_at)} · ${esc(p.category)}</p></div>${pill(p.status)}</div>`;
}
function render() {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  $("#heading").textContent = titles[tab][0];
  $("#subheading").textContent = titles[tab][1];
  $("#breadcrumb").textContent = tab.toUpperCase();
  const { posts, matches, sources, errors } = state;
  let out = "";
  if (tab === "dashboard") {
    const published = posts.filter((p) => p.status === "published");
    const lat = published.filter((p) => p.processing_ms != null);
    const avg = lat.length
      ? (
          lat.reduce((s, p) => s + p.processing_ms, 0) /
          lat.length /
          1000
        ).toFixed(1) + " с"
      : "—";
    out = `<div class="stats">${[
      ["Публикации", published.length, "Последние 100 событий"],
      [
        "Live-матчи",
        matches.filter((m) => ["started", "map_finished"].includes(m.status))
          .length,
        "Активное наблюдение",
      ],
      ["Обработка", avg, "От получения до отправки"],
      [
        "Источники",
        sources.filter((s) => s.status === "ok").length + "/" + sources.length,
        "Успешная проверка",
      ],
    ]
      .map(
        ([a, b, c]) =>
          `<div class="stat"><small>${a}</small><strong>${b}</strong><span>${c}</span></div>`,
      )
      .join(
        "",
      )}</div><div class="grid"><div class="panel"><h2>Лента редакции</h2>${posts.slice(0, 6).map(postRow).join("") || empty("Событий пока нет.<br>Симулируйте матч во вкладке Live Matches.")}</div><div><div class="panel"><h2>Состояние системы</h2><div class="row">Режим ${pill(state.mode)}</div><div class="row">Автопостинг ${pill(state.settings.autopost ? "enabled" : "paused")}</div><div class="row">Live-провайдер ${pill(state.provider)}</div><div class="row">Codex runner ${pill(state.codex ? "configured" : "offline")}</div></div><div class="panel"><h2>Последние ошибки</h2>${
      errors
        .slice(0, 4)
        .map(
          (e) =>
            `<div class="row"><div>${esc(e.code)}<p>${esc(e.component)} · ${date(e.created_at)}</p></div></div>`,
        )
        .join("") || empty("Ошибок не зарегистрировано.")
    }</div></div></div>`;
  }
  if (tab === "matches") {
    out =
      `<div class="actions"><button id="start">Начать NAVI × Vitality</button><button id="finish" class="secondary">NAVI побеждает 2:1</button></div><p>Демонстрационные данные. Повторное завершение проверяет защиту от дублей.</p>` +
      matches
        .map((m) => {
          const d = JSON.parse(m.payload);
          return `<div class="panel"><small>${esc(d.tournament)}</small><h2>${esc(d.teams.map((t) => t.name).join(" × "))}</h2><div class="match-score">${d.score.join(" : ")}</div><div class="row">${pill(m.status)}<span>BO${d.bo}</span></div><p>Подготовлены варианты: ${
            Object.keys(JSON.parse(m.prepared || "{}"))
              .map(esc)
              .join(", ") || "нет"
          }</p></div>`;
        })
        .join("");
  }
  if (tab === "posts")
    out =
      posts
        .map(
          (p) =>
            `<div class="panel">${postRow(p)}<div class="caption">${esc(p.caption)}</div><p>Окончание: ${date(p.occurred_at)}<br>Получено: ${date(p.received_at)}<br>Отправлено: ${date(p.sent_at)}<br>Обнаружение: ${p.detection_ms == null ? "неизвестно" : p.detection_ms + " мс"} · Обработка: ${p.processing_ms == null ? "—" : p.processing_ms + " мс"}</p>${p.telegram_url ? `<a href="${esc(p.telegram_url)}" target="_blank" rel="noopener noreferrer">Открыть в Telegram ↗</a>` : ""}<div><button class="secondary image" data-id="${esc(p.id)}">Показать PNG</button></div><div id="img-${esc(p.id)}"></div></div>`,
        )
        .join("") || empty("Публикаций пока нет.");
  if (tab === "sources")
    out =
      `<div class="actions"><button id="scan">Проверить сейчас</button></div>` +
      sources
        .map(
          (s) =>
            `<div class="panel"><div class="row"><div><h3>${esc(s.name)}</h3><p>${esc(s.url)}</p></div>${pill(s.status)}</div><p>Последняя проверка: ${date(s.last_checked)} · Ошибок подряд: ${s.failures}</p><button class="secondary toggle" data-id="${esc(s.id)}" data-enabled="${s.enabled ? "0" : "1"}">${s.enabled ? "Отключить" : "Включить"}</button></div>`,
        )
        .join("");
  if (tab === "settings")
    out = `<form id="settings-form" class="panel form-grid"><h2>Редакционная политика</h2><label class="checkbox"><input id="autopost" type="checkbox" ${state.settings.autopost ? "checked" : ""}> Автоматическая обработка публикаций</label><p>В dry-run отправка в Telegram невозможна. Режим доставки меняется только при развёртывании.</p><label>Интервал live-polling, секунды<input id="poll" type="number" min="5" max="3600" value="${state.settings.poll_seconds}"></label><div>${["TRANSFER", "MATCH_RESULT", "ROSTER", "UPDATE", "GENERAL_NEWS"].map((c) => `<label class="checkbox"><input name="category" value="${c}" type="checkbox" ${JSON.parse(state.settings.categories).includes(c) ? "checked" : ""}> ${c}</label><br>`).join("")}</div><label>Оформление<select id="design"><option value="default" ${state.settings.template === "default" ? "selected" : ""}>Цвет категории</option><option value="violet" ${state.settings.template === "violet" ? "selected" : ""}>Фирменный фиолетовый</option></select></label><p>Фон, размеры и слои: templates/default.json.</p><button>Сохранить</button></form><div class="panel"><h2>Тестовая доставка</h2><p>В режиме test отправка разрешена только в явно указанный тестовый канал. В production эта кнопка заблокирована.</p><button id="test" class="secondary">Создать тестовый пост</button></div>`;
  if (tab === "dashboard")
    out += `<div class="panel"><h2>Входящие новости</h2>${
      (state.articles || [])
        .slice(0, 8)
        .map(
          (a) =>
            `<div class="row"><div><strong>${esc(a.title)}</strong><p>${date(a.published_at)} · ${esc(a.category)}</p></div>${pill(a.status)}</div>`,
        )
        .join("") ||
      empty(
        "Новые подтверждённые материалы появятся после проверки источников.",
      )
    }</div>`;
  $("#content").innerHTML = out;
  bind();
}
function action(selector, fn) {
  const b = $(selector);
  if (b)
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
        await load();
        $("#notice").textContent = "Готово";
      } catch (e) {
        $("#notice").textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
}
function bind() {
  action("#start", () => api("demo", { type: "started" }));
  action("#finish", () => api("demo", { type: "finished" }));
  action("#scan", () => api("scan", {}));
  action("#test", () => api("test-post", {}));
  document.querySelectorAll(".toggle").forEach(
    (b) =>
      (b.onclick = () =>
        api("sources/toggle", {
          id: b.dataset.id,
          enabled: b.dataset.enabled === "1",
        })
          .then(load)
          .catch((e) => ($("#notice").textContent = e.message))),
  );
  document.querySelectorAll(".image").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const r = await fetch("/api/posts/" + b.dataset.id + "/image", {
            headers: { Authorization: "Bearer " + token },
          });
          if (!r.ok) throw new Error("PNG недоступен");
          const url = URL.createObjectURL(await r.blob());
          urls.push(url);
          const img = new Image();
          img.className = "post-image";
          img.alt = "Карточка публикации";
          img.src = url;
          $("#img-" + b.dataset.id).replaceChildren(img);
        } catch (e) {
          $("#notice").textContent = e.message;
        }
      }),
  );
  const f = $("#settings-form");
  if (f)
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("settings", {
          autopost: $("#autopost").checked,
          poll_seconds: Number($("#poll").value),
          template: $("#design").value,
          categories: [
            ...document.querySelectorAll("[name=category]:checked"),
          ].map((x) => x.value),
        });
        await load();
        $("#notice").textContent = "Настройки сохранены";
      } catch (e) {
        $("#notice").textContent = e.message;
      }
    };
}
