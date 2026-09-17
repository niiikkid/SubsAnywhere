"use strict";

(() => {
  const list = document.getElementById("word-list");
  const search = document.getElementById("search");
  const language = document.getElementById("language");
  const count = document.getElementById("count");
  const status = document.getElementById("status");
  const empty = document.getElementById("empty");
  const refresh = document.getElementById("refresh");
  const reviewTab = document.getElementById("review-tab");
  const learnedTab = document.getElementById("learned-tab");
  const listTitle = document.getElementById("list-title");
  let words = [];
  let loaded = false;
  let busy = false;
  let view = "review";

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
      || typeof word.learned !== "boolean"
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
    const inView = words.filter(word => word.learned === (view === "learned"));
    const visible = inView.filter(word => (!language.value || word.language === language.value)
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
      const learned = element("button", "learned", word.learned ? "Вернуть на повторение" : "Выучено ✓");
      learned.type = "button";
      learned.disabled = busy;
      learned.title = word.learned ? "Вернуть слово в список на повторение" : "Отметить слово как выученное";
      learned.setAttribute("aria-label", `${learned.title}: «${word.text}»`);
      learned.addEventListener("click", () => setLearned(word, !word.learned));
      row.append(main, element("p", "word-translation", word.translation), learned);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    list.setAttribute("aria-busy", String(busy));
    refresh.disabled = busy;
    reviewTab.setAttribute("aria-selected", String(view === "review"));
    learnedTab.setAttribute("aria-selected", String(view === "learned"));
    listTitle.textContent = view === "learned" ? "Выученные" : "На повторение";
    list.setAttribute("aria-label", listTitle.textContent);
    count.textContent = loaded ? `${visible.length} из ${inView.length}` : "—";
    empty.hidden = !loaded || visible.length > 0;
    empty.textContent = inView.length
      ? "Ничего не найдено. Попробуйте другой запрос или язык."
      : (view === "learned" ? "Пока нет выученных слов. Отмечайте их в списке «На повторение»."
        : "Пока здесь пусто. Сохраните первое слово из подсказки в субтитрах расширения.");
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

  async function setLearned(word, learned) {
    if (busy) return;
    busy = true;
    message(learned ? "Отмечаем слово как выученное…" : "Возвращаем слово на повторение…");
    render();
    try {
      const result = await request("/api/words/learned", { id: word.id, learned });
      if (result?.word?.id !== word.id || result.word.learned !== learned) {
        throw new Error("Сервер не подтвердил отметку слова. Обновите список.");
      }
      const fresh = await readWords();
      if (fresh.find(item => item.id === word.id)?.learned !== learned) {
        throw new Error("Состояние слова не сохранилось. Обновите список.");
      }
      words = fresh;
      message(learned ? `«${word.text}» перенесено в выученные.` : `«${word.text}» возвращено на повторение.`);
      search.focus();
    } catch {
      message("Не удалось подтвердить состояние слова. Обновите список, чтобы проверить его.", true);
    } finally {
      busy = false;
      render();
    }
  }

  search.addEventListener("input", render);
  language.addEventListener("change", render);
  reviewTab.addEventListener("click", () => { view = "review"; render(); });
  learnedTab.addEventListener("click", () => { view = "learned"; render(); });
  refresh.addEventListener("click", load);
  window.addEventListener("focus", load);
  load();
})();
