import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getCountryIntelBrief } from '../server/worldmonitor/intelligence/v1/get-country-intel-brief.ts';
import { deductSituation } from '../server/worldmonitor/intelligence/v1/deduct-situation.ts';
import { summarizeArticle } from '../server/worldmonitor/news/v1/summarize-article.ts';
import { getSummarizeArticleCache } from '../server/worldmonitor/news/v1/get-summarize-article-cache.ts';
import { getCacheKey } from '../server/worldmonitor/news/v1/_shared.ts';
import { localLlmCacheTag } from '../scripts/_local-llm-profile.mjs';
import { localLlmBrowserCacheTag, isLocalLlmBrowserProfile } from '../src/services/local-llm-profile.ts';

const originalFetch = globalThis.fetch;
const keys = ['WM_LOCAL_LLM_PROFILE', 'OLLAMA_MODEL', 'OLLAMA_API_URL', 'LLM_MODEL', 'LLM_API_URL', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'USAGE_TELEMETRY'];
let saved: Record<string, string | undefined>;
const context = (path: string) => ({ request: new Request(`http://localhost${path}`), pathParams: {}, headers: {} });

beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.WM_LOCAL_LLM_PROFILE = 'balanced';
  process.env.OLLAMA_API_URL = 'http://localhost:11434';
  process.env.OLLAMA_MODEL = 'qwen3.5:9b';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function installOllama(contents: string[], withCountrySources = false) {
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (withCountrySources && url.startsWith('https://redis.fixture/')) {
      if (new URL(url).pathname === '/pipeline') return Response.json([{ result: [] }]);
      const key = decodeURIComponent(new URL(url).pathname.slice('/get/'.length));
      return Response.json({ result: key === 'news:digest:v1:full:en' ? JSON.stringify({ items: [{ title: 'Israel reports port disruption', source: 'Fixture Wire', link: 'https://example.com/port', publishedAt: '2026-09-11T00:00:00Z' }] }) : null });
    }
    if (url === 'http://localhost:11434' || url === 'http://localhost:11434/') return new Response('Ollama is running');
    assert.equal(url, 'http://localhost:11434/v1/chat/completions', 'local report must not contact cloud inference');
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return Response.json({ choices: [{ message: { content: contents[Math.min(requests.length - 1, contents.length - 1)] }, finish_reason: 'stop' }], usage: { total_tokens: 120 } });
  }) as typeof fetch;
  return requests;
}

describe('balanced local report handlers', () => {
  it('rejects fabricated country citations and retries with a direct final answer', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
    const requests = installOllama(['Unsupported claim [99].', 'SITUATION NOW\nIsrael reports port disruption [1]. Further evidence is needed to assess its duration.'], true);
    const result = await getCountryIntelBrief(context('/api/intelligence/v1/get-country-intel-brief?country_code=IL'), { countryCode: 'IL', framework: '' });
    assert.equal(result.model, 'qwen3.5:9b');
    assert.match(result.brief, /Israel reports port disruption \[1\]/);
    assert.doesNotMatch(result.brief, /99/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].think, true);
    assert.equal(requests[0].max_tokens, 6144);
    assert.equal(requests[1].think, false);
  });

  it('does not infer a current country situation from missing sources or zero event counts', async () => {
    const requests = installOllama(['No disruptions exist.']);
    const result = await getCountryIntelBrief(context('/api/intelligence/v1/get-country-intel-brief?country_code=IL'), { countryCode: 'IL', framework: '' });
    assert.equal(result.brief, '');
    assert.equal(result.model, '');
    assert.equal(requests.length, 0);
  });

  it('generates situation analysis with the local reasoning profile', async () => {
    const requests = installOllama(['The supplied signals are contradictory. Additional verified evidence is needed.']);
    const result = await deductSituation(context('/api/intelligence/v1/deduct-situation'), { query: 'Assess conflicting shipping reports', geoContext: 'One source reports reopening; another reports continued closure.', framework: '' });
    assert.equal(result.provider, 'ollama');
    assert.equal(result.model, 'qwen3.5:9b');
    assert.equal(requests[0].think, true);
    assert.equal(requests[0].max_tokens, 6144);
    assert.match(result.analysis, /contradictory/);
  });

  it('cache reads use the selected server model identity with unchanged public keys', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
    const cacheKey = await getCacheKey(['A valid headline', 'Another valid headline'], 'brief', '', 'full', 'en');
    let readKey = '';
    globalThis.fetch = (async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://redis.fixture');
      readKey = decodeURIComponent(url.pathname.slice('/get/'.length));
      return Response.json({ result: JSON.stringify({ summary: 'The new model generated this summary.', model: 'qwen3.5:9b' }) });
    }) as typeof fetch;
    const result = await getSummarizeArticleCache(context('/api/news/v1/get-summarize-article-cache'), { cacheKey });
    assert.equal(result.model, 'qwen3.5:9b');
    assert.equal(result.status, 'SUMMARIZE_STATUS_CACHED');
    assert.equal(readKey, cacheKey + localLlmCacheTag());
  });

  it('keeps short text direct and refuses explicitly selected cloud providers', async () => {
    const requests = installOllama(['Translation grounded in the supplied headline.']);
    const req = { provider: 'openrouter', mode: 'translate', headlines: ['Headline one', 'Headline two'], geoContext: '', variant: 'full', lang: 'en', systemAppend: '', bodies: [] };
    process.env.OPENROUTER_API_KEY = 'fixture-cloud-key';
    const skipped = await summarizeArticle(context('/api/news/v1/summarize-article'), req);
    assert.equal(skipped.status, 'SUMMARIZE_STATUS_SKIPPED');
    assert.equal(requests.length, 0);
    const result = await summarizeArticle(context('/api/news/v1/summarize-article'), { ...req, provider: 'ollama' });
    assert.equal(result.model, 'qwen3.5:9b');
    assert.equal(requests[0].think, false);
    assert.equal(requests[0].max_tokens, 100);
  });
});

describe('browser local prose identity', () => {
  it('preserves cloud cache keys and separates profile/model changes', () => {
    assert.equal(isLocalLlmBrowserProfile({}), false);
    assert.equal(localLlmBrowserCacheTag({}), '');
    const first = localLlmBrowserCacheTag({ VITE_LOCAL_LLM_PROFILE: 'balanced', VITE_LOCAL_LLM_MODEL: 'qwen3.5:9b' });
    const second = localLlmBrowserCacheTag({ VITE_LOCAL_LLM_PROFILE: 'balanced', VITE_LOCAL_LLM_MODEL: 'qwen3:14b' });
    assert.notEqual(first, second);
    assert.ok(first.length > 0);
  });
});
