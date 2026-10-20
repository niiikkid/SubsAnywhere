import './content-runtime.js';

const INDEX_KEY = 'subsAnywherePreparationIndexV1';
const JOB_PREFIX = 'subsAnywherePreparationV1:';
const VERSION = 1;
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

  constructor(storage, { configuration, translate, onUpdate = () => {}, heartbeat = () => {} }) {
    this.#storage = storage;
    this.#configuration = configuration;
    this.#translate = translate;
    this.#onUpdate = onUpdate;
    this.#heartbeat = heartbeat;
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
      }));
    }
  }

  async #context(pageKey, track) {
    await this.initialize();
    if (!track?.id || !Array.isArray(track.cues) || !track.cues.length) return {};
    const config = await this.#configuration();
    if (!config?.provider || !config.model) return { config };
    const id = await digest([VERSION, pageKey, track.id, track.cues, config.provider, config.model]);
    return { id, config, job: this.#jobs.get(id) };
  }

  async status(pageKey, track) {
    const { job } = await this.#context(pageKey, track);
    return summary(job, track?.id);
  }

  async payload(pageKey, track) {
    const { job } = await this.#context(pageKey, track);
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
      ...summary(job),
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
      };
      this.#jobs.set(job.id, job);
    }
    if (job.status === 'ready') return summary(job);
    if (job.status !== 'running') await this.#update(job, () => ({ status: 'running', error: '' }));
    this.#launch(job);
    return summary(job);
  }

  async pause(pageKey, track) {
    const { job } = await this.#context(pageKey, track);
    if (job?.status === 'running') await this.#update(job, () => ({ status: 'paused', error: '' }));
    return summary(job, track?.id);
  }

  #update(job, updater) {
    const operation = this.#writes.then(async () => {
      const next = { ...job, ...updater(job), updatedAt: Date.now(), revision: (job.revision || 0) + 1 };
      const ids = this.#ids.includes(job.id) ? this.#ids : [...this.#ids, job.id];
      await this.#storage.set({ [`${JOB_PREFIX}${job.id}`]: next, [INDEX_KEY]: ids });
      this.#ids = ids;
      Object.assign(job, next);
      Promise.resolve().then(() => this.#onUpdate({ pageKey: job.pageKey, ...this.#payload(job) })).catch(() => undefined);
    });
    this.#writes = operation.catch(() => undefined);
    return operation;
  }

  #launch(job) {
    if (this.#running.has(job.id)) return;
    const inFlight = new Set();
    const heartbeat = setInterval(() => { Promise.resolve().then(() => this.#heartbeat()).catch(() => undefined); }, 20_000);
    heartbeat.unref?.();
    const worker = async () => {
      while (job.status === 'running') {
        const config = await this.#configuration();
        if (job.status !== 'running') return;
        if (config.provider !== job.provider || config.model !== job.model || !config.hasApiKey) {
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
          await this.#update(job, () => ({ status: 'error', error: String(error?.message || 'Не удалось подготовить перевод').slice(0, 240) }));
          return;
        } finally {
          inFlight.delete(descriptor.key);
        }
      }
    };
    const work = Promise.all([worker(), worker()]).then(async () => {
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
