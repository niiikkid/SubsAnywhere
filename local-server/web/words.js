"use strict";

export function studyDeck(words = []) {
  return words.filter((word) => word && word.learned === false);
}

export function nextStudyPosition(position, total) {
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : 0;
  const safePosition = Number.isSafeInteger(position) ? Math.min(Math.max(position, 0), safeTotal) : 0;
  return Math.min(safePosition + 1, safeTotal);
}

if (typeof document !== "undefined") (() => {
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
  const listControls = document.getElementById("list-controls");
  const wordPanel = document.getElementById("word-panel");
  const studyStart = document.getElementById("study-start");
  const studyMode = document.getElementById("study-mode");
  const studyExit = document.getElementById("study-exit");
  const studyProgress = document.getElementById("study-progress");
  const studyCard = document.getElementById("study-card");
  const studyLanguage = document.getElementById("study-language");
  const studyWord = document.getElementById("study-word");
  const studyPinyin = document.getElementById("study-pinyin");
  const studyTranslation = document.getElementById("study-translation");
  const studyExplanation = document.getElementById("study-explanation");
  const studyExplanationText = document.getElementById("study-explanation-text");
  const studyFinish = document.getElementById("study-finish");
  const studyExplain = document.getElementById("study-explain");
  const studyNext = document.getElementById("study-next");
  const studyRestart = document.getElementById("study-restart");
  let words = [];
  let loaded = false;
  let busy = false;
  let view = "review";
  let studyWords = [];
  let studyPosition = 0;
  let studyExplanationOpen = false;

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
      || !["text", "pinyin", "translation", "created_at", "explanation"].every(key => typeof word[key] === "string")
      || word.explanation.length > 1200
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
      const translation = element("div", "word-translation", "");
      translation.append(element("p", "", word.translation));
      let details;
      if (word.explanation) {
        details = element("details", "word-explanation", "");
        details.append(element("summary", "", "Короткое объяснение"), element("p", "", word.explanation));
        translation.append(details);
      }
      const explain = element("button", "explain", word.explanation ? "Объяснение" : "Объяснить");
      explain.type = "button";
      explain.disabled = busy;
      explain.addEventListener("click", () => word.explanation ? details.toggleAttribute("open") : explainWord(word));
      const actions = element("div", "word-actions", "");
      actions.append(explain, learned);
      row.append(main, translation, actions);
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
    const availableForStudy = studyDeck(words).length;
    studyStart.hidden = view !== "review";
    studyStart.disabled = busy || availableForStudy === 0;
    studyStart.textContent = `Повторять (${availableForStudy})`;
    empty.hidden = !loaded || visible.length > 0;
    empty.textContent = inView.length
      ? "Ничего не найдено. Попробуйте другой запрос или язык."
      : (view === "learned" ? "Пока нет выученных слов. Отмечайте их в списке «На повторение»."
        : "Пока здесь пусто. Сохраните первое слово из подсказки в субтитрах расширения.");
  }

  function renderStudy() {
    const total = studyWords.length;
    const complete = studyPosition >= total;
    studyProgress.textContent = complete ? `Повторено: ${total} из ${total}` : `${studyPosition + 1} из ${total}`;
    studyCard.hidden = complete;
    studyFinish.hidden = !complete;
    studyNext.hidden = complete;
    studyExplain.hidden = complete;
    studyRestart.hidden = !complete;
    if (complete) return;
    const word = studyWords[studyPosition];
    studyLanguage.textContent = word.language === "zh" ? "Китайский" : "Английский";
    studyWord.textContent = word.text;
    studyWord.lang = word.language;
    studyPinyin.textContent = word.pinyin;
    studyPinyin.lang = "zh-Latn";
    studyPinyin.hidden = !word.pinyin;
    studyTranslation.textContent = word.translation;
    studyExplain.disabled = busy;
    studyExplain.textContent = word.explanation ? "Показать объяснение" : "Объяснить";
    studyExplanation.hidden = !word.explanation || !studyExplanationOpen;
    studyExplanationText.textContent = word.explanation || "";
  }

  function startStudy() {
    studyWords = studyDeck(words);
    if (!studyWords.length) return;
    studyPosition = 0;
    studyExplanationOpen = false;
    listControls.hidden = true;
    wordPanel.hidden = true;
    studyMode.hidden = false;
    renderStudy();
    studyWord.focus();
  }

  function exitStudy() {
    studyMode.hidden = true;
    listControls.hidden = false;
    wordPanel.hidden = false;
    render();
    studyStart.focus();
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

  function requestExplanation(id) {
    const requestId = crypto.randomUUID().replace(/-/gu, "");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Расширение не ответило. Перезагрузите его на странице chrome://extensions.")), 45000);
      function receive(event) {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || !data || data.type !== "subsanywhere.words.explain.result" || data.requestId !== requestId) return;
        finish(data.ok ? data.word : new Error(data.error || "Не удалось получить объяснение"));
      }
      function finish(result) {
        clearTimeout(timeout);
        window.removeEventListener("message", receive);
        result instanceof Error ? reject(result) : resolve(result);
      }
      window.addEventListener("message", receive);
      window.postMessage({ type: "subsanywhere.words.explain", requestId, id }, location.origin);
    });
  }

  async function explainWord(word) {
    if (busy) return;
    busy = true;
    message("ИИ готовит короткое объяснение…");
    render();
    renderStudy();
    try {
      const fresh = await requestExplanation(word.id);
      if (!fresh || fresh.id !== word.id || typeof fresh.explanation !== "string" || !fresh.explanation) {
        throw new Error("Расширение не подтвердило объяснение слова.");
      }
      words = words.map(item => item.id === fresh.id ? fresh : item);
      studyWords = studyWords.map(item => item.id === fresh.id ? fresh : item);
      studyExplanationOpen = true;
      message(`Объяснение для «${word.text}» сохранено.`);
    } catch (error) {
      message(error instanceof Error ? error.message : "Не удалось получить объяснение.", true);
    } finally {
      busy = false;
      render();
      renderStudy();
    }
  }

  search.addEventListener("input", render);
  language.addEventListener("change", render);
  reviewTab.addEventListener("click", () => { view = "review"; render(); });
  learnedTab.addEventListener("click", () => { view = "learned"; render(); });
  refresh.addEventListener("click", load);
  studyStart.addEventListener("click", startStudy);
  studyExit.addEventListener("click", exitStudy);
  studyNext.addEventListener("click", () => {
    studyPosition = nextStudyPosition(studyPosition, studyWords.length);
    studyExplanationOpen = false;
    renderStudy();
    (studyPosition >= studyWords.length ? studyRestart : studyWord).focus();
  });
  studyRestart.addEventListener("click", () => {
    studyPosition = 0;
    studyExplanationOpen = false;
    renderStudy();
    studyWord.focus();
  });
  studyExplain.addEventListener("click", () => {
    const word = studyWords[studyPosition];
    if (!word) return;
    if (word.explanation) {
      studyExplanationOpen = !studyExplanationOpen;
      renderStudy();
      return;
    }
    explainWord(word);
  });
  window.addEventListener("focus", load);
  load();
})();
