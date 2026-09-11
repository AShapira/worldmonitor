import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLlmDefault as narrativeCall, generateRegionalNarrative, parseNarrativeJson, __setNarrativeTransportForTests } from '../scripts/regional-snapshot/narrative.mjs';
import { callLlmDefault as weeklyCall, __setWeeklyBriefTransportForTests } from '../scripts/regional-snapshot/weekly-brief.mjs';
import { callLLM as insightsCall, __setInsightsLlmTransportForTests } from '../scripts/seed-insights.mjs';
import { generateWhyMatters, generateDigestProse, validateDigestProseShape } from '../scripts/lib/brief-llm.mjs';
import {
  callForecastLLM, getForecastLlmCallOptions, resolveForecastLlmProviders,
  getForecastRunBudgets, getMarketImplicationsMinRunBudgetMs, buildNarrativeCacheHash, buildMarketImplicationsFingerprint,
  __setForecastLlmTransportForTests, __setForecastLlmRunDeadlineForTests,
} from '../scripts/seed-forecasts.mjs';

const keys = ['WM_LOCAL_LLM_PROFILE', 'OLLAMA_API_URL', 'OLLAMA_MODEL', 'LLM_MODEL', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];
let saved;
let savedFetch;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  savedFetch = globalThis.fetch;
  Object.assign(process.env, {
    WM_LOCAL_LLM_PROFILE: 'balanced', OLLAMA_API_URL: 'http://127.0.0.1:11434',
    OLLAMA_MODEL: 'qwen3.5:9b', LLM_MODEL: 'qwen3.5:9b',
    OPENROUTER_API_KEY: 'test-cloud-key', GROQ_API_KEY: 'test-cloud-key',
  });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  globalThis.fetch = savedFetch;
  __setNarrativeTransportForTests(null);
  __setWeeklyBriefTransportForTests(null);
  __setInsightsLlmTransportForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
});
function response(text, finishReason = 'stop') {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text }, finish_reason: finishReason }] }) };
}
function recorder(outputs) {
  const calls = [];
  const fetch = async (url, opts) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:11434\//);
    calls.push(JSON.parse(opts.body));
    return response(outputs[Math.min(calls.length - 1, outputs.length - 1)]);
  };
  return { calls, fetch };
}

for (const [name, call, setTransport] of [
  ['regional narratives', narrativeCall, __setNarrativeTransportForTests],
  ['weekly briefs', weeklyCall, __setWeeklyBriefTransportForTests],
]) {
  test(`${name} retries invalid report locally with cloud credentials present`, async () => {
    const probe = recorder(['bad final', '{"valid":true}']);
    setTransport({ fetch: probe.fetch });
    const result = await call({ systemPrompt: 'Return valid JSON', userPrompt: 'Evidence' }, {
      validate: (text) => text === '{"valid":true}',
    });
    assert.equal(result?.provider, 'ollama');
    assert.equal(result?.model, 'qwen3.5:9b');
    assert.deepEqual(probe.calls.map((body) => body.think), [true, false]);
    assert.equal(probe.calls[0].max_tokens, 6144);
  });
}

test('regional narrative rejects invented evidence IDs in the local profile', () => {
  const section = { text: 'Supported evidence analysis.', evidence_ids: ['invented'] };
  const text = JSON.stringify({ situation: section, balance_assessment: section, outlook_24h: section });
  assert.equal(parseNarrativeJson(text, ['known']).valid, false);
});

test('insights uses local reports and applies the editorial acceptor before accepting', async () => {
  const probe = recorder(['Rejected draft with enough characters.', 'Accepted draft with enough characters.']);
  __setInsightsLlmTransportForTests({ fetch: probe.fetch });
  const result = await insightsCall('Headline', { systemPrompt: 'Synthesize sources', accept: (text) => text.startsWith('Accepted') });
  assert.equal(result?.text, 'Accepted draft with enough characters.');
  assert.deepEqual(probe.calls.map((body) => body.think), [true, false]);
});

test('insights single headline keeps direct mode and rejects unavailable local service without cloud fallback', async () => {
  const probe = recorder(['Valid headline explanation with enough characters.']);
  __setInsightsLlmTransportForTests({ fetch: probe.fetch });
  assert.equal((await insightsCall('Headline'))?.provider, 'ollama');
  assert.equal(probe.calls[0].think, false);
  process.env.OLLAMA_API_URL = 'https://openrouter.ai';
  assert.equal(await insightsCall('Headline'), null);
  assert.equal(probe.calls.length, 1);
});

const story = {
  category: 'Diplomacy', country: 'IR', threatLevel: 'critical',
  headline: 'Iran threatens to close Strait of Hormuz if US blockade continues',
  description: 'Iran threatens to close Strait of Hormuz if US blockade continues',
  source: 'Guardian', sourceUrl: 'https://example.com/hormuz',
};

test('short brief explanations bypass hosted analyst calls and old caches', async () => {
  const prose = 'A closure of the Strait of Hormuz could disrupt oil shipments and raise energy costs for importers.';
  const probe = recorder([prose]); globalThis.fetch = probe.fetch;
  const cacheKeys = [];
  const deps = {
    callLLM: () => assert.fail('cloud chain called'),
    callAnalystWhyMatters: () => assert.fail('hosted analyst called'),
    cacheGet: async (key) => { cacheKeys.push(key); return null; }, cacheSet: async () => {},
  };
  assert.equal(await generateWhyMatters(story, deps), prose);
  assert.equal(probe.calls[0].think, false);
  assert.ok(cacheKeys.every((key) => key.includes('local-balanced')));
});

