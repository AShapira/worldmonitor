import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { InferenceEngine } from '../docker/inference/engine.mjs';
import { RedisStore } from '../docker/inference/store.mjs';
import { createInferenceServer } from '../docker/inference/server.mjs';
import { proxyLocalAi, runLocalAiReport } from '../src-tauri/sidecar/local-ai.mjs';
import { generateWorkerReport } from '../scripts/_local-ai-reports.mjs';

// A complete explicit job traverses the browser proxy, broker, report callback,
// existing weekly generator, managed transport, and Redis REST serialization.
// All evidence/providers/storage are controlled; there are no external calls.
test('explicit weekly report traverses HTTP policy and records sources and actual model', async t => {
  const token = 'controlled-private-token-'.repeat(2);
  const values = new Map(); const ttls = []; const servers = [];
  const listen = async server => {
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const previous = Object.fromEntries(['WM_INFERENCE_URL', 'WM_INFERENCE_TOKEN', 'WM_INFERENCE_ENABLED'].map(k => [k, process.env[k]]));
  let engine;
  t.after(() => {
    engine?.close(); for (const server of servers) { server.closeAllConnections(); server.close(); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const redisUrl = await listen(createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const [op, key, value, expiry, ttl] = JSON.parse(raw);
    let result;
    if (op === 'GET') result = values.get(key) ?? null;
    else if (op === 'SET') { values.set(key, value); if (expiry) ttls.push(ttl); result = 'OK'; }
    else if (op === 'SCAN') result = ['0', [...values.keys()].filter(k => k.includes(':job:'))];
    else assert.fail(`unexpected Redis command ${op}`);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
  }));
  const snapshot = { generated_at: 123, evidence: [{ id: 'e1', source: 'Port authority', summary: 'Observed port closure', observed_at: 99, url: 'https://example.com/port' }] };
  const callbackUrl = await listen(createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const response = await runLocalAiReport(JSON.parse(raw), { runWorker: (kind, input) => generateWorkerReport(kind, input, {
      readRedis: async cmd => cmd[0] === 'LRANGE' ? [] : cmd[1].endsWith(':latest') ? 'snapshot-id' : JSON.stringify(snapshot),
    }) });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  }));
  const calls = [];
  const codex = {
    capabilities: async () => ({ account: { type: 'chatgpt' }, models: [{ model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }),
    close() {}, complete: async options => {
      calls.push(options);
      assert.match(options.messages[1].content, /Observed port closure/);
      assert.equal(options.profile.model, 'gpt-6-astra'); assert.equal(options.profile.effort, 'high');
      return { text: JSON.stringify({ situation_recap: 'Port closure [1].', regime_trajectory: 'Limited observation [1].',
        key_developments: ['Observed closure [1].'], risk_outlook: 'Monitor the port [1].' }),
      model: options.profile.model, provider: 'codex', effort: options.profile.effort, finishReason: 'stop' };
    },
  };
  engine = new InferenceEngine({ store: new RedisStore(redisUrl, token), codex,
    ollama: { unload: async () => {}, models: async () => [], complete: async () => assert.fail('GPU must remain reserved') },
    runReport: async (job, signal) => {
      const response = await fetch(callbackUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(job), signal });
      assert.equal(response.status, 200); return response.json();
    } });
  await engine.initialize();
  const brokerUrl = await listen(createInferenceServer(engine, token));
  Object.assign(process.env, { WM_INFERENCE_URL: brokerUrl, WM_INFERENCE_TOKEN: token, WM_INFERENCE_ENABLED: '1' });
  const proxy = (suffix, method = 'GET', body = {}) => proxyLocalAi(new URL(`http://localhost:3000/api/local-ai${suffix}`),
    { method, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' } },
    { readBody: async () => Buffer.from(JSON.stringify(body)) });
  for (let i = 0; i < 3; i++) { assert.equal((await proxy('/state')).status, 200); assert.equal((await proxy('/jobs')).status, 200); }
  assert.equal(calls.length, 0);
  const response = await proxy('/jobs', 'POST', { kind: 'weekly', input: { regionId: 'mena' }, preset: 'important' });
  assert.equal(response.status, 200); const created = await response.json();
  let job;
  for (let i = 0; i < 100; i++) {
    job = await engine.getJob(created.id);
    if (['completed', 'failed'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(job.status, 'completed', job.error); assert.equal(calls.length, 1);
  assert.deepEqual(job.actual, { provider: 'codex', model: 'gpt-6-astra', effort: 'high' });
  assert.equal(job.result.sources[0].url, 'https://example.com/port'); assert.equal(job.result.sourceGeneratedAt, 123);
  assert.ok(ttls.length > 0 && ttls.every(ttl => ttl === 86400));
  const saved = JSON.parse(values.get(`wm:inference:v1:job:${job.id}`));
  assert.match(saved.evidence[0].messages[1].content, /Observed port closure/);
});
