import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportRequest, hasInferenceAuth, inferenceRequestTimeout, proxyLocalAi, runLocalAiReport, validateRun } from './local-ai.mjs';

const env = { WM_INFERENCE_URL: 'http://inference:8090', WM_INFERENCE_TOKEN: 'broker-secret' };
const body = (id = 'job-1', kind = 'country') => ({ id, kind, input: { countryCode: 'IL' },
  profile: { provider: 'codex', model: 'powerful', effort: 'high' }, deadlineAt: Date.now() + 300000 });

test('broker authentication never accepts the browser transport credential', () => {
  assert.equal(hasInferenceAuth({ authorization: 'Bearer browser-token' }, env), false);
  assert.equal(hasInferenceAuth({ 'x-worldmonitor-local-token': 'broker-secret' }, env), false);
  assert.equal(hasInferenceAuth({ authorization: 'Bearer broker-secret' }, env), true);
  assert.equal(hasInferenceAuth({ authorization: 'Bearer broker-secret' }, { WM_INFERENCE_TOKEN: 'broker-secret' }), false);
  assert.equal(hasInferenceAuth({}, env), false);
});

test('report requests map the native RPC methods and fields without forwarding private controls', async () => {
  const country = buildReportRequest('country', { countryCode: 'IL', model: 'injected' }, 1234);
  assert.equal(country.method, 'GET');
  assert.equal(new URL(country.url).searchParams.get('country_code'), 'IL');
  assert.equal(new URL(country.url).searchParams.has('model'), false);
  const situation = buildReportRequest('situation', { query: 'What changed?', geoContext: 'Linked evidence' }, 1234);
  assert.equal(situation.method, 'POST');
  assert.equal((await situation.json()).geoContext, 'Linked evidence');
  const stock = buildReportRequest('stock', { symbol: 'MSFT' }, 1234);
  assert.equal(new URL(stock.url).searchParams.get('include_news'), 'true');
});

test('invalid jobs and expired/unbounded deadlines cannot create inference context', () => {
  assert.equal(validateRun(body()), true);
  assert.equal(validateRun({ ...body(), deadlineAt: Date.now() - 1 }), false);
  assert.equal(validateRun({ ...body(), deadlineAt: Date.now() + 600000 }), false);
  assert.equal(validateRun({ ...body(), kind: 'shell' }), false);
  assert.equal(validateRun({ ...body(), input: { countryCode: '../secrets' } }), false);
});

test('parallel report preparation isolates immutable model contexts, preserving important deadlines', async () => {
  const contexts = [];
  const invoke = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const ctx = globalThis[Symbol.for('worldmonitor.inference.context')]();
    assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.profile));
    assert.ok(inferenceRequestTimeout(100000) > 290000);
    contexts.push(ctx.id);
    return Response.json({ brief: 'Grounded report [1]', model: ctx.profile.model, sources: [{ url: 'https://example.com' }] });
  };
  const responses = await Promise.all([runLocalAiReport(body('first'), { invoke }), runLocalAiReport(body('second'), { invoke })]);
  assert.deepEqual(contexts.sort(), ['first', 'second']);
  assert.ok(responses.every((r) => r.ok));
  assert.equal(globalThis[Symbol.for('worldmonitor.inference.context')](), undefined);
  assert.equal(inferenceRequestTimeout(12000), 12000);
});

test('empty native successes and failed output validators become failed jobs', async () => {
  const response = await runLocalAiReport(body(), { invoke: async () => Response.json({ brief: '', model: '', sources: [] }) });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'invalid_report_output');
  const unavailable = await runLocalAiReport(body('stock', 'stock'), { invoke: async () => { throw new Error('secret'); } });
  assert.equal(unavailable.status, 400);
});

test('worker errors expose only bounded error codes, never provider details or credentials', async () => {
  const request = { ...body('worker', 'daily'), input: {} };
  const response = await runLocalAiReport(request, { runWorker: async () => { throw new Error('Bearer secret'); } });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'report_generation_failed' });
});

