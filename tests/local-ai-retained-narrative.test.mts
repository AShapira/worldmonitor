import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore — the helper is a scripts-only pure ESM module.
import { retainNarrative } from '../scripts/regional-snapshot/retained-narrative.mjs';
import { adaptSnapshot } from '../server/worldmonitor/intelligence/v1/get-regional-snapshot';

const old = {
  generated_at: 1000, meta: { snapshot_id: 'old', narrative_model: 'original-model', narrative_provider: 'ollama' },
  evidence: [{ id: 'e1', summary: 'Original observation', source: 'Original source', observed_at: 900 }],
  narrative: Object.fromEntries(['situation', 'balance_assessment', 'outlook_24h', 'outlook_7d', 'outlook_30d']
    .map((key) => [key, { text: 'Original report', evidence_ids: ['e1'] }])),
};

test('repeated suppression keeps original generation time, model and evidence', () => {
  const saved = retainNarrative(old);
  assert.equal(saved.generated_at, 1000);
  assert.equal(saved.model, 'original-model');
  assert.deepEqual(retainNarrative({ generated_at: 9999, retained_narrative: saved }), saved);
  const fresh = { ...old, generated_at: 9999, narrative_status: 'retained' as const, retained_narrative: saved,
    evidence: [{ id: 'e1', summary: 'New observation', source: 'Current source', observed_at: 9998 }] };
  const result = adaptSnapshot(fresh);
  assert.equal(result.generatedAt, 9999);
  assert.equal(result.meta?.narrativeModel, 'original-model');
  assert.match(result.narrative?.situation?.text || '', /1970-01-01T00:00:01.000Z/);
  assert.deepEqual(result.narrative?.situation?.evidenceIds, ['saved:old:e1']);
  assert.equal(result.evidence.find((e) => e.id === 'saved:old:e1')?.observedAt, 900);
  assert.equal(result.evidence.find((e) => e.id === 'e1')?.observedAt, 9998);
});

test('missing provenance or source support cannot become a retained report', () => {
  assert.equal(retainNarrative({ ...old, evidence: [] }), null);
  assert.equal(retainNarrative({ ...old, meta: { ...old.meta, narrative_model: '' } }), null);
  assert.equal(retainNarrative({ ...old, generated_at: 0 }), null);
  const result = adaptSnapshot({ generated_at: 9999, narrative_status: 'unavailable' });
  assert.match(result.narrative?.situation?.text || '', /No complete previous report/);
  assert.deepEqual(result.narrative?.situation?.evidenceIds, []);
});
