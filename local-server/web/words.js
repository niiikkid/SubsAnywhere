"use strict";

(() => {
  const list = document.getElementById("word-list");
  const search = document.getElementById("search");
  const language = document.getElementById("language");
  const count = document.getElementById("count");
  const status = document.getElementById("status");
  const empty = document.getElementById("empty");
  const refresh = document.getElementById("refresh");
  let words = [];
  let loaded = false;
  let busy = false;

  function searchable(value) {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
  }

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  async function request(path, payload) {
    const response = await fetch(path, {
      method: payload === undefined ? "GET" : "POST",
      headers: { "X-SubsAnywhere-Client": "extension-v1", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("Не удалось получить подтверждение сервера. Обновите список и попробуйте ещё раз.");
    return response.json();
  }

  async function readWords() {
    const data = await request("/api/words");
    if (!data || !Array.isArray(data.words) || data.words.some(word => (
      !word || !Number.isSafeInteger(word.id) || word.id < 1 || !["zh", "en"].includes(word.language)
      || !["text", "pinyin", "translation", "created_at"].every(key => typeof word[key] === "string")
    ))) throw new Error("Сервер вернул неверный формат словаря. Обновите сервер и повторите попытку.");
    return data.words;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function render() {
    const query = searchable(search.value);
    const visible = words.filter(word => (!language.value || word.language === language.value)
      && (!query || [word.text, word.pinyin, word.translation].some(value => searchable(value).includes(query))));
    const fragment = document.createDocumentFragment();
    for (const word of visible) {
      const row = element("li", "word-row", "");
      const main = element("div", "word-main", "");
      const text = element("h3", "word-text", word.text);
      text.lang = word.language;
      main.append(text);
      if (word.pinyin) {
        const pinyin = element("p", "word-pinyin", word.pinyin);
        pinyin.lang = "zh-Latn";
        main.append(pinyin);
      }
      const remove = element("button", "learned", "Выучено ✓");
      remove.type = "button";
      remove.disabled = busy;
      remove.title = "Удалить выученное слово из словаря";
      remove.setAttribute("aria-label", `Выучено: удалить «${word.text}» из словаря`);
      remove.addEventListener("click", () => removeWord(word));
      row.append(main, element("p", "word-translation", word.translation), remove);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    list.setAttribute("aria-busy", String(busy));
    refresh.disabled = busy;
    count.textContent = loaded ? `${visible.length} из ${words.length}` : "—";
    empty.hidden = !loaded || visible.length > 0;
    empty.textContent = words.length
      ? "Ничего не найдено. Попробуйте другой запрос или язык."
      : "Пока здесь пусто. Сохраните первое слово из подсказки в субтитрах расширения.";
  }

  async function load() {
    if (busy) return;
    busy = true;
    message("Обновление словаря…");
    render();
    try {
      words = await readWords();
      loaded = true;
      message("");
    } catch (error) {
      message(error instanceof TypeError || error.name === "TimeoutError"
        ? "Сервер недоступен. Проверьте локальный сервер и нажмите «Обновить список»."
        : error.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  async function removeWord(word) {
    if (busy) return;
    busy = true;
    message("Удаление выученного слова…");
    render();
    try {
      const result = await request("/api/words/remove", { id: word.id });
      if (result?.removed !== true) throw new Error("Сервер не подтвердил удаление. Обновите список.");
      const fresh = await readWords();
      if (fresh.some(item => item.id === word.id)) throw new Error("Слово осталось на сервере. Повторите попытку.");
      words = fresh;
      message(`«${word.text}» удалено из словаря.`);
      search.focus();
    } catch {
      message("Не удалось подтвердить удаление. Обновите список, чтобы проверить состояние слова.", true);
    } finally {
      busy = false;
      render();
    }
  }

  search.addEventListener("input", render);
  language.addEventListener("change", render);
  refresh.addEventListener("click", load);
  window.addEventListener("focus", load);
  load();
})();
