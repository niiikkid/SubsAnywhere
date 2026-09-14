import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient } from '../ai-client.js';

const credentials = { get: async () => ({ apiKey: 'test-only', model: 'deepseek-v4-flash' }) };

test('DeepSeek bounds network waits, omits cookies and refuses redirects', async () => {
  let options;
  const client = new DeepSeekClient(async (_url, request) => {
    options = request;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"translation":"Привет","glossary":[]}' } }] }));
  }, credentials);
  await client.translateCaption('Hello');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
});

test('DeepSeek failures are actionable without leaking upstream response bodies', async () => {
  const client = new DeepSeekClient(async () => new Response('sensitive-upstream-detail', { status: 429 }), credentials);
  await assert.rejects(() => client.translateCaption('Hello'), (error) => {
    assert.match(error.message, /лимит.*позже/i);
    assert.doesNotMatch(error.message, /sensitive-upstream-detail/);
    return true;
  });
});

test('DeepSeek connection failures explain the retry without exposing transport details', async () => {
  const client = new DeepSeekClient(async () => { throw new TypeError('internal-transport-detail'); }, credentials);
  await assert.rejects(() => client.translateCaption('Hello'), /Не удалось связаться с DeepSeek/);
});
