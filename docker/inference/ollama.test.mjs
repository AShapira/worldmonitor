import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaClient } from './ollama.mjs';

test('reserving GPU unloads only the owned model and verifies absence', async () => {
  let models = [{ name: 'qwen3.5:9b' }, { name: 'another-task:latest' }]; const calls = [];
  const client = new OllamaClient('http://controlled', async (url, options) => {
    calls.push({ path: url.pathname, body: options.body && JSON.parse(options.body) });
    if (url.pathname === '/api/ps') return Response.json({ models });
    assert.equal(url.pathname, '/api/generate');
    assert.deepEqual(JSON.parse(options.body), { model: 'qwen3.5:9b', keep_alive: 0 });
    models = models.filter(model => model.name !== 'qwen3.5:9b'); return Response.json({ done: true });
  });
  await client.unload('qwen3.5:9b');
  assert.deepEqual(models, [{ name: 'another-task:latest' }]);
  assert.equal(calls.at(-1).path, '/api/ps');
  calls.length = 0; await client.unload('qwen3.5:9b');
  assert.ok(calls.every(call => call.path === '/api/ps'), 'checking an unloaded model must not load it');
});
test('balanced Ollama recovers incomplete reasoning with a bounded final-answer attempt', async () => {
  let attempts = 0;
  const client = new OllamaClient('http://controlled', async () => Response.json({ model: 'qwen3.5:9b', choices: [{ finish_reason: 'stop',
    message: { content: ++attempts === 1 ? '<think>unfinished private notes' : '```json\n{"report":"Grounded [1]"}\n```' } }] }));
  const result = await client.complete({ messages: [{ role: 'user', content: 'Evidence [1]' }], profile: { model: 'qwen3.5:9b', effort: 'balanced' },
    report: true, signal: new AbortController().signal, deadlineAt: Date.now() + 90000 });
  assert.equal(attempts, 2); assert.equal(result.text, '{"report":"Grounded [1]"}'); assert.equal(result.effort, 'off');
});
test('cancelled Ollama reports never begin or recover inference', async () => {
  const controller = new AbortController(); controller.abort();
  const client = new OllamaClient('http://controlled', async () => assert.fail('no inference after cancellation'));
  assert.equal(await client.complete({ messages: [], profile: { effort: 'balanced' }, report: true,
    signal: controller.signal, deadlineAt: Date.now() + 90000 }), null);
});
