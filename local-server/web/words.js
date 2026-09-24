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

export function removeStudyItem(words = [], position, id) {
  const items = Array.isArray(words) ? words : [];
  const safePosition = Number.isSafeInteger(position) ? Math.min(Math.max(position, 0), items.length) : 0;
  const removedPosition = items.findIndex((word) => word?.id === id);
  if (removedPosition < 0) return { words: items, position: safePosition };
  const remaining = items.filter((word) => word?.id !== id);
  return {
    words: remaining,
    position: Math.min(Math.max(safePosition - (removedPosition < safePosition ? 1 : 0), 0), remaining.length),
  };
}

export function learningText(item, kind = "words") {
  if (!item || typeof item.text !== "string") return "";
  return item.language === "zh" ? explanationText(item.pinyin) : item.text;
}

// Han remains canonical source data for speech/export, never learning copy.
function explanationText(value) {
  return typeof value === "string" ? value.replace(/\p{Script=Han}/gu, "").trim() : "";
}

export function validAnalysis(value) {
  const text = (value, required = true) => typeof value === "string"
    && (!required || value.trim().length > 0) && !/\p{Script=Han}/u.test(value);
  return Boolean(value && typeof value === "object"
    && text(value.pinyin) && text(value.translation) && text(value.grammar)
    && Array.isArray(value.components) && value.components.length > 0
    && value.components.every(item => item && typeof item.text === "string"
      && text(item.pinyin) && text(item.translation) && text(item.usage, false))
    && value.example && text(value.example.pinyin) && text(value.example.translation));
}

