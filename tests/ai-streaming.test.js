import test from 'node:test';
import assert from 'node:assert/strict';
import { AIClient } from '../ai-client.js';

const credential = (provider) => ({ getActive: async () => ({ provider, apiKey: 'offline-fixture', model: provider === 'openai' ? 'gpt-5-mini' : 'deepseek-chat' }) });
const json = JSON.stringify({ translation: 'Привет, мир!', glossary: [] });
const sse = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function streamed(value) {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + 7));
    offset = Math.min(offset + 7, bytes.length);
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('OpenAI streams fragmented UTF-8 and publishes only a completed response', async () => {
  let request;
  const client = new AIClient(async (_url, options) => {
    request = options;
    return streamed(sse({ type: 'response.created' })
      + sse({ type: 'response.output_text.delta', delta: json.slice(0, 20) })
      + sse({ type: 'response.output_text.delta', delta: json.slice(20) })
      + sse({ type: 'response.completed', response: { status: 'completed', output_text: json } }));
  }, credential('openai'));
  const result = await client.translateCaption('Hello world');
  assert.equal(result.translation, 'Привет, мир!');
  assert.equal(request.signal, undefined);
  assert.equal(JSON.parse(request.body).stream, true);
});

test('DeepSeek streams content deltas until DONE without changing output parsing', async () => {
  const client = new AIClient(async () => streamed(
    ': keep-alive\r\n\r\n'
    + sse({ choices: [{ delta: { content: json.slice(0, 21) }, finish_reason: null }] })
    + sse({ choices: [{ delta: { content: json.slice(21) }, finish_reason: 'stop' }] })
    + 'data: [DONE]\r\n\r\n',
  ), credential('deepseek'));
  assert.equal((await client.translateCaption('Hello world')).translation, 'Привет, мир!');
});

for (const terminal of ['response.incomplete', 'response.failed', 'error', 'disconnect']) {
  test(`OpenAI never caches a plausible JSON answer after ${terminal}`, async () => {
    const client = new AIClient(async () => streamed(
      sse({ type: 'response.output_text.delta', delta: json })
      + (terminal === 'disconnect' ? '' : sse({ type: terminal })),
    ), credential('openai'));
    await assert.rejects(() => client.translateCaption('Hello'), /не завершил|прервал соединение/);
  });
}

test('DeepSeek truncated output is not accepted as a complete translation', async () => {
  const client = new AIClient(async () => streamed(sse({ choices: [{ delta: { content: json }, finish_reason: 'length' }] })
    + 'data: [DONE]\n\n'), credential('deepseek'));
  await assert.rejects(() => client.translateCaption('Hello'), /не завершил/);
});

test('a simulated 60-second OpenAI answer is not aborted and heartbeat stops on completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const previousChrome = globalThis.chrome;
  let heartbeats = 0;
  let request;
  globalThis.chrome = { runtime: { getPlatformInfo: async () => { heartbeats += 1; } } };
  try {
    const client = new AIClient(async (_url, options) => {
      request = options;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(sse({ type: 'response.created' })));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(sse({ type: 'response.completed', response: { status: 'completed', output_text: json } })));
          controller.close();
        }, 60_000);
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }, credential('openai'));
    const pending = client.translateCaption('Hello');
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    assert.equal(request.signal, undefined);
    t.mock.timers.tick(60_000);
    assert.equal((await pending).translation, 'Привет, мир!');
    assert.ok(heartbeats > 0);
    const count = heartbeats;
    t.mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(heartbeats, count);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
