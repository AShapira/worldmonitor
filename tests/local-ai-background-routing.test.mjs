import assert from 'node:assert/strict';
import test from 'node:test';
import { callLLM } from '../scripts/lib/llm-chain.cjs';
import { requestCompanyMonitoringClassification } from '../scripts/lib/company-monitoring-classifier-client.mjs';

test('legacy worker LLM chain honors broker suppression and never falls through to external keys', async () => {
  const names = ['WM_INFERENCE_URL', 'WM_INFERENCE_TOKEN', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const fetch = globalThis.fetch;
  Object.assign(process.env, { WM_INFERENCE_URL: 'http://inference:8090', WM_INFERENCE_TOKEN: 'private',
    GROQ_API_KEY: 'must-not-use', OPENROUTER_API_KEY: 'must-not-use' });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ error: 'automatic_ai_paused' }, { status: 409 });
  };
  try {
    assert.equal(await callLLM('Classify supplied evidence', 'Observed headline'), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://inference:8090/complete');
    assert.equal(calls[0].body.jobId, undefined);
    assert.equal(calls[0].body.report, false);
    globalThis.fetch = async () => Response.json({ text: 'Classification', model: 'local', provider: 'ollama', finishReason: 'stop' });
    assert.equal(await callLLM('Classify', 'Headline'), 'Classification');
    await assert.rejects(requestCompanyMonitoringClassification({}), /unavailable under managed local inference/);
  } finally {
    globalThis.fetch = fetch;
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
