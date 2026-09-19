(() => {
  const runtime = globalThis.DualCaptionsContentRuntime;
  if (!runtime) return;

  const CONTROLLER_KEY = '__dualCaptionsControllerV3';
  const MESSAGE = Object.freeze({
    PLAYER_REPORT: 'dualCaptions.player.report',
    PLAYER_DISCOVER: 'dualCaptions.player.discover',
    CONTENT_FULL_STATE: 'dualCaptions.content.fullState',
    CONTENT_SETTINGS: 'dualCaptions.content.settings',
    CONTENT_TRACKS: 'dualCaptions.content.tracks',
    TRACK_CACHE_BUILTIN: 'dualCaptions.track.cacheBuiltin',
    CONTENT_POSITION_PATCH: 'dualCaptions.content.positionPatch',
    WORDS_LIST: 'dualCaptions.words.list',
    WORDS_SAVE: 'dualCaptions.words.save',
    SENTENCES_LIST: 'dualCaptions.sentences.list',
    SENTENCES_SAVE: 'dualCaptions.sentences.save',

    CONTENT_RESET: 'dualCaptions.content.reset',
  });
  function sendMessage(message) {
    try { return chrome.runtime.sendMessage(message); }
    catch { return Promise.resolve({ ok: false }); }
  }

  function createController() {
    const state = {
      active: false,
      settings: runtime.normalizeSettings(),
      externalTracks: [],
      root: null,
      second: null,
      dragHandle: null,
      tooltip: null,
      tooltipItem: null,
      tooltipAnchor: null,
      meaningPreview: null,
      meaningPreviewAnchor: null,
      drag: null,
      renderedCaptionKey: '',
      renderedCaptionItems: null,
      inlineCells: null,
      sentenceTranslationLine: null,
      characterLine: null,
      captionLayoutKey: '',
      wordCells: [],
      wordButton: null,
      sentenceButton: null,
      sentenceCharacters: null,
      sentence: null,
    };
    let savedWords = new Map();
    let wordsRequest = null;
    let lastWordsSync = -Infinity;
    let wordsRevision = 0;
    let savedSentences = new Map();
    let sentencesRequest = null;
    let lastSentencesSync = -Infinity;
    let sentencesRevision = 0;
    const builtInTrackResolver = runtime.createBuiltInTrackResolver();
    const originalTrackModes = new Map();
    const localBuiltInTracks = new Map();
    const cachedBuiltInSelections = new Set();
    const cachingBuiltInSelections = new Set();
    const cleanup = [];
    const translationCache = new Map();
    const translationFailures = new Map();
    const maxCachedTranslations = 80;
    const maxQueuedTranslations = 3;
    let translationInFlight = false;
    const queuedTranslations = [];
    const queuedTranslationSet = new Set();
    const inFlightTranslationKeys = new Set();
    let lastTranslationAt = 0;
    let translationDispatchScheduled = false;
    let translationTimer;
    let lifecycle = 0;
    let destroyed = false;

    function cancelPendingWork() {
      lifecycle += 1;
      wordsRevision += 1;
      sentencesRevision += 1;
      lastWordsSync = -Infinity;
      lastSentencesSync = -Infinity;
      queuedTranslations.length = 0;
      queuedTranslationSet.clear();
      clearTimeout(translationTimer);
      translationDispatchScheduled = false;
    }


    function ensureOverlay() {
      if (state.root?.isConnected) return;
      const root = document.createElement('div');
      root.id = 'dual-captions-overlay';
      root.setAttribute('aria-live', 'polite');
      root.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;overflow:hidden;';
      const makeLayer = (name) => {
        const element = document.createElement('div');
        element.className = name;
        element.style.cssText = 'position:absolute;left:50%;width:max-content;max-width:92%;box-sizing:border-box;border-radius:8px;color:#fff;text-align:center;font-family:Arial,sans-serif;font-weight:700;line-height:1.3;letter-spacing:.01em;white-space:pre-line;overflow-wrap:anywhere;text-shadow:0 1px 3px rgba(0,0,0,.92);transform:translateX(-50%);';
        root.append(element);
        return element;
      };
      state.second = makeLayer('subs-anywhere-original');
      state.second.style.pointerEvents = 'auto';
      state.second.addEventListener('scroll', () => {
        dismissTooltip();
        dismissMeaningPreview();
      });
      const dragHandle = document.createElement('button');
      dragHandle.type = 'button';
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Перетащить субтитры';
      dragHandle.setAttribute('aria-label', 'Перетащить субтитры по видео');
      dragHandle.style.cssText = 'position:absolute;z-index:2;display:grid;width:28px;height:28px;place-items:center;border:1px solid rgba(204,217,255,.85);border-radius:8px;background:rgba(19,24,38,.9);color:#eaf0ff;font:700 22px/1 Arial,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.5);cursor:grab;touch-action:none;pointer-events:auto;';
      const moveDrag = (event) => {
        if (!state.drag || event.pointerId !== state.drag.pointerId) return;
        const position = runtime.moveCaptionPosition(state.drag, event.clientX, event.clientY, state.root.getBoundingClientRect());
        if (!position) return;
        Object.assign(state.settings, position);
        applyCaptionPosition();
        positionDragHandle();
      };
      const finishDrag = (event) => {
        if (!state.drag || event.pointerId !== state.drag.pointerId) return;
        moveDrag(event);
        state.drag = null;
        dragHandle.releasePointerCapture?.(event.pointerId);
        dragHandle.style.cursor = 'grab';
        render();
        sendMessage({
          type: MESSAGE.CONTENT_POSITION_PATCH,
          secondLeft: state.settings.secondLeft,
          secondBottom: state.settings.secondBottom,
        }).catch(() => undefined);
      };
      dragHandle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const root = state.root.getBoundingClientRect();
        const caption = state.second.getBoundingClientRect();
        if (!root.width || !root.height) return;
        dismissTooltip();
        state.drag = {
          pointerId: event.pointerId,
          pointerX: event.clientX,
          pointerY: event.clientY,
          secondLeft: ((caption.left - root.left + caption.width / 2) / root.width) * 100,
          secondBottom: ((root.top + root.height - caption.top - caption.height) / root.height) * 100,
        };
        dragHandle.style.cursor = 'grabbing';
        dragHandle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      });
      dragHandle.addEventListener('pointermove', moveDrag);
      dragHandle.addEventListener('pointerup', finishDrag);
      dragHandle.addEventListener('pointercancel', finishDrag);
      root.append(dragHandle);
      state.dragHandle = dragHandle;
      document.documentElement.append(root);
      state.root = root;
    }

    function dismissTooltip() {
      state.tooltip?.remove();
      state.tooltip = null;
      state.tooltipItem = null;
      state.tooltipAnchor = null;
      state.wordButton = null;
    }

    function wordKey(word) {
      if (!word) return '';
      const clean = (value) => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
      return JSON.stringify([word.language, word.language === 'en' ? clean(word.text).toLowerCase() : clean(word.text),
        clean(word.pinyin).toLowerCase()]);
    }

    function sentenceKey(sentence) {
      return wordKey(sentence);
    }

    function updateSavedWords() {
      for (const { cell, key } of state.wordCells) {
        const word = key ? savedWords.get(key) : null;
        const saved = Boolean(word);
        const learned = word?.learned === true;
        cell.style.backgroundColor = learned ? 'rgba(74, 176, 184, .16)' : (saved ? 'rgba(80, 170, 115, .18)' : '');
        cell.style.borderColor = learned ? 'rgba(112, 202, 207, .4)' : (saved ? 'rgba(110, 195, 140, .42)' : '');
        cell.setAttribute('data-word-saved', String(saved));
        cell.setAttribute('data-word-learned', String(learned));
      }
      if (state.wordButton && !state.wordButton.saving) {
        const saved = savedWords.has(wordKey(state.tooltipItem?.word));
        state.wordButton.textContent = saved ? '✓ Сохранено' : 'Сохранить слово';
        state.wordButton.disabled = saved || !state.tooltipItem?.word;
      }
    }

    function syncWords(force = false) {
      if (!state.active || destroyed || wordsRequest || (!force && Date.now() - lastWordsSync < 15000)) return;
      lastWordsSync = Date.now();
      const generation = lifecycle;
      const revision = wordsRevision;
      wordsRequest = Promise.resolve().then(() => sendMessage({ type: MESSAGE.WORDS_LIST }))
        .then((response) => {
          if (generation !== lifecycle || revision !== wordsRevision || destroyed
            || !response?.ok || !Array.isArray(response.data?.words)) return;
          savedWords = new Map(response.data.words.map((word) => [wordKey(word), word]));
          updateSavedWords();
        }).catch(() => undefined).finally(() => { wordsRequest = null; });
    }

    function updateSavedSentence() {
      const saved = Boolean(state.sentence && savedSentences.has(sentenceKey(state.sentence)));
      if (state.sentenceCharacters) {
        state.sentenceCharacters.style.color = saved ? 'rgba(151, 213, 169, .88)' : 'inherit';
        state.sentenceCharacters.style.opacity = saved ? '.88' : '.68';
      }
      if (state.sentenceButton && !state.sentenceButton.saving) {
        state.sentenceButton.textContent = saved ? '✓ Предложение сохранено' : 'Сохранить предложение';
        state.sentenceButton.disabled = saved || !state.sentence;
      }
    }

    function syncSentences(force = false) {
      if (!state.active || destroyed || sentencesRequest || (!force && Date.now() - lastSentencesSync < 15000)) return;
      lastSentencesSync = Date.now();
      const generation = lifecycle;
      const revision = sentencesRevision;
      sentencesRequest = Promise.resolve().then(() => sendMessage({ type: MESSAGE.SENTENCES_LIST }))
        .then((response) => {
          if (generation !== lifecycle || revision !== sentencesRevision || destroyed
            || !response?.ok || !Array.isArray(response.data?.sentences)) return;
          savedSentences = new Map(response.data.sentences.map((sentence) => [sentenceKey(sentence), sentence]));
          updateSavedSentence();
        }).catch(() => undefined).finally(() => { sentencesRequest = null; });
    }

    function captionSentence(descriptor, items) {
      const sentenceItem = Array.isArray(items)
        ? items.find((item) => item?.isSentenceTranslation && typeof item.dictionary === 'string' && item.dictionary.trim())
        : null;
      if (!sentenceItem) return null;
      return {
        language: descriptor.characters ? 'zh' : 'en',
        text: descriptor.sourceText,
        pinyin: descriptor.characters ? descriptor.displayText : '',
        translation: sentenceItem.dictionary.trim(),
      };
    }

    function appendSentenceButton(descriptor, items) {
      if (!descriptor.characters) {
        state.sentence = null;
        return;
      }
      state.sentence = captionSentence(descriptor, items);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dual-captions-save-sentence';
      button.style.cssText = 'display:block;width:max-content;max-width:100%;margin:3px auto 0;padding:2px 7px;border:1px solid rgba(126,190,146,.38);border-radius:5px;background:rgba(66,120,82,.16);color:#dce8df;font:600 10px/1.25 Arial,sans-serif;white-space:normal;cursor:pointer;pointer-events:auto;';
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!state.sentence || button.disabled || button.saving) return;
        const sentence = state.sentence;
        const generation = lifecycle;
        sentencesRevision += 1;
        button.saving = true;
        button.disabled = true;
        button.textContent = 'Сохраняем предложение…';
        try {
          const response = await sendMessage({ type: MESSAGE.SENTENCES_SAVE, sentence });
          if (!response?.ok || !response.data?.sentence) throw new Error(response?.error || 'Не удалось сохранить предложение');
          if (generation !== lifecycle || destroyed) return;
          savedSentences.set(sentenceKey(response.data.sentence), response.data.sentence);
        } catch (error) {
          button.failed = true;
          button.title = error?.message || 'Не удалось сохранить предложение';
        } finally {
          button.saving = false;
          sentencesRevision += 1;
          if (generation === lifecycle && !destroyed) {
            updateSavedSentence();
            if (button.failed && !button.disabled) button.textContent = 'Не удалось сохранить — повторить';
          }
        }
      });
      state.second.append(button);
      state.sentenceButton = button;
      updateSavedSentence();
    }

    function cellWord(segment, descriptor) {
      const term = segment.term;
      if (!term || !segment.translation) return null;
      if (descriptor.characters) {
        if (typeof term.text !== 'string' || !/\p{Script=Han}/u.test(term.text)
          || !descriptor.characters.includes(term.text) || typeof term.pinyin !== 'string') return null;
        return { language: 'zh', text: term.text, pinyin: term.pinyin, translation: segment.translation };
      }
      return { language: 'en', text: segment.text, pinyin: '', translation: segment.translation };
    }

    function appendWordButton(tooltip, item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dual-captions-save-word';
      button.style.cssText = 'display:block;margin-top:10px;padding:7px 10px;border:1px solid rgba(150,185,165,.4);border-radius:6px;background:rgba(100,155,120,.12);color:#e5ede8;font:600 12px/1.3 Arial,sans-serif;cursor:pointer;';
      const status = document.createElement('div');
      status.setAttribute('role', 'status');
      status.style.cssText = 'margin-top:5px;font-size:11px;color:#c4cbd6;';
      if (!item.word) status.textContent = item.dictionary === 'Перевод этой ячейки пока отсутствует'
        ? 'Сохранение доступно после перевода.' : 'ИИ не указал иероглифы этой ячейки. Сохранение недоступно.';
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!item.word || button.disabled || button.saving) return;
        const generation = lifecycle;
        wordsRevision += 1;
        button.saving = true;
        button.disabled = true;
        button.textContent = 'Сохраняем…';
        status.textContent = '';
        try {
          const response = await sendMessage({ type: MESSAGE.WORDS_SAVE, word: item.word });
          if (!response?.ok || !response.data?.word) throw new Error(response?.error || 'Не удалось сохранить слово. Проверьте сервер Docker');
          if (generation !== lifecycle || destroyed) return;
          savedWords.set(wordKey(response.data.word), response.data.word);
          status.textContent = 'Добавлено в неизвестные слова';
        } catch (error) {
          if (generation === lifecycle && !destroyed) status.textContent = error.message || 'Не удалось сохранить слово';
        } finally {
          button.saving = false;
          wordsRevision += 1;
          if (generation === lifecycle && !destroyed) updateSavedWords();
          if (state.tooltip === tooltip) positionTooltip();
        }
      });
      tooltip.append(button, status);
      state.wordButton = button;
    }

    function dismissMeaningPreview() {
      state.meaningPreview?.remove();
      state.meaningPreview = null;
      state.meaningPreviewAnchor = null;
    }

    function showMeaningPreview(text, anchor) {
      const value = String(text ?? '').trim();
      if (!value || !anchor?.isConnected) return;
      dismissMeaningPreview();
      const preview = document.createElement('div');
      preview.className = 'dual-captions-meaning-preview';
      preview.textContent = value;
      preview.style.cssText = 'position:absolute;z-index:3;max-width:280px;padding:7px 10px;border:1px solid rgba(190,207,255,.8);border-radius:7px;background:rgba(8,10,16,.98);color:#fff;font:700 13px/1.3 Arial,sans-serif;text-align:left;white-space:normal;overflow-wrap:anywhere;box-shadow:0 6px 20px rgba(0,0,0,.72);pointer-events:none;';
      state.root.append(preview);
      state.meaningPreview = preview;
      state.meaningPreviewAnchor = anchor;
      positionMeaningPreview();
    }

    function positionMeaningPreview() {
      if (!state.meaningPreview || !state.meaningPreviewAnchor?.isConnected) return;
      const root = state.root.getBoundingClientRect();
      const anchor = state.meaningPreviewAnchor.getBoundingClientRect();
      const preview = state.meaningPreview;
      preview.style.boxSizing = 'border-box';
      preview.style.maxWidth = `${Math.max(0, Math.min(280, root.width - 16))}px`;
      const box = preview.getBoundingClientRect();
      const above = anchor.top - root.top - box.height - 6;
      const top = above >= 8 ? above : anchor.bottom - root.top + 6;
      preview.style.left = `${Math.max(8, Math.min(root.width - box.width - 8, anchor.left - root.left + (anchor.width - box.width) / 2))}px`;
      preview.style.top = `${Math.max(8, Math.min(root.height - box.height - 8, top))}px`;
    }

    function makeCaptionFocusable(element) {
      element.addEventListener('focus', () => {
        element.style.outline = '2px solid #adc3ff';
        element.style.outlineOffset = '2px';
      });
      element.addEventListener('blur', () => {
        element.style.outline = '';
        element.style.outlineOffset = '';
      });
    }

    function showTooltip(item, anchor) {
      if (state.tooltipItem === item && state.tooltipAnchor === anchor) {
        dismissTooltip();
        return;
      }
      dismissMeaningPreview();
      dismissTooltip();
      const tooltip = document.createElement('div');
      tooltip.setAttribute('role', 'tooltip');
      tooltip.style.cssText = 'position:absolute;z-index:1;min-width:165px;max-width:280px;padding:10px 32px 10px 11px;border:1px solid rgba(166,190,255,.55);border-radius:10px;background:linear-gradient(145deg,rgba(29,35,53,.98),rgba(14,17,26,.98));color:#fff;font:600 13px/1.35 Arial,sans-serif;text-align:left;white-space:normal;box-shadow:0 10px 28px rgba(0,0,0,.62);backdrop-filter:blur(10px);pointer-events:auto;transform:translate(-50%,-100%);';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Закрыть перевод');
      close.style.cssText = 'position:absolute;right:7px;top:6px;width:20px;height:20px;border:0;border-radius:6px;background:rgba(255,255,255,.09);color:#dce5ff;font:20px/18px Arial,sans-serif;cursor:pointer;';
      close.addEventListener('click', (event) => { event.stopPropagation(); dismissTooltip(); });
      const glossary = (Array.isArray(item.glossary) ? item.glossary : [])
        .map((term) => ({
          source: typeof (term?.pinyin ?? term?.text ?? term?.phrase) === 'string'
            ? String(term.pinyin ?? term.text ?? term.phrase).trim().slice(0, 120)
            : '',
          isPinyin: typeof term?.pinyin === 'string',
          translation: typeof term?.translation === 'string' ? term.translation.trim().slice(0, 160) : '',
        }))
        .filter((term) => term.source && term.translation);
      const dictionary = document.createElement('div');
      dictionary.style.cssText = 'font-size:14px;line-height:1.35;';
      const dictionaryLabel = document.createElement('span');
      dictionaryLabel.style.cssText = 'display:block;margin-bottom:2px;color:#8f9ab3;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;';
      dictionaryLabel.textContent = glossary.length || item.isSentenceTranslation ? 'Перевод' : 'Обычно';
      const dictionaryValue = document.createElement('span');
      dictionaryValue.textContent = item.dictionary;
      dictionary.append(dictionaryLabel, dictionaryValue);
      if (!glossary.length && !item.isSentenceTranslation) {
        const context = document.createElement('div');
        context.style.cssText = 'margin-top:7px;padding-top:6px;border-top:1px solid rgba(177,196,255,.18);color:#d7e1ff;font-size:14px;line-height:1.35;';
        const contextLabel = document.createElement('span');
        contextLabel.style.cssText = 'display:block;margin-bottom:2px;color:#8f9ab3;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;';
        contextLabel.textContent = 'Здесь';
        const contextValue = document.createElement('span');
        contextValue.textContent = item.context;
        context.append(contextLabel, contextValue);
        tooltip.append(close, dictionary, context);
      } else if (glossary.length) {
        const terms = document.createElement('div');
        terms.style.cssText = 'margin-top:7px;padding-top:6px;border-top:1px solid rgba(177,196,255,.18);color:#d7e1ff;font-size:13px;line-height:1.4;';
        const termsLabel = document.createElement('span');
        termsLabel.style.cssText = 'display:block;margin-bottom:3px;color:#8f9ab3;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;';
        termsLabel.textContent = glossary.some((term) => term.isPinyin) ? 'Слова' : 'Фразы';
        terms.append(termsLabel);
        for (const term of glossary) {
          const row = document.createElement('div');
          row.textContent = `${term.source} — ${term.translation}`;
          terms.append(row);
        }
        tooltip.append(close, dictionary, terms);
      } else {
        tooltip.append(close, dictionary);
      }
      if (item.isVocabularyCell) appendWordButton(tooltip, item);
      state.root.append(tooltip);
      state.tooltip = tooltip;
      state.tooltipItem = item;
      state.tooltipAnchor = anchor;
      updateSavedWords();
      if (item.isVocabularyCell) syncWords();
      positionTooltip();
    }

    function positionTooltip() {
      if (!state.tooltip || !state.tooltipAnchor?.isConnected) return;
      const root = state.root.getBoundingClientRect();
      const anchor = state.tooltipAnchor.getBoundingClientRect();
      const tip = state.tooltip;
      tip.style.boxSizing = 'border-box';
      tip.style.minWidth = '0';
      tip.style.width = 'max-content';
      tip.style.maxWidth = `${Math.max(0, Math.min(360, root.width - 16))}px`;
      tip.style.maxHeight = `${Math.max(0, root.height - 16)}px`;
      tip.style.overflowY = 'auto';
      tip.style.overflowWrap = 'anywhere';
      tip.style.overscrollBehavior = 'contain';
      tip.style.transform = 'none';
      const box = tip.getBoundingClientRect();
      const above = anchor.top - root.top - box.height - 8;
      const top = above >= 8 ? above : anchor.top - root.top + anchor.height + 8;
      tip.style.left = `${Math.max(8, Math.min(root.width - box.width - 8, anchor.left - root.left + (anchor.width - box.width) / 2))}px`;
      tip.style.top = `${Math.max(8, Math.min(root.height - box.height - 8, top))}px`;
    }

    function renderPendingCaption(target, text, descriptor, failure = '') {
      const caption = document.createElement('span');
      caption.textContent = text;
      caption.tabIndex = 0;
      caption.setAttribute('role', 'button');
      caption.style.cssText = 'pointer-events:auto;cursor:pointer;border-radius:4px;padding:0 2px;color:inherit;text-decoration:underline;text-decoration-color:rgba(174,199,255,.9);text-decoration-style:dotted;text-decoration-thickness:2px;text-underline-offset:3px;transition:background .14s,color .14s;';
      makeCaptionFocusable(caption);
      const showStatus = () => {
        if (failure) {
          translationFailures.delete(descriptor.key);
          requestTranslation(descriptor, true);
          showTooltip({
            dictionary: failure,
            context: 'Нажмите, чтобы повторить.',
          }, caption);
          return;
        }
        showTooltip({
          dictionary: 'Перевод готовится…',
          context: 'Нажмите ещё раз через мгновение.',
        }, caption);
      };
      caption.addEventListener('click', (event) => { event.stopPropagation(); showStatus(); });
      caption.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showStatus(); }
      });
      target.append(caption);
    }

    function translationDescriptor(text) {
      const bilingual = runtime.splitPinyinCaption(text);
      if (bilingual) {
        return {
          key: `zh\u0000${bilingual.characters}\u0000${bilingual.pinyin}`,
          sourceText: bilingual.characters,
          displayText: bilingual.pinyin,
          language: 'zh',
          characters: bilingual.characters,
        };
      }
      return {
        key: `caption\u0000${text}`,
        sourceText: text,
        displayText: text,
        language: '',
        characters: '',
      };
    }

    function rememberTranslation(key, items) {
      translationFailures.delete(key);
      translationCache.delete(key);
      translationCache.set(key, items);
      while (translationCache.size > maxCachedTranslations) translationCache.delete(translationCache.keys().next().value);
    }

    function rememberTranslationFailure(key, value) {
      const message = String(value ?? '').trim().replace(/\s+/gu, ' ').slice(0, 240);
      translationFailures.delete(key);
      translationFailures.set(key, message || 'Не удалось получить перевод. Проверьте настройки ИИ и повторите.');
      while (translationFailures.size > maxCachedTranslations) translationFailures.delete(translationFailures.keys().next().value);
    }

    function requestTranslation(descriptor, priority = false) {
      if (!descriptor?.key || !descriptor.sourceText || translationCache.has(descriptor.key) || translationFailures.has(descriptor.key)
        || queuedTranslationSet.has(descriptor.key) || inFlightTranslationKeys.has(descriptor.key)) return;
      if (queuedTranslations.length >= maxQueuedTranslations) {
        if (!priority) return;
        const displaced = queuedTranslations.pop();
        if (displaced) queuedTranslationSet.delete(displaced.key);
      }
      if (priority) queuedTranslations.unshift(descriptor);
      else queuedTranslations.push(descriptor);
      queuedTranslationSet.add(descriptor.key);
      pumpTranslations();
    }

    function pumpTranslations() {
      if (!state.active || destroyed || translationInFlight || translationDispatchScheduled || !queuedTranslations.length) return;
      const generation = lifecycle;
      const run = () => {
        if (generation !== lifecycle || !state.active || destroyed) return;
        translationDispatchScheduled = false;
        if (translationInFlight) return;
        const next = queuedTranslations.shift();
        if (next) queuedTranslationSet.delete(next.key);
        if (!next) return;
        translationInFlight = true;
        inFlightTranslationKeys.add(next.key);
        lastTranslationAt = Date.now();
        sendMessage({
          type: 'dualCaptions.caption.translate',
          text: next.sourceText,
          displayText: next.displayText,
          language: next.language,
        })
          .then((response) => {
            if (generation !== lifecycle) return;
            if (response?.ok === true && Array.isArray(response?.data?.items)) {
              rememberTranslation(next.key, response.data.items);
            } else {
              rememberTranslationFailure(next.key, response?.error);
            }
          })
          .catch((error) => {
            if (generation === lifecycle) rememberTranslationFailure(next.key, error?.message);
          })
          .finally(() => {
            translationInFlight = false;
            if (generation === lifecycle && !destroyed) render();
            inFlightTranslationKeys.delete(next.key);
            pumpTranslations();
          });
      };
      const delay = Math.max(0, 750 - (Date.now() - lastTranslationAt));
      if (delay) {
        translationDispatchScheduled = true;
        translationTimer = setTimeout(run, delay);
      }
      else run();
    }

    function futureCaptionTexts(id, fallbackId, video) {
      if (!id) return [];
      if (id.startsWith('external:')) {
        const external = state.externalTracks.find((track) => `external:${track.id}` === id);
        if (!external) return [];
        const scale = Number(external.timeScale) > 0 ? Number(external.timeScale) : 1;
        const sourceTime = (video.currentTime - Number(external.offsetSeconds || 0)) / scale;
        return runtime.upcomingCueTexts(external.cues, sourceTime, { seconds: 30 / scale, limit: 3 });
      }
      const track = builtInTrackResolver.find(video.textTracks, id, fallbackId);
      const nativeTexts = runtime.upcomingCueTexts(track?.cues, video.currentTime, { seconds: 30, limit: 3 });
      if (nativeTexts.length) return nativeTexts;
      const cached = cachedBuiltInTrack(id);
      return runtime.upcomingCueTexts(cached?.cues, video.currentTime, { seconds: 30, limit: 3 });
    }

    function cachedBuiltInTrack(id) {
      const selectionKey = `${state.settings.selectedPlayerKey}\u0000${id}`;
      if (state.settings.secondTrackCacheSource === selectionKey) {
        const persisted = state.externalTracks.find((track) => (
          track.id === state.settings.secondTrackCacheId && track.sourceType === 'builtin-cache'
        ));
        if (persisted) return persisted;
      }
      return localBuiltInTracks.get(selectionKey) ?? null;
    }

    function cacheSelectedBuiltInTrack(id, fallbackId, video) {
      if (!state.active || destroyed || video !== manager.current().video || id !== state.settings.secondTrackId) return;
      const generation = lifecycle;
      const selectionKey = `${state.settings.selectedPlayerKey}\u0000${id}`;
      if (!id || id.startsWith('external:') || cachedBuiltInSelections.has(selectionKey) || cachingBuiltInSelections.has(selectionKey)) return;
      if (state.settings.secondTrackCacheSource === selectionKey && state.settings.secondTrackCacheId) return;
      const track = builtInTrackResolver.find(video.textTracks, id, fallbackId);
      const cueCount = Number(track?.cues?.length);
      if (!Number.isInteger(cueCount) || !cueCount || cueCount > 5_000) return;
      const cues = [];
      const encoder = new TextEncoder();
      let serializedBytes = 2;
      for (let index = 0; index < cueCount; index += 1) {
        const cue = track.cues[index];
        if (String(cue?.text ?? '').length > 1_200) return;
        const normalized = {
          start: Number(cue?.startTime ?? cue?.start),
          end: Number(cue?.endTime ?? cue?.end),
          text: runtime.cleanSubtitleText(cue?.text),
        };
        if (!Number.isFinite(normalized.start) || !Number.isFinite(normalized.end) || normalized.end <= normalized.start || !normalized.text) continue;
        serializedBytes += encoder.encode(JSON.stringify(normalized)).byteLength + (cues.length ? 1 : 0);
        if (serializedBytes > 5 * 1024 * 1024) return;
        cues.push(normalized);
      }
      if (!cues.length || !globalThis.crypto?.randomUUID) return;
      cachingBuiltInSelections.add(selectionKey);
      const snapshotId = `builtin-cache-${globalThis.crypto.randomUUID()}`;
      const snapshot = {
        id: snapshotId,
        sourceType: 'builtin-cache',
        name: 'Сохранённые встроенные субтитры',
        cues,
        offsetSeconds: 0,
        timeScale: 1,
      };
      localBuiltInTracks.set(selectionKey, snapshot);
      sendMessage({
        type: MESSAGE.TRACK_CACHE_BUILTIN,
        sourceKey: selectionKey,
        track: snapshot,
      }).then((response) => {
        if (generation !== lifecycle) return;
        if (response?.ok === true) cachedBuiltInSelections.add(selectionKey);
        else throw new Error('Built-in subtitle cache was rejected');
      }).catch(() => {
        if (generation !== lifecycle || destroyed) return;
        const retries = (state.builtInCacheRetries?.get(selectionKey) ?? 0) + 1;
        state.builtInCacheRetries ??= new Map();
        state.builtInCacheRetries.set(selectionKey, retries);
        if (retries < 3) setTimeout(() => {
          if (generation === lifecycle) cacheSelectedBuiltInTrack(id, fallbackId, video);
        }, 1_000);
      }).finally(() => cachingBuiltInSelections.delete(selectionKey));
    }

    function renderInlineCaption(target, text, items, descriptor) {
      const segments = runtime.glossarySegments(text, items);
      const hiddenPinyinParticles = ['de', 'le', 'zhe', 'la'];
      if (!segments.some((segment) => segment.item)) return false;
      const sentenceItem = items.find((item) => item?.isSentenceTranslation && typeof item.dictionary === 'string');
      const sentenceText = sentenceItem?.dictionary.trim();
      if (sentenceText) {
        const sentenceTranslation = document.createElement('div');
        sentenceTranslation.className = 'dual-captions-sentence-translation';
        sentenceTranslation.textContent = sentenceText;
        sentenceTranslation.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:0 0 .18em;padding:0 .22em;color:inherit;text-align:center;font-size:.58em;font-weight:400;line-height:1.3;opacity:.88;white-space:normal;overflow-wrap:anywhere;pointer-events:none;';
        target.append(sentenceTranslation);
        state.sentenceTranslationLine = sentenceTranslation;
      }
      const cells = document.createElement('div');
      cells.className = 'dual-captions-inline';
      cells.style.cssText = 'display:block;text-align:center;text-wrap:balance;white-space:normal;';
      target.append(cells);
      let previousSource = null;
      let separated = true;
      for (const segment of segments) {
        const parts = segment.item ? [segment.text] : segment.text.split(/(\r?\n|[^\S\r\n]+)/);
        for (let part of parts) {
          if (/^\r?\n$/.test(part)) {
            const lineBreak = document.createElement('span');
            lineBreak.textContent = '\n';
            lineBreak.style.cssText = 'display:block;height:0;white-space:pre;';
            lineBreak.setAttribute('aria-hidden', 'true');
            cells.append(lineBreak);
            previousSource = null;
            separated = true;
            continue;
          }
          if (!part.trim()) {
            if (part) separated = true;
            continue;
          }
          // A straight quote after whitespace opens the next word, rather than
          // closing the preceding cell (e.g. He said "Hello").
          if (!segment.item && previousSource && !(separated && /^['"]/.test(part))) {
            const suffix = part.match(/^[,.;:!?，。；：！？…\)\]}'"”’»]+/u)?.[0];
            if (suffix) {
              previousSource.textContent += suffix;
              part = part.slice(suffix.length);
              if (!part) continue;
            }
          }
          if (previousSource && /^[\(\[{'"“‘«]+$/u.test(previousSource.textContent)) {
            part = previousSource.textContent + part;
            previousSource.parentElement.remove();
          }
          const cell = document.createElement('span');
          cell.style.cssText = 'display:inline-flex;vertical-align:bottom;flex-direction:column;align-items:center;min-width:0;width:max-content;max-width:calc(100% - .18em);box-sizing:border-box;margin:.12em .09em;padding:.12em .22em;border:1px solid rgba(255,255,255,.13);border-radius:6px;color:inherit;pointer-events:auto;cursor:pointer;overflow-wrap:anywhere;';
          const meaning = document.createElement('span');
          const displayedParticle = segment.text.trim().toLowerCase();
          const pinyinTerm = typeof segment.term?.pinyin === 'string' ? segment.term : null;
          const hidesParticleMeaning = hiddenPinyinParticles.includes(displayedParticle)
            && pinyinTerm;
          meaning.textContent = hidesParticleMeaning ? '' : segment.translation;
          meaning.title = '';
          meaning.style.cssText = `display:${hidesParticleMeaning ? 'none' : 'block'};width:100%;max-width:18em;font-size:.4em;font-weight:400;line-height:1.3;opacity:.8;margin-bottom:.2em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
          if (!hidesParticleMeaning) {
            meaning.addEventListener('mouseenter', () => showMeaningPreview(segment.translation, meaning));
            meaning.addEventListener('mouseleave', dismissMeaningPreview);
          }
          const source = document.createElement('span');
          source.textContent = part;
          previousSource = source;
          separated = false;
          source.style.cssText = 'display:block;max-width:100%;font:inherit;line-height:1.3;white-space:pre-wrap;overflow-wrap:anywhere;';
          cell.append(meaning, source);
          cell.tabIndex = 0;
          cell.setAttribute('role', 'button');
          makeCaptionFocusable(cell);
          const word = cellWord(segment, descriptor);
          const cellItem = {
            dictionary: segment.translation || 'Перевод этой ячейки пока отсутствует',
            isSentenceTranslation: true,
            isVocabularyCell: true,
            word,
          };
          cell.className = 'dual-captions-word-cell';
          cell.setAttribute('aria-label', `${segment.text}: ${cellItem.dictionary}`);
          state.wordCells.push({ cell, key: wordKey(word) });
          const show = () => showTooltip(cellItem, cell);
          cell.addEventListener('click', (event) => { event.stopPropagation(); show(); });
          cell.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); }
          });
          cells.append(cell);
          if (pinyinTerm && !hidesParticleMeaning && document.createRange) {
            const letterCount = [...segment.text.normalize('NFD')]
              .filter((character) => /\p{L}/u.test(character)).length;
            const growth = letterCount <= 2 ? 3 : letterCount === 3 ? 2 : letterCount === 4 ? 1.3 : 1.15;
            const range = document.createRange();
            range.selectNodeContents(source);
            const sourceWidth = range.getBoundingClientRect().width;
            if (sourceWidth > 0) meaning.style.maxWidth = `${Math.ceil(sourceWidth * growth)}px`;
          }
        }
      }
      state.inlineCells = cells;
      updateSavedWords();
      return true;
    }

    function renderInteractiveCaption(text) {
      const descriptor = translationDescriptor(text);
      const items = translationCache.get(descriptor.key);
      const failure = translationFailures.get(descriptor.key) || '';
      const key = `${state.settings.secondTrackId}\u0000${descriptor.key}\u0000${state.settings.inlineTranslations}\u0000${failure}`;
      if (state.renderedCaptionKey === key && state.renderedCaptionItems === items) return;
      state.renderedCaptionKey = key;
      state.renderedCaptionItems = items;
      state.wordCells = [];
      state.inlineCells = null;
      state.sentenceTranslationLine = null;
      state.characterLine = null;
      state.sentenceButton = null;
      state.sentenceCharacters = null;
      state.sentence = null;
      state.captionLayoutKey = '';
      dismissMeaningPreview();
      dismissTooltip();
      state.second.replaceChildren();
      state.second.scrollTop = 0;
      state.second.style.display = descriptor.displayText.trim() ? 'block' : 'none';
      if (!descriptor.displayText) {
        return;
      }
      let target = state.second;
      if (descriptor.characters) {
        target = document.createElement('div');
        target.style.cssText = 'pointer-events:auto;';
        const characters = document.createElement('div');
        characters.className = 'dual-captions-sentence-characters';
        characters.textContent = descriptor.characters;
        characters.style.cssText = 'margin-top:2px;color:inherit;font-size:.72em;font-weight:600;line-height:1.15;opacity:.68;pointer-events:none;';
        state.second.append(target, characters);
        state.characterLine = characters;
        state.sentenceCharacters = characters;
      }
      if (state.settings.inlineTranslations && items?.length) {
        if (renderInlineCaption(target, descriptor.displayText, items, descriptor)) {
          appendSentenceButton(descriptor, items);
          return;
        }
      }
      if (!items || !items.length) {
        renderPendingCaption(target, descriptor.displayText, descriptor, failure);
        appendSentenceButton(descriptor, items);
        if (!items && !failure) requestTranslation(descriptor, true);
        return;
      }
      for (const segment of runtime.captionSegments(descriptor.displayText, items)) {
        if (!segment.item) {
          target.append(document.createTextNode(segment.text));
          continue;
        }
        const phrase = document.createElement('span');
        phrase.textContent = segment.text;
        phrase.tabIndex = 0;
        phrase.setAttribute('role', 'button');
        phrase.style.cssText = 'pointer-events:auto;cursor:pointer;border-radius:4px;padding:0 2px;color:inherit;text-decoration:underline;text-decoration-color:rgba(174,199,255,.95);text-decoration-thickness:2px;text-underline-offset:3px;transition:background .14s,color .14s;';
        makeCaptionFocusable(phrase);
        phrase.addEventListener('click', (event) => { event.stopPropagation(); showTooltip(segment.item, phrase); });
        phrase.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showTooltip(segment.item, phrase); }
        });
        target.append(phrase);
      }
      appendSentenceButton(descriptor, items);
    }

    function restoreTrackMode(track) {
      if (originalTrackModes.has(track)) {
        track.mode = originalTrackModes.get(track);
        originalTrackModes.delete(track);
      }
    }

    function restoreModes(video) {
      if (!video?.textTracks) return;
      for (const track of video.textTracks) restoreTrackMode(track);
    }

    function selectedText(id, fallbackId, video) {
      if (!id) return '';
      if (id.startsWith('external:')) {
        const external = state.externalTracks.find((track) => `external:${track.id}` === id);
        return external
          ? runtime.cueTextAt(external.cues, video.currentTime, external.offsetSeconds, external.timeScale)
          : '';
      }
      const native = builtInTrackResolver.find(video.textTracks, id, fallbackId);
      const nativeText = runtime.activeCueText(native);
      if (nativeText) return nativeText;
      const cached = cachedBuiltInTrack(id);
      return cached ? runtime.cueTextAt(cached.cues, video.currentTime, cached.offsetSeconds, cached.timeScale) : '';
    }

    function overlayHost(video) {
      const fullscreenElement = document.fullscreenElement ?? document.webkitFullscreenElement;
      if (fullscreenElement && (fullscreenElement === video || fullscreenElement.contains?.(video))) {
        return fullscreenElement;
      }
      return document.documentElement;
    }

    function syncOverlayHost(video) {
      const host = overlayHost(video);
      if (state.root?.parentElement !== host) host.append(state.root);
    }

    function positionOverlay() {
      const { video } = manager.current();
      if (!video || !state.root) return;
      syncOverlayHost(video);
      const rect = video.getBoundingClientRect();
      state.root.style.left = `${rect.left}px`;
      state.root.style.top = `${rect.top}px`;
      state.root.style.width = `${rect.width}px`;
      state.root.style.height = `${rect.height}px`;
      state.root.style.display = state.active && rect.width && rect.height ? 'block' : 'none';
      applyCaptionPosition();
      positionDragHandle();
      positionMeaningPreview();
      positionTooltip();
    }

    function applyCaptionPosition() {
      const root = state.root.getBoundingClientRect();
      state.second.style.maxHeight = `${Math.max(0, root.height - 16)}px`;
      state.second.style.overflowY = 'auto';
      state.second.style.overscrollBehavior = 'contain';
      fitCaptionWidth(root);
      const caption = state.second.getBoundingClientRect();
      // Clamp presentation only; resizing must not overwrite the saved anchor.
      const left = Math.max(caption.width / 2 + 8,
        Math.min(root.width - caption.width / 2 - 8, root.width * state.settings.secondLeft / 100));
      const bottom = Math.max(8,
        Math.min(root.height - caption.height - 8, root.height * state.settings.secondBottom / 100));
      state.second.style.left = `${left}px`;
      state.second.style.bottom = `${bottom}px`;
    }

    function fitCaptionWidth(root) {
      const key = `${root.width}:${root.height}:${state.settings.fontSize}:${state.settings.subtitleBackground}`;
      if (state.captionLayoutKey === key) return;
      state.captionLayoutKey = key;
      state.second.style.width = 'max-content';
      if (!state.inlineCells || !document.createRange) return;
      const row = state.inlineCells.getBoundingClientRect();
      const inset = state.second.getBoundingClientRect().width - row.width;
      const boxes = Array.from(state.inlineCells.children, (cell) => cell.getBoundingClientRect()).filter((box) => box.width && box.height);
      if (!boxes.length) return;
      let contentWidth = Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left));
      if (state.sentenceTranslationLine) {
        const range = document.createRange();
        range.selectNodeContents(state.sentenceTranslationLine);
        contentWidth = Math.max(contentWidth, range.getBoundingClientRect().width);
      }
      if (state.characterLine) {
        const range = document.createRange();
        range.selectNodeContents(state.characterLine);
        contentWidth = Math.max(contentWidth, range.getBoundingClientRect().width);
      }
      // Balance at the available width, then trim unused sides. Keep cell margins
      // and rounding slack so the measured row does not acquire a new wrap.
      state.second.style.width = `${Math.ceil(Math.min(row.width, contentWidth + state.settings.fontSize * .18 + 2) + inset)}px`;
    }

    function positionDragHandle() {
      if (!state.root || !state.second || !state.dragHandle) return;
      const rootRect = state.root.getBoundingClientRect();
      const captionRect = state.second.getBoundingClientRect();
      const visible = state.second.style.display !== 'none';
      state.dragHandle.style.display = visible ? 'grid' : 'none';
      if (!visible || !rootRect.width || !rootRect.height) return;
      const left = Math.min(rootRect.width - 28, Math.max(0, captionRect.right - rootRect.left - 7));
      const top = Math.min(rootRect.height - 28, Math.max(0, captionRect.top - rootRect.top - 5));
      state.dragHandle.style.left = `${left}px`;
      state.dragHandle.style.top = `${top}px`;
    }

    function subtitleBackgroundStyle() {
      const color = state.settings.subtitleBackgroundColor;
      const red = Number.parseInt(color.slice(1, 3), 16);
      const green = Number.parseInt(color.slice(3, 5), 16);
      const blue = Number.parseInt(color.slice(5, 7), 16);
      return `rgba(${red}, ${green}, ${blue}, ${state.settings.subtitleBackgroundOpacity / 100})`;
    }

    function render() {
      const { video } = manager.current();
      if (!video || !state.active || destroyed) {
        if (state.root) state.root.style.display = 'none';
        return;
      }
      ensureOverlay();
      if (state.settings.inlineTranslations) syncWords();
      syncSentences();
      for (const track of video.textTracks) {
        if (track.kind === 'subtitles' || track.kind === 'captions') {
          if (!originalTrackModes.has(track)) originalTrackModes.set(track, track.mode);
          track.mode = 'hidden';
        }
      }
      const secondText = selectedText(
        state.settings.secondTrackId,
        state.settings.secondTrackFallbackId,
        video,
      );
      cacheSelectedBuiltInTrack(state.settings.secondTrackId, state.settings.secondTrackFallbackId, video);
      if (!state.drag) {
        renderInteractiveCaption(secondText);
        for (const text of futureCaptionTexts(state.settings.secondTrackId, state.settings.secondTrackFallbackId, video)) {
          requestTranslation(translationDescriptor(text));
        }
      }
      state.second.style.fontSize = `${state.settings.fontSize}px`;
      state.second.style.color = state.settings.subtitleColor;
      state.second.style.background = state.settings.subtitleBackground ? subtitleBackgroundStyle() : 'transparent';
      state.second.style.padding = state.settings.subtitleBackground ? '4px 20px 4px 8px' : '0 12px 0 0';
      positionOverlay();
    }

    function report(video, videoIndex) {
      let sourceName = '';
      try {
        sourceName = decodeURIComponent(new URL(video.currentSrc || video.src || '', location.href).pathname.split('/').pop() || '');
      } catch { /* source name stays empty */ }
      return sendMessage({
        type: MESSAGE.PLAYER_REPORT,
        player: {
          title: document.title,
          frameUrl: location.href,
          videoIndex,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          sourceName: sourceName.slice(0, 240),
          tracks: runtime.trackChoices(video.textTracks),
        },
      }).catch(() => ({ ok: false }));
    }

    const manager = runtime.createVideoManager({ report, render, trackRemoved: restoreTrackMode });
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(positionOverlay) : null;
    cleanup.push(() => resizeObserver?.disconnect());

    function discover() {
      const previous = manager.current().video;
      const result = manager.discover(document.querySelectorAll('video'));
      if (result?.video !== previous) {
        if (previous) restoreModes(previous);
        resizeObserver?.disconnect();
        if (result?.video) resizeObserver?.observe(result.video);
      }
      return result;
    }

    function handle(message) {
      if (message?.type === MESSAGE.PLAYER_DISCOVER) {
        const { video, index } = manager.current();
        return video && !destroyed ? report(video, index) : { ok: false };
      }
      if (message?.type === MESSAGE.CONTENT_FULL_STATE) {
        state.settings = runtime.normalizeSettings(message.settings);
        state.externalTracks = Array.isArray(message.externalTracks) ? message.externalTracks : [];
        state.active = true;
        // Reports restore state; reporting that restoration creates an endless handshake.
        if (!manager.current().video) discover();
        render();
        return { ok: true };
      }
      if (message?.type === MESSAGE.CONTENT_SETTINGS) {
        state.settings = runtime.normalizeSettings(message.settings);
        state.active = true;
        render();
        return { ok: true };
      }
      if (message?.type === MESSAGE.CONTENT_TRACKS) {
        state.settings = runtime.normalizeSettings(message.settings);
        state.externalTracks = Array.isArray(message.externalTracks) ? message.externalTracks : [];
        state.active = true;
        render();
        return { ok: true };
      }

      if (message?.type === MESSAGE.CONTENT_RESET) {
        cancelPendingWork();
        const { video } = manager.current();
        restoreModes(video);
        state.settings = runtime.normalizeSettings();
        state.externalTracks = [];
        state.active = false;
        state.renderedCaptionKey = '';
        state.renderedCaptionItems = null;
        state.wordCells = [];
        if (state.second) state.second.textContent = '';
        dismissTooltip();
        if (state.root) state.root.style.display = 'none';
        return { ok: true };
      }
      return undefined;
    }

    const messageListener = (message, _sender, reply) => {
      const result = handle(message);
      if (result?.then) {
        result.then(reply, () => reply({ ok: false }));
        return true;
      }
      if (result) reply(result);
    };
    chrome.runtime.onMessage.addListener(messageListener);
    cleanup.push(() => chrome.runtime.onMessage.removeListener(messageListener));

    const observer = new MutationObserver((records) => {
      if (runtime.mutationsAffectVideo(records, state.root)) discover();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    cleanup.push(() => observer.disconnect());

    for (const [target, type, listener, options] of [
      [window, 'resize', positionOverlay],
      [window, 'focus', () => { if (state.settings.inlineTranslations) syncWords(true); syncSentences(true); }],
      [window, 'scroll', positionOverlay, true],
      [document, 'fullscreenchange', positionOverlay],
      [document, 'webkitfullscreenchange', positionOverlay],
    ]) {
      target.addEventListener(type, listener, options);
      cleanup.push(() => target.removeEventListener(type, listener, options));
    }

    return {
      discover,
      handle,
      destroy() {
        destroyed = true;
        state.active = false;
        cancelPendingWork();
        restoreModes(manager.current().video);
        manager.destroy();
        for (const dispose of cleanup.splice(0).reverse()) dispose();
        dismissTooltip();
        state.root?.remove();
      },
    };
  }

  runtime.installController(globalThis, CONTROLLER_KEY, createController);
})();
