import './content-runtime.js';

const INDEX_KEY = 'subsAnywherePreparationIndexV1';
const JOB_PREFIX = 'subsAnywherePreparationV1:';
const VERSION = 1;
export const PREPARATION_CONCURRENCY = 10;
const runtime = globalThis.DualCaptionsContentRuntime;

function summary(job, trackId = '') {
  if (!job) return { status: 'idle', trackId, completed: 0, total: 0, error: '' };
  return {
    id: job.id, trackId: job.trackId, status: job.status,
    revision: job.revision || 0,
    completed: Object.keys(job.results).length, total: job.descriptors.length,
    error: job.error || '',
  };
}

async function digest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class TranslationPreparation {
  #storage;
  #configuration;
  #translate;
  #onUpdate;
  #heartbeat;
  #jobs = new Map();
  #ids = [];
  #loading;
  #writes = Promise.resolve();
  #running = new Map();
  #archive;
  #archiveChecked = new Set();
  #archiveErrors = new Map();
  #archiveReads = new Map();

  constructor(storage, { configuration, translate, onUpdate = () => {}, heartbeat = () => {}, archive }) {
    this.#storage = storage;
    this.#configuration = configuration;
    this.#translate = translate;
    this.#onUpdate = onUpdate;
    this.#heartbeat = heartbeat;
    this.#archive = archive;
  }

  initialize() {
    if (!this.#loading) this.#loading = this.#load();
    return this.#loading;
  }

  async #load() {
    const index = (await this.#storage.get(INDEX_KEY))[INDEX_KEY];
    this.#ids = Array.isArray(index) ? index.filter((id) => /^[a-f0-9]{64}$/.test(id)) : [];
    const saved = await this.#storage.get(this.#ids.map((id) => `${JOB_PREFIX}${id}`));
    for (const id of this.#ids) {
      const job = saved[`${JOB_PREFIX}${id}`];
      if (!job || !Array.isArray(job.descriptors) || !job.results || job.id !== id) continue;
      this.#jobs.set(id, job);
      // Never repeat an ambiguous paid request silently after worker interruption.
      if (job.status === 'running') await this.#update(job, () => ({
        status: 'paused', error: 'Подготовка прервана. Сохранённые переводы доступны; нажмите «Продолжить».',
      }), false);
    }
  }

  async #context(pageKey, track) {
    await this.initialize();
    if (!track?.id || !Array.isArray(track.cues) || !track.cues.length) return {};
    const config = await this.#configuration();
    if (!config?.provider || !config.model) return { config };
    const id = await digest([VERSION, pageKey, track.id, track.cues, config.provider, config.model]);
    if (this.#archive && !this.#archiveChecked.has(id)) {
      let pending = this.#archiveReads.get(id);
      if (!pending) {
        pending = this.#restoreArchive(id, pageKey, track, config).finally(() => this.#archiveReads.delete(id));
        this.#archiveReads.set(id, pending);
      }
      await pending;
    }
    return { id, config, job: this.#jobs.get(id) };
  }

  async #restoreArchive(id, pageKey, track, config) {
    let job = this.#jobs.get(id);
    try {
      const saved = await this.#archive.get(id);
      if (saved) {
        if (saved.id !== id || saved.pageKey !== pageKey || saved.trackId !== track.id
          || saved.provider !== config.provider || saved.model !== config.model
          || !Array.isArray(saved.descriptors) || !saved.results) throw new Error('Архив перевода не соответствует выбранным субтитрам');
        if (!job) {
          job = { ...saved, status: saved.status === 'running' ? 'paused' : saved.status };
          this.#jobs.set(id, job);
        } else {
          job.results = { ...saved.results, ...job.results };
          if (saved.status === 'ready') { job.status = 'ready'; job.error = ''; }
        }
      }
      if (job) {
        job.sourceTrack = this.#sourceTrack(track);
        const archived = await this.#archive.save(job);
        job.results = { ...archived.results, ...job.results };
        if (archived.status === 'ready') { job.status = 'ready'; job.error = ''; }
        if (job.error === this.#archiveErrors.get(id)) job.error = '';
        await this.#writeLocal(job);
      }
      this.#archiveErrors.delete(id);
      this.#archiveChecked.add(id);
    } catch (error) {
      if (!job) throw error;
      this.#archiveErrors.set(id, 'Копия есть в Chrome, но серверное сохранение не подтверждено. Проверьте локальный сервер.');
    }
  }

  #sourceTrack(track) {
    return {
      id: track.id, name: track.name || '', language: track.language || '',
      sourceType: track.sourceType || 'imported', sourceVideoId: track.sourceVideoId || '',
      cues: structuredClone(track.cues),
    };
  }

  #summary(job, trackId) {
    return { ...summary(job, trackId), backendSaved: Boolean(job && this.#archiveChecked.has(job.id)),
      error: job?.error || this.#archiveErrors.get(job?.id) || '' };
  }

  async status(pageKey, track) {
    const { job } = await this.#context(pageKey, track);
    return this.#summary(job, track?.id);
  }

  async payload(pageKey, track) {
    let job;
    try { ({ job } = await this.#context(pageKey, track)); }
    catch { return null; } // Backend outage must not hide the original captions.
    if (!job) return null;
    return this.#payload(job);
  }

  async lookup(pageKey, track, message) {
    const { job } = await this.#context(pageKey, track);
    if (!job) return null;
    const descriptor = job.descriptors.find((item) => item.sourceText === String(message.text || '').trim()
      && item.language === (message.language || '')
      && (item.generatedPinyin ? '' : item.displayText) === String(message.displayText || '').trim());
    return descriptor && job.results[descriptor.key]
      ? structuredClone(job.results[descriptor.key])
      : { items: [], pending: job.status !== 'ready' };
  }

  #payload(job) {
    return {
      ...this.#summary(job),
      entries: job.status === 'ready'
        ? job.descriptors.map((descriptor) => ({ key: descriptor.key, items: job.results[descriptor.key].items }))
        : [],
    };
  }

  async start(pageKey, track) {
    const context = await this.#context(pageKey, track);
    if (!context.id || !context.config?.hasApiKey) throw new Error('Сначала выберите субтитры и настройте сервис перевода');
    let job = this.#jobs.get(context.id);
    if (!job) {
      if (track.cues.length > 20_000) throw new Error('Слишком много строк для подготовки одного ролика');
      let start = Infinity;
      let end = -Infinity;
      for (const cue of track.cues) {
        start = Math.min(start, Number(cue.start));
        end = Math.max(end, Number(cue.end));
      }
      const texts = runtime.upcomingCueTexts(track.cues, start - 1, { seconds: end - start + 2, limit: 40_001, includeBoundaries: true });
      const descriptors = [...new Map(texts.map((text) => {
        const descriptor = runtime.captionTranslationDescriptor(text);
        return [descriptor.key, descriptor];
      })).values()];
      if (!descriptors.length || descriptors.length > 40_000) throw new Error('Не удалось подготовить полный список субтитров');
      if (descriptors.some((item) => item.sourceText.length > 500 || item.displayText.length > 500)) {
        throw new Error('Одна из реплик длиннее 500 символов. Нужна дорожка с более короткими репликами');
      }
      job = {
        id: context.id, pageKey, trackId: track.id,
        provider: context.config.provider, model: context.config.model,
        status: 'idle', error: '', descriptors, results: {},
        sourceTrack: this.#sourceTrack(track),
      };
      this.#jobs.set(job.id, job);
    }
    if (job.status === 'ready') return this.#summary(job);
    if (job.status !== 'running') await this.#update(job, () => ({ status: 'running', error: '' }));
    this.#launch(job);
    return this.#summary(job);
  }

  async pause(pageKey, track) {
    const { job } = await this.#context(pageKey, track);
    if (job?.status === 'running') {
      job.status = 'paused';
      await this.#update(job, () => ({ status: 'paused', error: '' }));
    }
    return this.#summary(job, track?.id);
  }

  async #writeLocal(job) {
    const ids = this.#ids.includes(job.id) ? this.#ids : [...this.#ids, job.id];
    await this.#storage.set({ [`${JOB_PREFIX}${job.id}`]: job, [INDEX_KEY]: ids });
    this.#ids = ids;
  }

  #update(job, updater, syncArchive = true) {
    const operation = this.#writes.then(async () => {
      const next = { ...job, ...updater(job), updatedAt: Date.now(), revision: (job.revision || 0) + 1 };
      await this.#writeLocal(this.#archive && syncArchive && next.status === 'ready'
        ? { ...next, status: 'paused', error: 'Ожидается подтверждение серверного сохранения' } : next);
      if (this.#archive && syncArchive) {
        try {
          const saved = await this.#archive.save(next);
          next.results = { ...saved.results, ...next.results };
          this.#archiveErrors.delete(job.id);
          this.#archiveChecked.add(job.id);
          await this.#writeLocal(next);
        } catch (error) {
          this.#archiveChecked.delete(job.id);
          this.#archiveErrors.set(job.id, 'Не удалось сохранить перевод на сервере. Готовые строки сохранены в Chrome.');
          Object.assign(job, next, { status: 'paused', error: this.#archiveErrors.get(job.id) });
          await this.#writeLocal(job);
          throw error;
        }
      }
      Object.assign(job, next);
      Promise.resolve().then(() => this.#onUpdate({ pageKey: job.pageKey, ...this.#payload(job) })).catch(() => undefined);
    });
    this.#writes = operation.catch(() => undefined);
    return operation;
  }

  #launch(job) {
    if (this.#running.has(job.id)) return;
    const inFlight = new Set();
    let stopAdmissions = false;
    const heartbeat = setInterval(() => { Promise.resolve().then(() => this.#heartbeat()).catch(() => undefined); }, 20_000);
    heartbeat.unref?.();
    const worker = async () => {
      while (job.status === 'running' && !stopAdmissions) {
        const config = await this.#configuration();
        if (job.status !== 'running' || stopAdmissions) return;
        if (config.provider !== job.provider || config.model !== job.model || !config.hasApiKey) {
          stopAdmissions = true;
          await this.#update(job, () => ({ status: 'paused', error: 'Настройки ИИ изменились. Верните прежнюю модель для продолжения.' }));
          return;
        }
        const descriptor = job.descriptors.find((item) => !Object.hasOwn(job.results, item.key) && !inFlight.has(item.key));
        if (!descriptor) return;
        inFlight.add(descriptor.key);
        try {
          const result = await this.#translate(descriptor);
          if (!Array.isArray(result?.items) || !result.items.length
            || !result.items.some((item) => item.isSentenceTranslation && typeof item.dictionary === 'string' && item.dictionary.trim())) {
            throw new Error('ИИ не вернул полный перевод реплики');
          }
          await this.#update(job, (current) => ({ results: { ...current.results, [descriptor.key]: result } }));
        } catch (error) {
          stopAdmissions = true;
          if (this.#archiveErrors.has(job.id)) return;
          await this.#update(job, () => ({ status: 'error', error: String(error?.message || 'Не удалось подготовить перевод').slice(0, 240) }));
          return;
        } finally {
          inFlight.delete(descriptor.key);
        }
      }
    };
    const work = Promise.all(Array.from({ length: PREPARATION_CONCURRENCY }, () => worker())).then(async () => {
      if (job.status === 'running' && Object.keys(job.results).length === job.descriptors.length) {
        await this.#update(job, () => ({ status: 'ready', error: '' }));
      }
    }).catch(() => {
      // A storage failure must never publish a false ready result.
      job.status = 'error';
      job.error = 'Не удалось сохранить подготовленный перевод. Повторите подготовку.';
    }).finally(() => {
      clearInterval(heartbeat);
      this.#running.delete(job.id);
      if (job.status === 'running') this.#launch(job);
    });
    this.#running.set(job.id, work);
  }
}