test('local proxy allowlists paths and methods, enforces same-origin JSON, and substitutes broker auth', async () => {
  const calls = [];
  const deps = { env, readBody: async () => Buffer.from('{}'), fetch: async (url, init) => {
    calls.push({ url, init }); return Response.json({ mode: 'reserved' });
  } };
  const req = { method: 'PUT', headers: { host: 'localhost:3000', origin: 'http://localhost:3000',
    'content-type': 'application/json', authorization: 'Bearer browser-token' } };
  const response = await proxyLocalAi(new URL('http://localhost:3000/api/local-ai/state'), req, deps);
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'http://inference:8090/state');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer broker-secret');
  for (const endpoint of ['/run', '/complete', '/auth/../../complete', '/jobs/id/cancel/extra']) {
    const result = await proxyLocalAi(new URL(`http://localhost:3000/api/local-ai${endpoint}`), req, deps);
    assert.equal(result.status, 404);
  }
  assert.equal((await proxyLocalAi(new URL('http://localhost:3000/api/local-ai/state'),
    { ...req, headers: { ...req.headers, origin: 'https://evil.test' } }, deps)).status, 403);
  assert.equal((await proxyLocalAi(new URL('http://localhost:3000/api/local-ai/state'),
    { ...req, headers: { ...req.headers, 'content-type': 'text/plain' } }, deps)).status, 415);
  assert.equal((await proxyLocalAi(new URL('http://rebound.example/api/local-ai/state'),
    { ...req, headers: { ...req.headers, host: 'rebound.example', origin: 'http://rebound.example' } }, deps)).status, 403);
  assert.equal(calls.length, 1);
});

test('proxy configuration/outage fails closed without any alternative provider', async () => {
  const url = new URL('http://localhost:3000/api/local-ai/state');
  const req = { method: 'GET', headers: { host: 'localhost:3000' } };
  assert.equal((await proxyLocalAi(url, req, { env: {}, readBody: async () => undefined })).status, 503);
  assert.equal((await proxyLocalAi(url, req, { env, fetch: async () => { throw new Error('down'); } })).status, 503);
});

test('real sidecar dispatch separates operator transport and broker callback auth', async () => {
  const { createServer, request: httpRequest } = await import('node:http');
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'wm-ai-dispatch-'));
  await mkdir(join(directory, 'api'));
  const prior = Object.fromEntries(['LOCAL_API_TOKEN', 'WM_INFERENCE_URL', 'WM_INFERENCE_TOKEN'].map((key) => [key, process.env[key]]));
  const broker = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer broker-secret');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ mode: 'reserved' }));
  });
  await new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve));
  process.env.WM_INFERENCE_URL = `http://127.0.0.1:${broker.address().port}`;
  process.env.WM_INFERENCE_TOKEN = 'broker-secret';
  process.env.LOCAL_API_TOKEN = 'operator-transport';
  const { createLocalApiServer } = await import('./local-api-server.mjs');
  const app = await createLocalApiServer({ port: 0, apiDir: join(directory, 'api'), mode: 'docker',
    cloudFallback: 'false', logger: { log() {}, warn() {}, error() {} },
    allowPrivateFetchOrigins: [process.env.WM_INFERENCE_URL] });
  const { port } = await app.start();
  const send = (pathname, token, method = 'GET', value) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(value ? JSON.stringify(value) : undefined);
  });
  try {
    assert.equal((await send('/api/local-ai/state', 'wrong')).status, 401);
    assert.deepEqual((await send('/api/local-ai/state', 'operator-transport')).value, { mode: 'reserved' });
    assert.equal((await send('/api/local-ai/run', 'operator-transport', 'POST', body())).status, 401);
    // Valid broker requests reach the private runner; malformed jobs are
    // rejected there instead of falling through to a public/cloud handler.
    assert.equal((await send('/api/local-ai/run', 'broker-secret', 'POST', {})).status, 400);
    assert.equal((await send('/api/local-ai/complete', 'operator-transport', 'POST', {})).status, 404);
  } finally {
    await app.close();
    await new Promise((resolve) => broker.close(resolve));
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('a deterministic stock fallback cannot complete an explicitly requested AI job', async () => {
  const request = { ...body('stock-report', 'stock'), input: { symbol: 'MSFT' } };
  const response = await runLocalAiReport(request, { invoke: async () => Response.json({ model: 'previous-label', fallback: true }) });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'invalid_report_output');
});
