import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SPEECH_SETTINGS,
  SPEECH_STORAGE_KEY,
  SpeechService,
  normalizeSpeechRate,
  normalizeSpeechSettings,
  normalizeSpeechVoiceName,
  selectSpeechVoice,
} from '../speech-service.js';

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) { return { [key]: structuredClone(values[key]) }; },
    async set(patch) { Object.assign(values, structuredClone(patch)); },
  };
}

test('speech rate stays in the useful learning range', () => {
  assert.equal(normalizeSpeechRate(0.7), 0.7);
  assert.equal(normalizeSpeechRate(0.1), 0.5);
  assert.equal(normalizeSpeechRate(4), 1);
  assert.equal(normalizeSpeechRate('bad'), DEFAULT_SPEECH_SETTINGS.rate);
  assert.equal(normalizeSpeechVoiceName('  Tingting  '), 'Tingting');
  assert.deepEqual(normalizeSpeechSettings({ rate: 0.55, voiceName: ' Tingting ' }), { rate: 0.55, voiceName: 'Tingting' });
});

test('Chinese speech prefers Google voices and ignores unreliable alternatives', () => {
  const voices = [
    { voiceName: 'Grandma (Китайский)', lang: 'zh-CN' },
    { voiceName: 'Tingting', lang: 'zh_CN' },
    { voiceName: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
    { voiceName: 'Meijia', lang: 'zh-TW' },
  ];
  assert.equal(selectSpeechVoice(voices, 'zh-CN'), 'Google 普通话（中国大陆）');
  assert.equal(selectSpeechVoice(voices, 'zh-CN', 'Grandma (Китайский)'), 'Google 普通话（中国大陆）');
});

test('speech settings persist globally and are used for Chinese system speech', async () => {
  const calls = [];
  const storage = memoryStorage();
  const chrome = {
    runtime: { lastError: null },
    tts: {
      getVoices(callback) {
        callback([
          { voiceName: 'Eddy (Chinese)', lang: 'zh-CN' },
          { voiceName: 'Tingting', lang: 'zh-CN' },
          { voiceName: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
        ]);
      },
      speak(text, options, callback) {
        calls.push({ text, options });
        callback();
      },
    },
  };
  const service = new SpeechService(chrome, storage);

  assert.deepEqual(await service.getSettings(), DEFAULT_SPEECH_SETTINGS);
  assert.deepEqual(await service.getVoiceOptions(), [
    { voiceName: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
  ]);
  assert.deepEqual(await service.patchSettings({ rate: 0.55, voiceName: 'Google 普通话（中国大陆）' }), { rate: 0.55, voiceName: 'Google 普通话（中国大陆）' });
  assert.deepEqual(storage.values[SPEECH_STORAGE_KEY], { rate: 0.55, voiceName: 'Google 普通话（中国大陆）' });
  assert.deepEqual(await service.speak({ text: '你好', language: 'zh' }), { language: 'zh', rate: 0.55, voiceName: 'Google 普通话（中国大陆）' });
  assert.deepEqual(calls, [{
    text: '你好',
    options: { lang: 'zh-CN', rate: 0.55, enqueue: false, voiceName: 'Google 普通话（中国大陆）' },
  }]);
});

test('speech rejects empty text and unsupported languages before calling Chrome', async () => {
  let calls = 0;
  const service = new SpeechService({
    runtime: {},
    tts: { speak() { calls += 1; } },
  }, memoryStorage());

  await assert.rejects(service.speak({ text: '', language: 'zh' }), /Некорректный текст/);
  await assert.rejects(service.speak({ text: 'bonjour', language: 'fr' }), /Язык произношения/);
  assert.equal(calls, 0);
});
