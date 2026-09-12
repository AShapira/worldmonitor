import assert from 'node:assert/strict';
import test from 'node:test';
import { retainInsightsBrief } from '../scripts/_retained-insights-brief.mjs';
import { fetchInsights, validateInsightsPayload, publishInsightsPayload, insightsFreshnessPatchArgs } from '../scripts/seed-insights.mjs';

const old = {
  worldBrief: 'Original grounded report [1].', briefModel: 'qwen3.5:9b', briefProvider: 'ollama', status: 'degraded',
  generatedAt: '2026-09-10T10:00:00Z', worldBriefSources: [{ title: 'Original report', source: 'Reuters', url: 'https://example.com/old' }],
  briefStoryLines: [{ n: 1, text: 'Original grounded report [1].' }],
  sourceAgeRange: { newestMs: 1, oldestMs: 1 }, topStories: [{ primaryTitle: 'Old headline' }],
};
const fresh = { generatedAt: '2026-09-12T10:00:00Z', topStories: [{ primaryTitle: 'Fresh headline' }], clusterCount: 2 };

test('repeated paused collections retain exact daily text, source indexes, model and report clock', () => {
  const first = retainInsightsBrief(fresh, old);
  assert.equal(first.worldBrief, old.worldBrief);
  assert.deepEqual(first.worldBriefSources, old.worldBriefSources);
  assert.deepEqual(first.briefStoryLines, old.briefStoryLines);
  assert.deepEqual(first.sourceAgeRange, old.sourceAgeRange);
  assert.equal(first.briefModel, old.briefModel);
  assert.equal(first.briefGeneratedAt, old.generatedAt);
  assert.equal(first.generatedAt, fresh.generatedAt);
  assert.deepEqual(first.topStories, fresh.topStories);
  assert.deepEqual(first.briefTopStories, old.topStories);
  const again = retainInsightsBrief({ ...fresh, generatedAt: '2026-09-13T10:00:00Z' }, first);
  assert.equal(again.briefGeneratedAt, old.generatedAt);
  assert.deepEqual(again.briefTopStories, old.topStories);
  assert.equal(insightsFreshnessPatchArgs(again, 'published').servedGeneratedAt, old.generatedAt);
});

test('an ungrounded previous report is not retained as a source-complete brief', () => {
  for (const prior of [null, { ...old, worldBriefSources: [] }, { ...old, worldBrief: 'Invented [2].' }, { ...old, briefModel: '' }]) {
    const result = retainInsightsBrief(fresh, prior);
    assert.equal(result.worldBrief, '');
    assert.equal(result.briefStatus, 'unavailable');
    assert.deepEqual(result.topStories, fresh.topStories);
  }
});

test('actual insights producer publishes new collection with the retained daily report after broker denial', async (t) => {
  const names = ['WM_INFERENCE_ENABLED', 'WM_INFERENCE_URL', 'WM_INFERENCE_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { WM_INFERENCE_ENABLED: '1', WM_INFERENCE_URL: 'http://inference.test', WM_INFERENCE_TOKEN: 'test',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test' });
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const title = 'Israeli cabinet debates major government budget proposal';
  const digest = { categories: { politics: { items: ['Reuters', 'Associated Press'].map((source, i) => ({
    title, source, link: `https://example.com/new-${i}`, pubDate: new Date().toISOString(), importanceScore: 100,
  })) } } };
  let brokerCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'inference.test') { brokerCalls++; return Response.json({ error: 'automatic_ai_paused' }, { status: 409 }); }
    assert.equal(url.hostname, 'redis.test');
    const key = decodeURIComponent(url.pathname.replace(/^\/get\//, ''));
    const value = key.startsWith('news:digest:') ? digest : key === 'news:insights:v1' ? old : null;
    return Response.json({ result: value === null ? null : JSON.stringify(value) });
  });
  const result = await fetchInsights();
  assert.equal(brokerCalls, 1, 'denial must not trigger the legacy second inference attempt');
  assert.equal(result.worldBrief, old.worldBrief);
  assert.equal(result.briefGeneratedAt, old.generatedAt);
  assert.equal(result.briefModel, old.briefModel);
  assert.notEqual(result.generatedAt, old.generatedAt);
  assert.equal(result.topStories[0].primaryTitle, title);
  assert.equal(validateInsightsPayload(result), true, 'fresh collection must publish instead of freezing all data');
  const published = publishInsightsPayload(result);
  assert.equal(published.briefStatus, 'retained');
  assert.deepEqual(published.worldBriefSources, old.worldBriefSources);
});

test('scheduled weekly denial never writes over the old per-region report', async (t) => {
  const names = ['WM_INFERENCE_ENABLED', 'WM_INFERENCE_URL', 'WM_INFERENCE_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { WM_INFERENCE_ENABLED: '1', WM_INFERENCE_URL: 'http://inference.test', WM_INFERENCE_TOKEN: 'test',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test' });
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  let brokerCalls = 0;
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'inference.test') { brokerCalls++; return Response.json({ error: 'automatic_ai_paused' }, { status: 409 }); }
    assert.equal(url.hostname, 'redis.test');
    const pathname = decodeURIComponent(url.pathname);
    if (init?.method === 'POST') writes.push(pathname + String(init.body || ''));
    if (pathname.startsWith('/lrange/')) return Response.json({ result: [] });
    if (pathname.startsWith('/get/') && pathname.endsWith(':latest')) return Response.json({ result: 'snapshot-id' });
    if (pathname.includes('snapshot-by-id:')) return Response.json({ result: JSON.stringify({ generated_at: 100, balance: {}, narrative: {}, regime: {} }) });
    return Response.json({ result: 'OK' });
  });
  const { main } = await import('../scripts/seed-regional-briefs.mjs');
  await main();
  assert.ok(brokerCalls > 0);
  assert.equal(writes.some((write) => write.includes('intelligence:regional-briefs:v1:weekly:')), false);
});
