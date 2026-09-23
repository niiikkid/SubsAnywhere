"use strict";

export function studyDeck(words = []) {
  return words.filter((word) => word && word.learned === false);
}

export function nextStudyPosition(position, total) {
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : 0;
  const safePosition = Number.isSafeInteger(position) ? Math.min(Math.max(position, 0), safeTotal) : 0;
  return Math.min(safePosition + 1, safeTotal);
}

export function previousStudyPosition(position, total) {
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : 0;
  const safePosition = Number.isSafeInteger(position) ? Math.min(Math.max(position, 0), safeTotal) : 0;
  return Math.max(safePosition - 1, 0);
}

export function studyPositionForWord(words = [], id) {
  if (!Number.isSafeInteger(id) || id < 1) return -1;
  return studyDeck(words).findIndex((word) => word.id === id);
}

export function learningText(item, kind = "words") {
  if (!item || typeof item.text !== "string") return "";
  return kind === "sentences" && item.language === "zh" && typeof item.pinyin === "string"
    ? item.pinyin : item.text;
}

export function wordsTsv(words = []) {
  const cell = (value) => {
    const text = String(value ?? "").replace(/[\t\r\n]/gu, " ");
    return /^[=+\-@]/u.test(text) ? `'${text}` : text;
  };
  return ["word\tpinyin\ttranslation", ...words.map(word => [
    cell(word?.text), cell(word?.language === "zh" ? word.pinyin : ""), cell(word?.translation),
  ].join("\t"))].join("\n") + "\n";
}

