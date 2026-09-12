import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeArticle } from '../server/worldmonitor/news/v1/summarize-article';

test('article translation cannot bypass reservation or missing managed configuration', async () => {
  const names = ['WM_INFERENCE_ENABLED', 'WM_INFERENCE_URL', 'WM_INFERENCE_TOKEN', 'OLLAMA_API_URL',
    'OLLAMA_MODEL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'USAGE_TELEMETRY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const fetch = globalThis.fetch;
  Object.assign(process.env, { WM_INFERENCE_ENABLED: '1', WM_INFERENCE_TOKEN: 'broker-secret',
    OLLAMA_API_URL: 'http://localhost:11434', OLLAMA_MODEL: 'must-not-load',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test', USAGE_TELEMETRY: '0' });
  try {
    for (const configured of [true, false]) {
      if (configured) process.env.WM_INFERENCE_URL = 'http://inference:8090'; else delete process.env.WM_INFERENCE_URL;
      const calls: string[] = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url === 'http://inference:8090/complete') {
          assert.equal(JSON.parse(String(init?.body)).jobId, undefined);
          return Response.json({ error: 'automatic_ai_paused' }, { status: 409 });
        }
        return Response.json({ result: null });
      }) as typeof globalThis.fetch;
      const request = new Request('http://localhost/api/news/v1/summarize-article');
      const result = await summarizeArticle({ request, headers: {}, pathParams: {} }, {
        provider: 'ollama', mode: 'translate', headlines: [`Original source ${configured}`], geoContext: '',
        variant: 'full', lang: 'en', systemAppend: '', bodies: [],
      });
      assert.equal(result.summary, '');
      assert.equal(calls.some((url) => url.includes('11434')), false);
      assert.equal(calls.filter((url) => url === 'http://inference:8090/complete').length, configured ? 1 : 0);
    }
  } finally {
    globalThis.fetch = fetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
