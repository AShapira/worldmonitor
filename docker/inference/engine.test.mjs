import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceEngine, DEFAULT_STATE, validateSettings } from './engine.mjs';
import { createInferenceServer } from './server.mjs';
import { once } from 'node:events';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
class MemoryStore {
  values = new Map(); writes = []; fail = false;
  async get(k) { if (this.fail) throw new Error('offline'); return structuredClone(this.values.get(k) || null); }
  async put(k, v, ttl) { if (this.fail) throw new Error('offline'); this.values.set(k, structuredClone(v)); this.writes.push({ k, ttl }); }
  async jobs() { return [...this.values.entries()].filter(([k]) => k.startsWith('job:')).map(([, v]) => structuredClone(v)); }
}
async function fixture(options = {}) {
  const store = options.store || new MemoryStore(); const calls = []; let engine;
  const codex = {
    capabilities: async () => ({ account: { type: 'chatgpt', planType: 'plus' }, models: [
      { model: 'gpt-5.6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ], rateLimits: null }),
    complete: async opts => { calls.push(opts); return { text: 'Evidence-backed report [1]', model: opts.profile.model, provider: 'codex', finishReason: 'stop' }; },
    close() {}, login: async () => ({ loginId: 'login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' }), logout: async () => ({}),
    ...options.codex,
  };
  const unloaded = [];
  const ollama = { unload: async model => unloaded.push(model), models: async () => [{ name: 'qwen3.5:9b' }], complete: async () => { calls.push('ollama'); return { text: 'local', finishReason: 'stop' }; }, ...options.ollama };
  engine = new InferenceEngine({ store, codex, ollama, runReport: options.runReport || (async job => {
    const result = await engine.complete({ jobId: job.id, messages: [{ role: 'user', content: 'Dated source [1]: test evidence' }], report: true });
    return { brief: result.text, model: result.model, sources: [{ url: 'https://example.com/evidence' }] };
  }) });
  await engine.initialize();
  return { engine, store, calls, unloaded };
}
async function finished(engine, id) {
  for (let i = 0; i < 100; i++) { const job = await engine.getJob(id); if (['completed', 'failed', 'cancelled'].includes(job.status)) return job; await tick(); }
  throw new Error('Job never finished');
}
const request = { kind: 'country', input: { countryCode: 'IL' }, preset: 'routine' };

test('initial state reserves GPU and rejects unattended completion without provider calls', async t => {
  const { engine, calls, unloaded } = await fixture(); t.after(() => engine.close());
  assert.equal((await engine.getState()).gpu.unloaded, true); assert.deepEqual(unloaded, ['qwen3.5:9b']);
  await assert.rejects(engine.complete({ messages: [{ role: 'user', content: 'auto' }] }), /Automatic AI is paused/);
  assert.equal(calls.length, 0);
});
test('explicit report captures evidence, profile, final result and 24-hour storage', async t => {
  const { engine, store } = await fixture(); t.after(() => engine.close());
  const job = await engine.submit(request); const result = await finished(engine, job.id);
  assert.equal(result.status, 'completed'); assert.equal(result.profile.effort, 'low'); assert.equal(result.result.model, 'gpt-5.6-luna');
  assert.equal(result.evidence, undefined);
  const saved = await store.get('job:' + job.id); assert.match(saved.evidence[0].messages[0].content, /Dated source/);
  assert.ok(store.writes.filter(w => w.k.startsWith('job:')).every(w => w.ttl === 86400));
});
test('model and effort mismatch fails before admission and never substitutes', async t => {
  const { engine, calls } = await fixture(); t.after(() => engine.close());
  await assert.rejects(engine.submit({ ...request, overrides: { model: 'missing' } }), /unavailable/);
  await assert.rejects(engine.submit({ ...request, overrides: { effort: 'max' } }), /unavailable/);
  assert.equal(calls.length, 0); assert.equal(engine.active.size, 0);
});
test('one completion at a time, two waiting jobs, fourth request rejected', async t => {
  const block = deferred(); let running = 0; let peak = 0;
  const { engine, calls } = await fixture({ codex: { complete: async () => { running++; peak = Math.max(peak, running); await block.promise; running--; return { text: 'done', finishReason: 'stop' }; } } });
  t.after(() => { block.resolve(); engine.close(); });
  const jobs = await Promise.all([engine.submit(request), engine.submit(request), engine.submit(request)]);
  await tick(); assert.equal(running, 1);
  await assert.rejects(engine.submit(request), /queue is full/);
  block.resolve(); await Promise.all(jobs.map(j => finished(engine, j.id)));
  assert.equal(peak, 1); assert.equal(calls.length, 0);
});
test('cancelling a queued job never starts it or lets later work overtake running work', async t => {
  const block = deferred(); let count = 0;
  const { engine } = await fixture({ codex: { complete: async () => { count++; if (count === 1) await block.promise; return { text: 'done', finishReason: 'stop' }; } } });
  t.after(() => { block.resolve(); engine.close(); });
  const a = await engine.submit(request); const b = await engine.submit(request); const c = await engine.submit(request);
  await tick(); await engine.cancel(b.id); await tick(); assert.equal(count, 1);
  block.resolve(); await finished(engine, a.id); await finished(engine, c.id);
  assert.equal(count, 2); assert.equal((await engine.getJob(b.id)).status, 'cancelled');
});
test('important budget is five minutes and settings cannot change its snapshot', async t => {
  const block = deferred(); const { engine } = await fixture({ runReport: () => block.promise });
  t.after(() => { block.resolve({}); engine.close(); });
  const job = await engine.submit({ ...request, preset: 'important' });
  assert.equal(job.deadlineAt - job.createdAt, 300000); assert.equal(job.profile.model, 'gpt-6-astra');
  const changed = structuredClone(DEFAULT_STATE); changed.presets.important.model = 'changed';
  await engine.updateSettings(changed);
  assert.equal((await engine.getJob(job.id)).profile.model, 'gpt-6-astra');
  assert.equal((await engine.getJob(job.id)).status, 'preparing');
});
test('policy-storage outage fails closed', async t => {
  const { engine, store, calls } = await fixture(); t.after(() => engine.close()); store.fail = true;
  await assert.rejects(engine.complete({ messages: [{ role: 'user', content: 'data' }] }), /offline/); assert.equal(calls.length, 0);
});
test('restart marks unfinished jobs interrupted, preserves reservation, and never retries', async t => {
  const store = new MemoryStore(); await store.put('job:old', { id: 'old', status: 'running', createdAt: 1 });
  const { engine, calls } = await fixture({ store }); t.after(() => engine.close());
  assert.equal((await engine.getJob('old')).status, 'interrupted'); assert.equal(calls.length, 0);
});
test('unload failure keeps reservation and blocks automatic inference', async t => {
  const { engine } = await fixture({ ollama: { unload: async () => { throw new Error('offline'); } } }); t.after(() => engine.close());
  const state = await engine.getState(); assert.equal(state.gpu.reserved, true); assert.equal(state.gpu.unloaded, false); assert.match(state.gpu.error, /not be verified/);
  await assert.rejects(engine.complete({ messages: [{ role: 'user', content: 'auto' }] }), /paused/);
});
test('Local restores automatic inference without hosted fallback', async t => {
  const { engine, calls } = await fixture(); t.after(() => engine.close());
  await engine.updateSettings({ ...structuredClone(DEFAULT_STATE), mode: 'local' });
  assert.equal((await engine.complete({ messages: [{ role: 'user', content: 'auto' }] })).text, 'local');
  assert.deepEqual(calls, ['ollama']);
});
test('failed generation without a successful completion is not a completed report', async t => {
  const { engine } = await fixture({ runReport: async () => ({ brief: '' }) }); t.after(() => engine.close());
  const job = await engine.submit(request); assert.equal((await finished(engine, job.id)).status, 'failed');
});
test('settings enforce provider-specific effort and fixed time budgets', () => {
  const state = structuredClone(DEFAULT_STATE); state.presets.important.timeoutMs = 999999;
  assert.equal(validateSettings(state).presets.important.timeoutMs, 300000);
  state.presets.local.effort = 'max'; assert.throws(() => validateSettings(state), /Local effort/);
});
test('broker requires server credential, rejects browser Origin and raw Codex methods', async t => {
  const { engine } = await fixture(); const token = 'a'.repeat(32); const server = createInferenceServer(engine, token);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { engine.close(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/state')).status, 401);
  assert.equal((await fetch(url + '/state', { headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost' } })).status, 401);
  assert.equal((await fetch(url + '/state', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(url + '/account/rateLimitResetCredit/consume', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test('reservation unloads a local report override across restart', async t => {
  const { engine, store, unloaded } = await fixture({ ollama: { models: async () => [{ name: 'qwen3.5:9b' }, { name: 'other:9b' }] } });
  t.after(() => engine.close());
  await engine.updateSettings({ ...structuredClone(DEFAULT_STATE), mode: 'local' });
  const job = await engine.submit({ ...request, preset: 'local', overrides: { model: 'other:9b' } });
  await finished(engine, job.id);
  assert.ok((await store.get('state')).ownedLocalModels.includes('other:9b'));
  await engine.updateSettings(DEFAULT_STATE);
  assert.ok(unloaded.includes('other:9b'));
  engine.close();
  const restarted = await fixture({ store }); t.after(() => restarted.engine.close());
  assert.ok(restarted.unloaded.includes('other:9b'));
});
test('queued deadline expiration never invokes the provider', async t => {
  const block = deferred(); let count = 0;
  const { engine } = await fixture({ codex: { complete: async () => { count++; await block.promise; return { text: 'done' }; } } });
  t.after(() => { block.resolve(); engine.close(); });
  const first = await engine.submit(request);
  engine.state.presets.routine.timeoutMs = 25;
  const second = await engine.submit(request);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await finished(engine, second.id)).status, 'failed');
  assert.match((await engine.getJob(second.id)).error, /deadline/);
  assert.equal(count, 1);
  block.resolve(); await finished(engine, first.id);
});
test('subscription failures survive native-handler degradation without fallback', async t => {
  const { engine, calls } = await fixture({ codex: { complete: async () => { throw Object.assign(new Error('Codex subscription allowance exhausted.'), { inferenceSafe: true }); } } });
  t.after(() => engine.close());
  const job = await engine.submit(request);
  assert.match((await finished(engine, job.id)).error, /allowance exhausted/);
  assert.equal(calls.length, 0);
});

test('graceful shutdown preserves interruption instead of mislabeling it as a deadline', async () => {
  const { engine } = await fixture({ runReport: async (_job, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('connection closed')), { once: true });
  }) });
  const job = await engine.submit(request); await tick(); engine.close();
  await tick();
  const interrupted = await engine.getJob(job.id);
  assert.equal(interrupted.status, 'interrupted'); assert.match(interrupted.error, /Service stopped/);
});