if (typeof document !== "undefined") (() => {
  const STUDY_STORAGE_KEYS = {
    words: "subsanywhere.words.study.v1",
    sentences: "subsanywhere.sentences.study.v1"
  };
  const list = document.getElementById("word-list");
  const search = document.getElementById("search");
  const language = document.getElementById("language");
  const count = document.getElementById("count");
  const status = document.getElementById("status");
  const empty = document.getElementById("empty");
  const refresh = document.getElementById("refresh");
  const download = document.getElementById("download");
  const deleteModal = document.getElementById("delete-modal");
  const deleteTitle = document.getElementById("delete-title");
  const deleteText = document.getElementById("delete-text");
  const deleteCancel = document.getElementById("delete-cancel");
  const deleteConfirm = document.getElementById("delete-confirm");
  const entityTabs = document.getElementById("entity-tabs");
  const wordsTab = document.getElementById("words-tab");
  const sentencesTab = document.getElementById("sentences-tab");
  const reviewTab = document.getElementById("review-tab");
  const learnedTab = document.getElementById("learned-tab");
  const listTitle = document.getElementById("list-title");
  const listControls = document.getElementById("list-controls");
  const wordPanel = document.getElementById("word-panel");
  const studyStart = document.getElementById("study-start");
  const studyMode = document.getElementById("study-mode");
  const studyTitle = document.getElementById("study-title");
  const studyExit = document.getElementById("study-exit");
  const studyProgress = document.getElementById("study-progress");
  const studyCard = document.getElementById("study-card");
  const studyLanguage = document.getElementById("study-language");
  const studyWord = document.getElementById("study-word");
  const studyPinyin = document.getElementById("study-pinyin");
  const studyTranslation = document.getElementById("study-translation");
  const studyAiTranslations = document.getElementById("study-ai-translations");
  const studyAiTranslationsList = document.getElementById("study-ai-translations-list");
  const studyExplanation = document.getElementById("study-explanation");
  const studyExplanationText = document.getElementById("study-explanation-text");
  const studyFinish = document.getElementById("study-finish");
  const studyFinishTitle = document.getElementById("study-finish-title");
  const studyBack = document.getElementById("study-back");
  const studyLearned = document.getElementById("study-learned");
  const studyExplain = document.getElementById("study-explain");
  const studyTranslate = document.getElementById("study-translate");
  const studyDelete = document.getElementById("study-delete");
  const studyNext = document.getElementById("study-next");
  const studyRestart = document.getElementById("study-restart");
  let words = [];
  let sentences = [];
  let loaded = false;
  let busy = false;
  let view = "review";
  let kind = "words";
  let studyWords = [];
  let studyPosition = 0;
  let studyExplanationOpen = false;
  let deleteTarget = null;
  let deleteTrigger = null;

  const currentItems = () => kind === "sentences" ? sentences : words;
  const noun = (form) => kind === "sentences"
    ? ({ one: "предложение", many: "предложения", genitive: "предложений" })[form]
    : ({ one: "слово", many: "слова", genitive: "слов" })[form];

  function searchable(value) {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
  }

  function validAiTranslations(value) {
    return Array.isArray(value) && value.length <= 3 && value.every(item => item && typeof item === "object"
      && Object.keys(item).length === 2 && typeof item.translation === "string" && item.translation.length > 0
      && item.translation.length <= 320 && typeof item.usage === "string" && item.usage.length > 0
      && item.usage.length <= 240);
  }

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  function savedStudy() {
    try {
      const value = JSON.parse(localStorage.getItem(STUDY_STORAGE_KEYS[kind]));
      if (!value || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 10000
        || !value.ids.every(id => Number.isSafeInteger(id) && id > 0)
        || !Number.isSafeInteger(value.position) || value.position < 0 || value.position > value.ids.length) return null;
      return value;
    } catch {
      return null;
    }
  }

  function persistStudy() {
    if (!studyWords.length) return;
    try {
      localStorage.setItem(STUDY_STORAGE_KEYS[kind], JSON.stringify({ ids: studyWords.map(word => word.id), position: studyPosition }));
    } catch { /* Browser storage can be unavailable; the study itself still works. */ }
  }

  function clearSavedStudy(type = kind) {
    try { localStorage.removeItem(STUDY_STORAGE_KEYS[type]); } catch { /* Ignore unavailable browser storage. */ }
  }

  function showStudy() {
    entityTabs.hidden = true;
    listControls.hidden = true;
    wordPanel.hidden = true;
    studyMode.hidden = false;
    renderStudy();
  }

  function restoreStudy() {
    const saved = savedStudy();
    if (!saved || !studyMode.hidden) return;
    const byId = new Map(currentItems().map(item => [item.id, item]));
    const restored = saved.ids.map(id => byId.get(id)).filter(Boolean);
    if (restored.length !== saved.ids.length) {
      clearSavedStudy();
      return;
    }
    studyWords = restored;
    studyPosition = Math.min(saved.position, studyWords.length);
    studyExplanationOpen = false;
    showStudy();
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

  async function readItems(type) {
    const key = type === "sentences" ? "sentences" : "words";
    const data = await request(`/api/${key}`);
    if (!data || !Array.isArray(data[key]) || data[key].some(item => (
      !item || !Number.isSafeInteger(item.id) || item.id < 1 || !["zh", "en"].includes(item.language)
      || !["text", "pinyin", "translation", "created_at", "explanation"].every(field => typeof item[field] === "string")
      || item.explanation.length > 1200
      || (type === "words" && !validAiTranslations(item.ai_translations))
      || typeof item.learned !== "boolean"
    ))) throw new Error("Сервер вернул неверный формат списка. Обновите сервер и повторите попытку.");
    return data[key];
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function downloadWords() {
    const href = URL.createObjectURL(new Blob([wordsTsv(words)], { type: "text/tab-separated-values;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = "subsanywhere-words.tsv";
    link.click();
    URL.revokeObjectURL(href);
  }

  function openDeleteDialog(word, trigger) {
    if (busy) return;
    const targetKind = kind;
    const label = targetKind === "sentences" ? "предложение" : "слово";
    deleteTarget = { word, kind: targetKind };
    deleteTrigger = trigger;
    deleteTitle.textContent = `Удалить ${label}?`;
    deleteText.textContent = `«${learningText(word, targetKind)}» будет удалено из словаря без возможности восстановления.`;
    deleteCancel.disabled = false;
    deleteConfirm.disabled = false;
    listControls.inert = true;
    wordPanel.inert = true;
    studyMode.inert = true;
    deleteModal.hidden = false;
    deleteConfirm.focus();
  }

  function closeDeleteDialog({ restoreFocus = true } = {}) {
    if (busy) return;
    deleteModal.hidden = true;
    listControls.inert = false;
    wordPanel.inert = false;
    studyMode.inert = false;
    deleteTarget = null;
    const trigger = deleteTrigger;
    deleteTrigger = null;
    if (restoreFocus) trigger?.focus();
  }

  function render() {
    const query = searchable(search.value);
    const inView = currentItems().filter(word => word.learned === (view === "learned"));
    const visible = inView.filter(word => (!language.value || word.language === language.value)
      && (!query || [word.text, word.pinyin, word.translation, ...((word.ai_translations || []).flatMap(item => [item.translation, item.usage]))]
        .some(value => searchable(value).includes(query))));
    const fragment = document.createDocumentFragment();
    for (const word of visible) {
      const row = element("li", "word-row", "");
      const main = element("div", "word-main", "");
      const text = element("h3", `word-text${kind === "sentences" ? " sentence-text" : ""}`, learningText(word, kind));
      text.lang = kind === "sentences" && word.language === "zh" ? "zh-Latn" : word.language;
      main.append(text);
      if (kind === "words" && word.pinyin) {
        const pinyin = element("p", "word-pinyin", word.pinyin);
        pinyin.lang = "zh-Latn";
        main.append(pinyin);
      }
      const learned = element("button", "learned", word.learned ? "Вернуть на повторение" : "Выучено ✓");
      learned.type = "button";
      learned.disabled = busy;
      learned.title = word.learned ? `Вернуть ${noun("one")} в список на повторение` : `Отметить ${noun("one")} как выученное`;
      learned.setAttribute("aria-label", `${learned.title}: «${learningText(word, kind)}»`);
      learned.addEventListener("click", () => setLearned(word, !word.learned));
      const remove = element("button", "delete", "Удалить");
      remove.type = "button";
      remove.disabled = busy;
      remove.setAttribute("aria-label", `Удалить ${noun("one")}: «${learningText(word, kind)}»`);
      remove.addEventListener("click", () => openDeleteDialog(word, remove));
      const translation = element("div", "word-translation", "");
      translation.append(element("p", "", word.translation));
      if (kind === "words" && word.ai_translations.length) {
        const aiTranslations = element("section", "ai-translations", "");
        aiTranslations.append(element("h4", "", "Перевод ИИ"));
        const alternatives = element("ol", "", "");
        for (const item of word.ai_translations) {
          const alternative = element("li", "", "");
          alternative.append(element("strong", "", item.translation), element("span", "", item.usage));
          alternatives.append(alternative);
        }
        aiTranslations.append(alternatives);
        translation.append(aiTranslations);
      }
      let details;
      if (word.explanation) {
        details = element("details", "word-explanation", "");
        details.append(element("summary", "", kind === "sentences" ? "Разбор грамматики" : "Короткое объяснение"), element("p", "", word.explanation));
        translation.append(details);
      }
      const explain = element("button", "explain", word.explanation
        ? (kind === "sentences" ? "Разбор" : "Объяснение")
        : (kind === "sentences" ? "Разобрать" : "Объяснить"));
      explain.type = "button";
      explain.disabled = busy;
      explain.addEventListener("click", () => word.explanation ? details.toggleAttribute("open") : explainWord(word));
      const actions = element("div", "word-actions", "");
      if (kind === "words" && word.language === "zh") {
        const translate = element("button", "ai-translate", word.ai_translations.length ? "Получить заново" : "Получить перевод");
        translate.type = "button";
        translate.disabled = busy;
        translate.addEventListener("click", () => translateWord(word));
        actions.append(translate);
      }
      actions.append(explain, learned, remove);
      row.append(main, translation, actions);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    list.setAttribute("aria-busy", String(busy));
    refresh.disabled = busy;
    download.disabled = busy || !loaded;
    wordsTab.disabled = busy;
    sentencesTab.disabled = busy;
    reviewTab.setAttribute("aria-selected", String(view === "review"));
    learnedTab.setAttribute("aria-selected", String(view === "learned"));
    wordsTab.setAttribute("aria-selected", String(kind === "words"));
    sentencesTab.setAttribute("aria-selected", String(kind === "sentences"));
    search.placeholder = kind === "sentences" ? "Поиск по пиньиню или переводу" : "Поиск по слову, пиньиню или переводу";
    search.setAttribute("aria-label", search.placeholder);
    listTitle.textContent = view === "learned" ? "Выученные" : "На повторение";
    list.setAttribute("aria-label", `${listTitle.textContent}: ${kind === "sentences" ? "предложения" : "слова"}`);
    count.textContent = loaded ? `${visible.length} из ${inView.length}` : "—";
    const availableForStudy = studyDeck(currentItems()).length;
    studyStart.hidden = view !== "review";
    studyStart.disabled = busy || availableForStudy === 0;
    studyStart.textContent = `Повторять (${availableForStudy})`;
    empty.hidden = !loaded || visible.length > 0;
    empty.textContent = inView.length
      ? "Ничего не найдено. Попробуйте другой запрос или язык."
      : (view === "learned" ? `Пока нет выученных ${noun("genitive")}. Отмечайте их в списке «На повторение».`
        : `Пока здесь пусто. Сохраните первое ${noun("one")} из субтитров расширения.`);
  }

  function renderStudy() {
    const total = studyWords.length;
    const complete = studyPosition >= total;
    studyTitle.textContent = `Повторение ${noun("genitive")}`;
    studyFinishTitle.textContent = `Все ${noun("many")} повторены`;
    studyProgress.textContent = complete ? `Повторено: ${total} из ${total}` : `${studyPosition + 1} из ${total}`;
    studyCard.hidden = complete;
    studyFinish.hidden = !complete;
    studyBack.hidden = total === 0;
    studyBack.disabled = busy || studyPosition === 0;
    studyNext.hidden = complete;
    studyLearned.hidden = complete;
    studyExplain.hidden = complete;
    studyTranslate.hidden = true;
    studyDelete.hidden = complete;
    studyAiTranslations.hidden = true;
    studyAiTranslationsList.replaceChildren();
    studyRestart.hidden = !complete;
    if (complete) return;
    const word = studyWords[studyPosition];
    studyLanguage.textContent = word.language === "zh" ? "Китайский" : "Английский";
    studyWord.textContent = learningText(word, kind);
    studyWord.lang = kind === "sentences" && word.language === "zh" ? "zh-Latn" : word.language;
    studyPinyin.textContent = kind === "words" ? word.pinyin : "";
    studyPinyin.lang = "zh-Latn";
    studyPinyin.hidden = kind !== "words" || !word.pinyin;
    studyTranslation.textContent = word.translation;
    const chineseWord = kind === "words" && word.language === "zh";
    const aiTranslations = chineseWord ? word.ai_translations : [];
    studyTranslate.hidden = !chineseWord;
    studyTranslate.disabled = busy;
    studyTranslate.textContent = aiTranslations.length ? "Получить заново" : "Получить перевод";
    if (aiTranslations.length) {
      const alternatives = document.createDocumentFragment();
      for (const item of aiTranslations) {
        const alternative = element("li", "", "");
        alternative.append(element("strong", "", item.translation), element("span", "", item.usage));
        alternatives.append(alternative);
      }
      studyAiTranslationsList.replaceChildren(alternatives);
      studyAiTranslations.hidden = false;
    }
    studyLearned.disabled = busy;
    studyLearned.textContent = word.learned ? "Вернуть на повторение" : `${kind === "sentences" ? "Предложение" : "Слово"} выучено`;
    studyExplain.disabled = busy;
    studyExplain.textContent = word.explanation
      ? (kind === "sentences" ? "Показать разбор" : "Показать объяснение")
      : (kind === "sentences" ? "Разобрать" : "Объяснить");
    studyExplanation.hidden = !word.explanation || !studyExplanationOpen;
    studyExplanationText.textContent = word.explanation || "";
    studyDelete.disabled = busy;
    studyDelete.textContent = `Удалить ${noun("one")}`;
  }

  function startStudy() {
    studyWords = studyDeck(currentItems());
    if (!studyWords.length) return;
    studyPosition = 0;
    studyExplanationOpen = false;
    persistStudy();
    showStudy();
    studyWord.focus();
  }

  function exitStudy() {
    clearSavedStudy();
    studyWords = [];
    studyPosition = 0;
    studyMode.hidden = true;
    entityTabs.hidden = false;
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
      [words, sentences] = await Promise.all([readItems("words"), readItems("sentences")]);
      loaded = true;
      restoreStudy();
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

  async function setLearned(word, learned, preserveStudy = false) {
    if (busy) return;
    busy = true;
    message(learned ? `Отмечаем ${noun("one")} как выученное…` : `Возвращаем ${noun("one")} на повторение…`);
    render();
    try {
      const key = kind === "sentences" ? "sentence" : "word";
      const result = await request(`/api/${kind}/learned`, { id: word.id, learned });
      if (result?.[key]?.id !== word.id || result[key].learned !== learned) {
        throw new Error(`Сервер не подтвердил отметку ${noun("one")}. Обновите список.`);
      }
      const fresh = await readItems(kind);
      if (fresh.find(item => item.id === word.id)?.learned !== learned) {
        throw new Error(`Состояние ${noun("one")} не сохранилось. Обновите список.`);
      }
      if (kind === "sentences") sentences = fresh;
      else words = fresh;
      studyWords = studyWords.map(item => item.id === word.id ? fresh.find(candidate => candidate.id === word.id) : item);
      message(learned ? `«${learningText(word, kind)}» перенесено в выученные.` : `«${learningText(word, kind)}» возвращено на повторение.`);
      if (preserveStudy) persistStudy();
      else search.focus();
    } catch {
      message(`Не удалось подтвердить состояние ${noun("one")}. Обновите список, чтобы проверить его.`, true);
    } finally {
      busy = false;
      render();
      if (preserveStudy) renderStudy();
    }
  }

  async function removeItem() {
    const target = deleteTarget;
    if (!target || busy) return;
    const label = target.kind === "sentences" ? "Предложение" : "Слово";
    const deletedDuringStudy = !studyMode.hidden && target.kind === kind;
    busy = true;
    deleteCancel.disabled = true;
    deleteConfirm.disabled = true;
    message(`Удаляем ${target.kind === "sentences" ? "предложение" : "слово"}…`);
    render();
    let removed = false;
    try {
      const result = await request(`/api/${target.kind}/delete`, { id: target.word.id });
      if (result?.deleted !== true) throw new Error("Сервер не подтвердил удаление.");
      const fresh = await readItems(target.kind);
      if (fresh.some(item => item.id === target.word.id)) throw new Error("Словарь не подтвердил удаление.");
      if (target.kind === "sentences") sentences = fresh;
      else words = fresh;
      clearSavedStudy(target.kind);
      removed = true;
      message(`${label} «${learningText(target.word, target.kind)}» удалено.`);
    } catch (error) {
      message(error instanceof Error ? error.message : `Не удалось удалить ${target.kind === "sentences" ? "предложение" : "слово"}.`, true);
    } finally {
      busy = false;
      deleteCancel.disabled = false;
      deleteConfirm.disabled = false;
      if (removed) closeDeleteDialog({ restoreFocus: false });
      if (removed && deletedDuringStudy) {
        studyWords = [];
        studyPosition = 0;
        studyExplanationOpen = false;
        studyMode.hidden = true;
        entityTabs.hidden = false;
        listControls.hidden = false;
        wordPanel.hidden = false;
      }
      render();
      if (removed) search.focus();
    }
  }

  function requestPanelAction(id, action) {
    const requestKind = kind;
    const requestId = crypto.randomUUID().replace(/-/gu, "");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Расширение не ответило. Перезагрузите его на странице chrome://extensions.")), 45000);
      function receive(event) {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || !data || data.type !== `${action}.result` || data.requestId !== requestId) return;
        finish(data.ok ? (requestKind === "sentences" ? data.sentence : data.word) : new Error(data.error || "Не удалось получить ответ ИИ"));
      }
      function finish(result) {
        clearTimeout(timeout);
        window.removeEventListener("message", receive);
        result instanceof Error ? reject(result) : resolve(result);
      }
      window.addEventListener("message", receive);
      window.postMessage({ type: action, requestId, id, kind: requestKind }, location.origin);
    });
  }

  function requestExplanation(id) {
    return requestPanelAction(id, "subsanywhere.words.explain");
  }

  async function explainWord(word) {
    if (busy) return;
    const requestKind = kind;
    busy = true;
    message(kind === "sentences" ? "ИИ готовит короткий разбор грамматики…" : "ИИ готовит короткое объяснение…");
    render();
    renderStudy();
    try {
      const fresh = await requestExplanation(word.id);
      if (!fresh || fresh.id !== word.id || typeof fresh.explanation !== "string" || !fresh.explanation) {
        throw new Error(kind === "sentences" ? "Расширение не подтвердило разбор предложения." : "Расширение не подтвердило объяснение слова.");
      }
      if (requestKind === "sentences") sentences = sentences.map(item => item.id === fresh.id ? fresh : item);
      else words = words.map(item => item.id === fresh.id ? fresh : item);
      studyWords = studyWords.map(item => item.id === fresh.id ? fresh : item);
      studyExplanationOpen = true;
      message(`${kind === "sentences" ? "Разбор" : "Объяснение"} для «${learningText(word, kind)}» сохранён.`);
    } catch (error) {
      message(error instanceof Error ? error.message : "Не удалось получить объяснение.", true);
    } finally {
      busy = false;
      render();
      renderStudy();
    }
  }

  async function translateWord(word) {
    if (busy || kind !== "words" || word.language !== "zh") return;
    busy = true;
    message("ИИ подбирает варианты перевода…");
    render();
    try {
      const fresh = await requestPanelAction(word.id, "subsanywhere.words.translate");
      if (!fresh || fresh.id !== word.id || !validAiTranslations(fresh.ai_translations) || !fresh.ai_translations.length) {
        throw new Error("Расширение не подтвердило варианты перевода.");
      }
      words = words.map(item => item.id === fresh.id ? fresh : item);
      studyWords = studyWords.map(item => item.id === fresh.id ? fresh : item);
      message(`Переводы ИИ для «${word.text}» сохранены отдельно от перевода из видео.`);
    } catch (error) {
      message(error instanceof Error ? error.message : "Не удалось получить перевод.", true);
    } finally {
      busy = false;
      render();
      renderStudy();
    }
  }

  search.addEventListener("input", render);
  language.addEventListener("change", render);
  wordsTab.addEventListener("click", () => { kind = "words"; search.value = ""; render(); restoreStudy(); });
  sentencesTab.addEventListener("click", () => { kind = "sentences"; search.value = ""; render(); restoreStudy(); });
  reviewTab.addEventListener("click", () => { view = "review"; render(); });
  learnedTab.addEventListener("click", () => { view = "learned"; render(); });
  refresh.addEventListener("click", load);
  download.addEventListener("click", downloadWords);
  deleteCancel.addEventListener("click", () => closeDeleteDialog());
  deleteConfirm.addEventListener("click", removeItem);
  deleteModal.addEventListener("click", (event) => { if (event.target === deleteModal) closeDeleteDialog(); });
  window.addEventListener("keydown", (event) => {
    if (deleteModal.hidden) return;
    if (event.key === "Escape") {
      closeDeleteDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [deleteCancel, deleteConfirm].filter(control => !control.disabled);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || !deleteModal.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  studyStart.addEventListener("click", startStudy);
  studyExit.addEventListener("click", exitStudy);
  studyBack.addEventListener("click", () => {
    studyPosition = previousStudyPosition(studyPosition, studyWords.length);
    studyExplanationOpen = false;
    persistStudy();
    renderStudy();
    studyWord.focus();
  });
  studyNext.addEventListener("click", () => {
    studyPosition = nextStudyPosition(studyPosition, studyWords.length);
    studyExplanationOpen = false;
    persistStudy();
    renderStudy();
    (studyPosition >= studyWords.length ? studyRestart : studyWord).focus();
  });
  studyRestart.addEventListener("click", () => {
    studyPosition = 0;
    studyExplanationOpen = false;
    persistStudy();
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
  studyLearned.addEventListener("click", () => {
    const word = studyWords[studyPosition];
    if (word) setLearned(word, !word.learned, true);
  });
  studyTranslate.addEventListener("click", () => {
    const word = studyWords[studyPosition];
    if (word) translateWord(word);
  });
  studyDelete.addEventListener("click", () => {
    const word = studyWords[studyPosition];
    if (word) openDeleteDialog(word, studyDelete);
  });
  window.addEventListener("focus", load);
  load();
})();
