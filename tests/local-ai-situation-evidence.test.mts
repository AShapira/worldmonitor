import assert from 'node:assert/strict';
import test from 'node:test';
import { runNativeReport } from '../server/_shared/local-ai-handlers';
import { runLocalAiReport } from '../src-tauri/sidecar/local-ai.mjs';

test('private query-only situation jobs require revocation-checked dated WorldMonitor evidence and valid citations', async () => {
  const names = ['WM_INFERENCE_ENABLED', 'WM_INFERENCE_URL', 'WM_INFERENCE_TOKEN', 'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_API_MODE', 'USAGE_TELEMETRY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { WM_INFERENCE_ENABLED: '1', WM_INFERENCE_URL: 'http://inference.test',
    WM_INFERENCE_TOKEN: 'test', UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'test', LOCAL_API_MODE: 'docker', USAGE_TELEMETRY: '0' });
  const source = { title: 'Iran shipping talks resume', source: 'Reuters',
    link: 'https://example.test/iran-talks', pubDate: '2026-09-11T12:00:00Z' };
  try {
    for (const scenario of ['valid', 'missing', 'unrelated', 'undated', 'revoked', 'revocations-unreadable', 'invalid-citation', 'uncited']) {
      const completions: { jobId: string; messages: { content: string }[] }[] = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url === 'http://inference.test/complete') {
          completions.push(JSON.parse(String(init?.body)));
          return Response.json({ text: scenario === 'invalid-citation' ? 'Iran talks resumed [99].'
            : scenario === 'uncited' ? 'Iran talks resumed.' : 'Iran shipping talks resumed [1]. Coverage beyond this observation is unavailable.',
          finishReason: 'stop', model: 'gpt-test', provider: 'chatgpt', tokens: 20 });
        }
        if (url.endsWith('/pipeline')) {
          return Response.json(scenario === 'revocations-unreadable' ? [{ error: 'unavailable' }]
            : [{ result: scenario === 'revoked' ? [source.link] : [] }]);
        }
        if (decodeURIComponent(url).includes('/get/news:digest:v1:full:en')) {
          const items = scenario === 'missing' ? [] : [scenario === 'unrelated' ? { ...source, title: 'France election vote' }
            : scenario === 'undated' ? { ...source, pubDate: undefined } : source];
          return Response.json({ result: JSON.stringify({ categories: { world: { items } } }) });
        }
        if (!url.startsWith('https://redis.test')) throw new Error(`Unexpected upstream ${url}`);
        return Response.json({ result: null });
      }) as typeof globalThis.fetch;
      const result = await runLocalAiReport({ id: `situation-${scenario}`, kind: 'situation',
        input: { query: 'What is the situation in Iran?' }, deadlineAt: Date.now() + 30_000,
        profile: { provider: 'chatgpt', model: 'gpt-test', effort: 'low', promptVersion: 'v1' } }, {
        invoke: (kind: string, input: Record<string, unknown>) => runNativeReport(kind, input,
          new Request('http://localhost/api/local-ai/run')),
      });
      const body = await result.json();
      if (scenario === 'valid') {
        assert.equal(result.status, 200);
        assert.deepEqual(body.sources, [{ title: source.title, source: source.source, url: source.link,
          publishedAt: '2026-09-11T12:00:00.000Z' }]);
        assert.equal(completions.length, 1);
        assert.equal(completions[0].jobId, 'situation-valid');
        const prompt = completions[0].messages.map((message) => message.content).join('\n');
        assert.match(prompt, /CITATIONS:/);
        assert.ok(prompt.includes(source.title));
        assert.ok(prompt.includes(source.link));
        assert.ok(prompt.includes('2026-09-11T12:00:00.000Z'));
      } else if (['invalid-citation', 'uncited'].includes(scenario)) {
        assert.equal(completions.length, 1);
        assert.equal(result.status, 502);
        assert.equal(body.error, 'invalid_report_output');
      } else {
        assert.equal(completions.length, 0, `No inference without safe sources: ${scenario}`);
        assert.equal(result.status, 422);
        assert.equal(body.error, 'source_evidence_unavailable');
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