test('digest composition uses reasoning and rejects ungrounded reports', async () => {
  const valid = JSON.stringify({ lead: 'Iran threatens Strait of Hormuz traffic, placing oil shipments at risk.',
    threads: [{ tag: 'Iran', teaser: 'Hormuz shipping risks increase.' }], signals: ['Watch oil shipments.'] });
  const probe = recorder(['{}', valid]); globalThis.fetch = probe.fetch;
  const deps = { callLLM: () => assert.fail('cloud chain called'), cacheGet: async () => null, cacheSet: async () => {} };
  const result = await generateDigestProse('test-user', [story], 'high', deps);
  assert.match(result?.lead, /Iran/);
  assert.deepEqual(probe.calls.map((body) => body.think), [true, false]);
});

test('forecast market reports override hosted pins only for balanced and retain structured validation', async () => {
  const probe = recorder(['not JSON', '[{"title":"Supply disruption"}]']);
  __setForecastLlmTransportForTests({ fetch: probe.fetch });
  const options = getForecastLlmCallOptions('market_implications');
  assert.deepEqual(resolveForecastLlmProviders(options).map((p) => p.name), ['ollama']);
  assert.equal(getMarketImplicationsMinRunBudgetMs(options), 90_000);
  const result = await callForecastLLM('Analyze evidence', 'Evidence', { ...options, stage: 'market_implications' });
  assert.equal(result?.provider, 'ollama');
  assert.deepEqual(probe.calls.map((body) => body.think), [true, false]);
  delete process.env.WM_LOCAL_LLM_PROFILE;
  assert.deepEqual(getForecastLlmCallOptions('critical_signals').providerOrder, ['groq', 'openrouter']);
});

test('forecast classification stays direct and expired run budgets make no request', async () => {
  const probe = recorder(['{"signals":[]}']);
  __setForecastLlmTransportForTests({ fetch: probe.fetch });
  assert.equal((await callForecastLLM('Classify evidence', 'Evidence', { stage: 'critical_signals' }))?.provider, 'ollama');
  assert.equal(probe.calls[0].think, false);
  __setForecastLlmRunDeadlineForTests(Date.now() - 1);
  const result = await callForecastLLM('Classify evidence', 'Evidence', { returnFailureReason: true });
  assert.equal(result.failureReason, 'budget_exhausted');
  assert.equal(probe.calls.length, 1);
});

test('forecast prose and market cache identities change with the selected local model', () => {
  const oldNarrative = buildNarrativeCacheHash('system', 'user');
  const oldMarkets = buildMarketImplicationsFingerprint('Risk 0.3%');
  process.env.OLLAMA_MODEL = 'qwen3:14b';
  assert.notEqual(buildNarrativeCacheHash('system', 'user'), oldNarrative);
  assert.notEqual(buildMarketImplicationsFingerprint('Risk 0.3%'), oldMarkets);
});


test('local forecast run and lease grow together while hosted budgets stay unchanged', () => {
  const local = getForecastRunBudgets();
  assert.equal(local.runBudgetMs, 30 * 60_000);
  assert.equal(local.lockTtlMs - local.runBudgetMs, 60_000);
  delete process.env.WM_LOCAL_LLM_PROFILE;
  assert.deepEqual(getForecastRunBudgets(), { runBudgetMs: 200_000, lockTtlMs: 240_000 });
});


test('local narrative cache cannot bypass the evidence whitelist', async () => {
  const invalid = { situation: { text: 'Claim with an invented citation.', evidence_ids: ['invented'] } };
  let generated = 0;
  const result = await generateRegionalNarrative({id:'mena',name:'Middle East'}, {
    actors:[], scenario_sets:[], transmission_paths:[], triggers:{active:[]}, regime:{label:'contested'}, balance:{net_balance:0,coercive_pressure:0,domestic_fragility:0,capital_stress:0,energy_vulnerability:0,alliance_cohesion:0,maritime_access:0,energy_leverage:0},
  }, [], {
    cache: { get: async () => ({ narrative: invalid, model: 'qwen3.5:9b' }), set: async () => {} },
    callLlm: async () => { generated++; return { text: JSON.stringify({situation:{text:'Updated situation.',evidence_ids:[]}}),provider:'ollama',model:'qwen3.5:9b' }; },
  });
  assert.equal(generated, 1);
  assert.equal(result.narrative.situation.text, 'Updated situation.');
});

test('local digest rejects story references absent from the prompt on generated and cached paths', () => {
  const prose = {lead:'Iran threatens Strait of Hormuz traffic, placing oil shipments at risk.',
    threads:[{tag:'Iran',teaser:'Hormuz shipping risks increase.'}], rankedStoryHashes:['invented']};
  assert.equal(validateDigestProseShape(prose, [story]), null);
  prose.rankedStoryHashes = ['abcd1234'];
  assert.ok(validateDigestProseShape(prose, [{...story,hash:'abcd1234fullhash'}]));
});