export function pronunciationText(item) {
  return item && ["zh", "en"].includes(item.language) && typeof item.text === "string"
    ? item.text.trim() : "";
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
  const speechVoiceControl = document.getElementById("speech-voice");
  const speechRateControl = document.getElementById("speech-rate");
  const speechPreview = document.getElementById("speech-preview");
  const speechStatus = document.getElementById("speech-status");
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
  const studyAnalysis = document.getElementById("study-analysis");
  const studyExplanation = document.getElementById("study-explanation");
  const studyExplanationText = document.getElementById("study-explanation-text");
  const studyFinish = document.getElementById("study-finish");
  const studyFinishTitle = document.getElementById("study-finish-title");
  const studyBack = document.getElementById("study-back");
  const studySpeak = document.getElementById("study-speak");
  const studyLearned = document.getElementById("study-learned");
  const studyExplain = document.getElementById("study-explain");

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
  let speechRate = 0.8;
  let speechVoiceName = "";
  let speechVoices = [];
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
    if (!studyWords.length) {
      clearSavedStudy();
      return;
    }
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

  function appendAnalysis(container, analysis) {
    const components = element("ul", "analysis-components", "");
    for (const component of analysis.components) {
      const row = element("li", "", "");
      const pinyin = element("strong", "analysis-pinyin", component.pinyin);
      pinyin.lang = "zh-Latn";
      row.append(pinyin, element("span", "", ` — ${component.translation}`));
      if (component.usage) row.append(element("small", "analysis-usage", component.usage));
      components.append(row);
    }
    const example = element("p", "analysis-example", "");
    const pinyin = element("span", "analysis-pinyin", analysis.example.pinyin);
    pinyin.lang = "zh-Latn";
    example.append(pinyin, element("span", "", ` — ${analysis.example.translation}`));
    const wordsBlock = element("section", "analysis-block", "");
    wordsBlock.append(components);
    const logicBlock = element("section", "analysis-block analysis-logic", "");
    logicBlock.append(element("h4", "analysis-heading", "Как это работает"), element("p", "analysis-grammar", analysis.grammar));
    const exampleBlock = element("section", "analysis-block analysis-example-block", "");
    exampleBlock.append(element("h4", "analysis-heading", "Пример"), example);
    container.append(wordsBlock, logicBlock, exampleBlock);
  }

  function iconButton(className, label, pathData) {
    const button = element("button", `${className} icon-button`, "");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
    button.append(svg);
    return button;
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
      text.lang = word.language === "zh" ? "zh-Latn" : word.language;
      main.append(text);
      if (word.language !== "zh" && kind === "words" && word.pinyin) {
        const pinyin = element("p", "word-pinyin", word.pinyin);
        pinyin.lang = "zh-Latn";
        main.append(pinyin);
      }
      const learned = iconButton("learned", word.learned ? "Вернуть на повторение" : "Отметить как выученное",
        word.learned ? "M4 4v6h6M4 10a8 8 0 1 1 1 8" : "m5 12 4 4L19 6");
      learned.disabled = busy;
      learned.title = word.learned ? `Вернуть ${noun("one")} в список на повторение` : `Отметить ${noun("one")} как выученное`;
      learned.setAttribute("aria-label", `${learned.title}: «${learningText(word, kind)}»`);
      learned.addEventListener("click", () => setLearned(word, !word.learned));
      const remove = iconButton("delete", `Удалить ${noun("one")}`, "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7");
      remove.disabled = busy;
      remove.setAttribute("aria-label", `Удалить ${noun("one")}: «${learningText(word, kind)}»`);
      remove.addEventListener("click", () => openDeleteDialog(word, remove));
      const translation = element("div", "word-translation", "");
      translation.append(element("p", "", word.language === "zh" ? explanationText(word.translation) : word.translation));
      if (word.language !== "zh" && kind === "words" && word.ai_translations.length) {
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
      if (word.language !== "zh" && word.explanation) {
        details = element("details", "word-explanation", "");
        details.append(element("summary", "", kind === "sentences" ? "Разбор грамматики" : "Короткое объяснение"), element("p", "", word.explanation));
        translation.append(details);
      }
      const explain = element("button", "explain", word.language === "zh"
        ? (validAnalysis(word.analysis) ? "Обновить разбор" : "Разобрать") : word.explanation
        ? (kind === "sentences" ? "Разбор" : "Объяснение")
        : (kind === "sentences" ? "Разобрать" : "Объяснить"));
      explain.type = "button";
      explain.disabled = busy;
      explain.addEventListener("click", () => word.language === "zh" ? analyzeWord(word)
        : word.explanation ? details.toggleAttribute("open") : explainWord(word));
      const actions = element("div", "word-actions", "");
      const speak = iconButton("speak", "Произнести", "m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14");
      speak.setAttribute("aria-label", `Произнести: «${learningText(word, kind)}»`);
      speak.addEventListener("click", () => speakItem(word, speak));
      main.append(speak);

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
    studySpeak.hidden = complete;
    studySpeak.disabled = Boolean(studySpeak.speaking);
    studyNext.hidden = complete;
    studyLearned.hidden = complete;
    studyExplain.hidden = complete;
    studyDelete.hidden = complete;
    studyAnalysis.hidden = true;
    studyAnalysis.replaceChildren();
    studyRestart.hidden = !complete;
    if (complete) return;
    const word = studyWords[studyPosition];
    studyLanguage.textContent = word.language === "zh" ? "Китайский" : "Английский";
    studyWord.textContent = learningText(word, kind);
    studyWord.classList.toggle("sentence-text", kind === "sentences");
    studyWord.lang = word.language === "zh" ? "zh-Latn" : word.language;
    studyPinyin.textContent = word.language !== "zh" && kind === "words" ? word.pinyin : "";
    studyPinyin.lang = "zh-Latn";
    studyPinyin.hidden = !studyPinyin.textContent;
    studyTranslation.textContent = word.language === "zh" ? explanationText(word.translation) : word.translation;
    if (word.language === "zh" && validAnalysis(word.analysis)) {
      appendAnalysis(studyAnalysis, word.analysis);
      studyAnalysis.hidden = false;
    }
    studyLearned.disabled = busy;
    studyLearned.textContent = word.learned ? "Вернуть на повторение" : `${kind === "sentences" ? "Предложение" : "Слово"} выучено`;
    studyExplain.disabled = busy;
    studyExplain.textContent = word.language === "zh"
      ? (validAnalysis(word.analysis) ? "Обновить разбор" : "Разобрать") : word.explanation
      ? (kind === "sentences" ? "Показать разбор" : "Показать объяснение")
      : (kind === "sentences" ? "Разобрать" : "Объяснить");
    studyExplanation.hidden = word.language === "zh" || !word.explanation || !studyExplanationOpen;
    studyExplanationText.textContent = word.language === "zh" ? "" : word.explanation || "";
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
      if (!studyMode.hidden) renderStudy();
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
      if (deletedDuringStudy) {
        ({ words: studyWords, position: studyPosition } = removeStudyItem(studyWords, studyPosition, target.word.id));
        studyExplanationOpen = false;
        persistStudy();
      } else {
        clearSavedStudy(target.kind);
      }
      removed = true;
      message(`${label} «${learningText(target.word, target.kind)}» удалено.`);
    } catch (error) {
      message(error instanceof Error ? error.message : `Не удалось удалить ${target.kind === "sentences" ? "предложение" : "слово"}.`, true);
    } finally {
      busy = false;
      deleteCancel.disabled = false;
      deleteConfirm.disabled = false;
      if (removed) closeDeleteDialog({ restoreFocus: false });
      render();
      if (deletedDuringStudy) {
        renderStudy();
        if (removed) (studyPosition >= studyWords.length ? studyRestart : studyWord).focus();
      } else if (removed) {
        search.focus();
      }
    }
  }

  function extensionRequest(action, payload = {}, timeoutMs = 10000) {
    const requestId = crypto.randomUUID().replace(/-/gu, "");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Расширение не ответило. Перезагрузите его на странице chrome://extensions и обновите панель.")), timeoutMs);
      function receive(event) {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || !data
          || data.type !== `${action}.result` || data.requestId !== requestId) return;
        finish(data.ok ? data : new Error(data.error || (action.startsWith("subsanywhere.panel.ai.") ? "Не удалось получить настройки ИИ. Обновите расширение и повторите попытку." : "Не удалось запустить произношение")));
      }
      function finish(result) {
        clearTimeout(timeout);
        window.removeEventListener("message", receive);
        result instanceof Error ? reject(result) : resolve(result);
      }
      window.addEventListener("message", receive);
      window.postMessage({ type: action, requestId, ...payload }, location.origin);
    });
  }

  function showSpeechStatus(text, error = false) {
    speechStatus.textContent = text;
    speechStatus.classList.toggle("error", error);
  }

  function renderSpeechVoices() {
    speechVoiceControl.replaceChildren();
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "Автоматически — Google";
    speechVoiceControl.append(automatic);
    for (const voice of speechVoices) {
      const item = document.createElement("option");
      item.value = voice.voiceName;
      item.textContent = voice.voiceName;
      speechVoiceControl.append(item);
    }
    speechVoiceControl.value = speechVoices.some(voice => voice.voiceName === speechVoiceName) ? speechVoiceName : "";
  }

  async function loadSpeechSettings() {
    try {
      const result = await extensionRequest("subsanywhere.speech.get");
      if (Number.isFinite(Number(result.settings?.rate))) speechRate = Number(result.settings.rate);
      speechVoiceName = typeof result.settings?.voiceName === "string" ? result.settings.voiceName : "";
      speechVoices = Array.isArray(result.voices) ? result.voices : [];
      renderSpeechVoices();
      speechRateControl.value = String(speechRate);
      showSpeechStatus("");
    } catch (error) {
      showSpeechStatus(error.message, true);
    }
  }

  async function saveSpeechSettings() {
    try {
      const result = await extensionRequest("subsanywhere.speech.patch", {
        rate: Number(speechRateControl.value), voiceName: speechVoiceControl.value,
      });
      speechRate = Number(result.settings?.rate) || speechRate;
      speechVoiceName = typeof result.settings?.voiceName === "string" ? result.settings.voiceName : speechVoiceName;
      speechVoices = Array.isArray(result.voices) ? result.voices : speechVoices;
      renderSpeechVoices();
      speechRateControl.value = String(speechRate);
      showSpeechStatus("Настройки сохранены");
    } catch (error) {
      renderSpeechVoices();
      speechRateControl.value = String(speechRate);
      showSpeechStatus(error.message, true);
    }
  }

  async function previewSpeech() {
    speechPreview.disabled = true;
    showSpeechStatus("");
    try {
      await extensionRequest("subsanywhere.speech.speak", { text: "你好，很高兴认识你。", language: "zh" });
    } catch (error) {
      showSpeechStatus(error.message, true);
    } finally {
      speechPreview.disabled = false;
    }
  }

  async function speakItem(item, button) {
    const text = pronunciationText(item);
    if (!text || button.speaking) return;
    button.speaking = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    showSpeechStatus("");
    try {
      await extensionRequest("subsanywhere.speech.speak", { text, language: item.language });
    } catch (error) {
      showSpeechStatus(error.message, true);
    } finally {
      button.speaking = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function requestPanelAction(id, action) {
    const requestKind = kind;
    const requestId = crypto.randomUUID().replace(/-/gu, "");
    return new Promise((resolve, reject) => {
      // Analysis may make two sequential model requests plus confirmed storage.
      const timeout = setTimeout(() => finish(new Error("Расширение не ответило. Перезагрузите его на странице chrome://extensions.")), action === "subsanywhere.words.analyze" ? 70000 : 45000);
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

  async function analyzeWord(word) {
    if (busy || word.language !== "zh") return;
    const requestKind = kind;
    busy = true;
    message("Готовим разбор…");
    render();
    renderStudy();
    try {
      const fresh = await requestPanelAction(word.id, "subsanywhere.words.analyze");
      if (!fresh || fresh.id !== word.id || fresh.language !== "zh" || fresh.text !== word.text
        || typeof fresh.learned !== "boolean" || !validAnalysis(fresh.analysis)
        || fresh.pinyin !== fresh.analysis.pinyin || fresh.translation !== fresh.analysis.translation) {
        throw new Error("Расширение не подтвердило разбор. Попробуйте ещё раз.");
      }
      if (requestKind === "sentences") sentences = sentences.map(item => item.id === fresh.id ? { ...item, ...fresh } : item);
      else words = words.map(item => item.id === fresh.id ? { ...item, ...fresh } : item);
      if (kind === requestKind) studyWords = studyWords.map(item => item.id === fresh.id ? { ...item, ...fresh } : item);
      message("Разбор сохранён.");
    } catch (error) {
      message(error instanceof Error ? error.message : "Не удалось получить разбор.", true);
    } finally {
      busy = false;
      render();
      renderStudy();
    }
  }

  // Settings use the same origin-bound request/reply transport as speech.
  const aiDialog = document.getElementById("panel-ai-dialog");
  const aiOpen = document.getElementById("panel-ai-open");
  const aiClose = document.getElementById("panel-ai-close");
  const aiProvider = document.getElementById("panel-ai-provider");
  const aiModel = document.getElementById("panel-ai-model");
  const aiLoad = document.getElementById("panel-ai-load");
  const aiSave = document.getElementById("panel-ai-save");
  const aiStatus = document.getElementById("panel-ai-status");
  const aiSaved = document.getElementById("panel-ai-saved");
  let aiSettings = null;
  let aiCatalog = [];
  let aiRevision = 0;
  let aiLoading = false;
  let aiSaving = false;

  function aiMessage(text, error = false) {
    aiStatus.textContent = text;
    aiStatus.classList.toggle("error", error);
  }

  function validAiSettings(settings) {
    return settings && ["openai", "deepseek"].includes(settings.provider)
      && typeof settings.model === "string"
      && ["openai", "deepseek"].every(provider => typeof settings.providers?.[provider]?.hasApiKey === "boolean");
  }

  function aiHasKey() { return aiSettings?.providers[aiProvider.value]?.hasApiKey === true; }
  function renderAiControls() {
    aiProvider.disabled = !aiSettings || aiSaving;
    aiLoad.disabled = !aiSettings || !aiHasKey() || aiLoading || aiSaving;
    aiModel.disabled = !aiCatalog.length || aiLoading || aiSaving;
    aiSave.disabled = !aiHasKey() || aiLoading || aiSaving || !aiCatalog.includes(aiModel.value);
    aiLoad.setAttribute("aria-busy", String(aiLoading));
    aiSave.setAttribute("aria-busy", String(aiSaving));
  }

  function resetAiCatalog() {
    aiCatalog = [];
    const model = aiSettings?.provider === aiProvider.value ? aiSettings.model : "";
    const option = element("option", "", model ? `${model} — сохранено` : "Сначала загрузите модели");
    option.value = model;
    aiModel.replaceChildren(option);
    aiModel.value = model;
    renderAiControls();
    aiMessage(aiHasKey() ? "" : `Сохраните API-ключ ${aiProvider.value === "openai" ? "OpenAI" : "DeepSeek"} в настройках расширения, затем обновите панель.`, !aiHasKey());
  }

  function renderAiSaved() {
    aiSaved.textContent = aiSettings.model
      ? `Сохранено: ${aiSettings.provider === "openai" ? "OpenAI" : "DeepSeek"} · ${aiSettings.model}` : "Модель панели ещё не сохранена";
  }

  async function loadPanelAiSettings() {
    renderAiControls();
    try {
      const result = await extensionRequest("subsanywhere.panel.ai.get");
      if (!validAiSettings(result.settings)) throw new Error("Расширение вернуло неверные настройки ИИ. Обновите расширение и панель.");
      aiSettings = result.settings;
      aiProvider.value = aiSettings.provider;
      renderAiSaved();
      resetAiCatalog();
    } catch (error) { aiMessage(error.message, true); }
  }

  async function loadPanelAiModels() {
    if (aiLoad.disabled) return;
    const provider = aiProvider.value;
    const revision = ++aiRevision;
    aiLoading = true;
    aiCatalog = [];
    renderAiControls();
    aiMessage("Загрузка моделей…");
    try {
      const result = await extensionRequest("subsanywhere.panel.ai.models", { provider }, 30000);
      if (revision !== aiRevision || provider !== aiProvider.value) return;
      // AIClient.filterAvailableModels returns original model IDs as strings.
      if (result.provider !== provider || !Array.isArray(result.models)
        || result.models.some(model => typeof model !== "string" || !model.trim())) {
        throw new Error("Расширение вернуло неверный список моделей.");
      }
      if (!result.models.length) throw new Error("Доступных моделей нет. Проверьте ключ и доступ к моделям в настройках расширения.");
      aiCatalog = [...new Set(result.models)];
      const selected = aiCatalog.includes(aiModel.value) ? aiModel.value : "";
      const placeholder = element("option", "", "Выберите модель");
      placeholder.value = "";
      aiModel.replaceChildren(placeholder);
      for (const model of aiCatalog) {
        const option = element("option", "", model);
        option.value = model;
        aiModel.append(option);
      }
      aiModel.value = selected;
      aiMessage("Модели загружены. Выберите одну и сохраните настройки.");
    } catch (error) {
      if (revision === aiRevision) aiMessage(error.message, true);
    } finally {
      if (revision === aiRevision) { aiLoading = false; renderAiControls(); }
    }
  }

  async function savePanelAiSettings() {
    if (aiSave.disabled) return;
    const provider = aiProvider.value;
    const model = aiModel.value;
    const revision = aiRevision;
    aiSaving = true;
    renderAiControls();
    aiMessage("Сохранение настроек панели…");
    try {
      const result = await extensionRequest("subsanywhere.panel.ai.save", { provider, model });
      if (!validAiSettings(result.settings) || result.settings.provider !== provider || result.settings.model !== model) {
        throw new Error("Расширение не подтвердило настройки панели. Попробуйте сохранить ещё раз.");
      }
      const confirmed = await extensionRequest("subsanywhere.panel.ai.get");
      if (!validAiSettings(confirmed.settings) || confirmed.settings.provider !== provider || confirmed.settings.model !== model) {
        throw new Error("Не удалось подтвердить сохранение настроек панели. Попробуйте ещё раз.");
      }
      if (revision !== aiRevision || provider !== aiProvider.value) return;
      aiSettings = confirmed.settings;
      renderAiSaved();
      aiMessage("Настройки панели сохранены.");
    } catch (error) {
      if (revision === aiRevision) aiMessage(error.message, true);
    } finally {
      aiSaving = false;
      renderAiControls();
    }
  }

  aiOpen.addEventListener("click", () => {
    if (typeof aiDialog.showModal === "function") aiDialog.showModal();
    else aiDialog.setAttribute("open", "");
  });
  aiClose.addEventListener("click", () => {
    if (typeof aiDialog.close === "function") aiDialog.close();
    else aiDialog.removeAttribute("open");
  });
  aiDialog.addEventListener("click", (event) => {
    if (event.target === aiDialog) {
      if (typeof aiDialog.close === "function") aiDialog.close();
      else aiDialog.removeAttribute("open");
    }
  });
  aiLoad.addEventListener("click", loadPanelAiModels);
  aiSave.addEventListener("click", savePanelAiSettings);
  aiProvider.addEventListener("change", () => {
    aiRevision += 1;
    aiLoading = false;
    resetAiCatalog();
  });
  aiModel.addEventListener("change", renderAiControls);

  search.addEventListener("input", render);
  language.addEventListener("change", render);
  wordsTab.addEventListener("click", () => { kind = "words"; search.value = ""; render(); restoreStudy(); });
  sentencesTab.addEventListener("click", () => { kind = "sentences"; search.value = ""; render(); restoreStudy(); });
  reviewTab.addEventListener("click", () => { view = "review"; render(); });
  learnedTab.addEventListener("click", () => { view = "learned"; render(); });
  refresh.addEventListener("click", load);
  download.addEventListener("click", downloadWords);
  speechVoiceControl.addEventListener("change", saveSpeechSettings);
  speechRateControl.addEventListener("change", saveSpeechSettings);
  speechPreview.addEventListener("click", previewSpeech);
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
  studySpeak.addEventListener("click", () => {
    const word = studyWords[studyPosition];
    if (word) speakItem(word, studySpeak);
  });
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
    if (word.language === "zh") { analyzeWord(word); return; }
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

  studyDelete.addEventListener("click", () => {
    const word = studyWords[studyPosition];
    if (word) openDeleteDialog(word, studyDelete);
  });
  window.addEventListener("focus", load);
  loadSpeechSettings();
  loadPanelAiSettings();
  load();
})();
