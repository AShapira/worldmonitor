import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWorkerReport } from '../scripts/_local-ai-reports.mjs';
import { REGIONS } from '../scripts/shared/geography.js';

const regionId = REGIONS.find((r) => r.id !== 'global').id;
const snapshot = { region_id: regionId, generated_at: 123, evidence: [{ id: 'e1', source: 'observed-feed', summary: 'Observed source' }] };
const readRedis = async (command) => command[0] === 'LRANGE' ? ['{"transitioned_at":1}']
  : command[1].endsWith(':latest') ? 'snapshot-id' : JSON.stringify({ _seed: { fetchedAt: 123 }, data: snapshot });

test('regional jobs read seeded evidence and disable the automatic narrative cache', async () => {
  let captured;
  const result = await generateWorkerReport('regional', { regionId }, {
    readRedis, generateNarrative: async (region, snap, evidence, opts) => {
      captured = { region, snap, evidence };
      assert.equal(await opts.cache.get('anything'), null);
      return { narrative: { bottom_line: 'Source-backed finding' }, model: 'chosen', provider: 'codex' };
    },
  });
  assert.equal(captured.snap.generated_at, 123);
  assert.deepEqual(captured.evidence, snapshot.evidence);
  assert.equal(result.sourceGeneratedAt, 123);
  assert.equal(result.model, 'chosen');
});

test('weekly job does not turn unavailable or malformed history into a quiet week', async () => {
  for (const raw of [null, ['not-json']]) {
    await assert.rejects(generateWorkerReport('weekly', { regionId }, {
      readRedis: (cmd) => cmd[0] === 'LRANGE' ? raw : readRedis(cmd),
      generateWeekly: async () => { assert.fail('should not infer'); },
    }), { code: 'source_evidence_unavailable' });
  }
});

test('weekly uses the existing generator and preserves source timestamps', async () => {
  const result = await generateWorkerReport('weekly', { regionId }, { readRedis,
    generateWeekly: async (_region, snap, transitions) => {
      assert.equal(snap.generated_at, 123);
      assert.deepEqual(transitions, []);
      return { situation_recap: 'Recap', model: 'chosen', provider: 'codex', generated_at: 456 };
    } });
  assert.equal(result.generated_at, 456);
  assert.equal(result.sourceGeneratedAt, 123);
});

test('daily refuses absent news and unlinked evidence without calling a model', async () => {
  for (const payload of [null, { topStories: [{ primaryTitle: 'Unlinked headline' }] }]) {
    await assert.rejects(generateWorkerReport('daily', {}, { readRedis: async () => JSON.stringify(payload),
      callLlm: async () => { assert.fail('should not infer'); } }), { code: 'source_evidence_unavailable' });
  }
});

test('daily enforces existing citation and source-grounding validators on hosted output', async () => {
  const story = { primaryTitle: 'Israeli cabinet debates budget proposal', primarySource: 'Reuters',
    primaryLink: 'https://example.com/budget', sources: ['Reuters', 'Associated Press'], sourceCount: 2 };
  await assert.rejects(generateWorkerReport('daily', {}, { readRedis: async () => JSON.stringify({ topStories: [story] }),
    callLlm: async (opts) => {
      assert.equal(opts.validate('{"lead":"Invented uncited events","lines":[]}'), false);
      return { text: '{"lead":"Invented uncited events","lines":[]}', model: 'powerful', provider: 'codex' };
    } }), { code: 'invalid_report_output' });
});

test('daily reads the actual enveloped insights shape and exposes only the same member headlines its gate admits', async () => {
  const story = { primaryTitle: 'Israeli cabinet debates budget proposal', primarySource: 'Reuters',
    primaryLink: 'https://example.com/budget', sources: ['Reuters', 'Associated Press'], sourceCount: 2,
    memberTitles: ['First visible corroborating headline', 'Second visible corroborating headline', 'Hiddenopolis pipeline exploded'],
    pubDate: '2026-09-10T10:00:00Z' };
  await assert.rejects(generateWorkerReport('daily', {}, {
    readRedis: async () => JSON.stringify({ _seed: { fetchedAt: 100 }, data: { generatedAt: '2026-09-10T10:00:00Z', topStories: [story] } }),
    callLlm: async (opts) => {
      assert.match(opts.userPrompt, /First visible corroborating headline/);
      assert.match(opts.userPrompt, /Second visible corroborating headline/);
      assert.doesNotMatch(opts.userPrompt, /Hiddenopolis/);
      assert.match(opts.userPrompt, /2026-09-10T10:00:00Z/);
      assert.equal(opts.validate(JSON.stringify({ lead: 'Hiddenopolis pipeline exploded [1].', lines: [{ n: 1, text: story.primaryTitle }] })), false);
      return null;
    },
  }), { code: 'invalid_report_output' });
});

test('daily rejects uncorroborated headlines before calling a paid model', async () => {
  const story = { primaryTitle: 'Single report', primarySource: 'Reuters', primaryLink: 'https://example.com/story', sources: ['Reuters'] };
  await assert.rejects(generateWorkerReport('daily', {}, { readRedis: async () => JSON.stringify({ topStories: [story] }),
    callLlm: async () => { assert.fail('cannot pass the existing corroboration gate'); } }), { code: 'source_evidence_unavailable' });
});

test('weekly prompts include raw dated evidence, omit previous AI prose, and enforce numbered citations', async () => {
  const seeded = { ...snapshot, narrative: { situation: { text: 'Previous AI guess must not be source evidence' } },
    evidence: [{ id: 'e1', source: 'observed-feed', summary: 'Observed port closure', observed_at: 99 }] };
  const result = await generateWorkerReport('weekly', { regionId }, {
    readRedis: async (cmd) => cmd[0] === 'LRANGE' ? [] : cmd[1].endsWith(':latest') ? 'snapshot-id' : JSON.stringify(seeded),
    callLlm: async (opts) => {
      assert.match(opts.userPrompt, /Observed port closure/);
      assert.match(opts.userPrompt, /"observedAt":99/);
      assert.doesNotMatch(opts.userPrompt, /Previous AI guess/);
      const valid = { situation_recap: 'Observed port closure [1].', regime_trajectory: 'The observation is limited [1].',
        key_developments: ['Port closure [1]'], risk_outlook: 'Watch the observed port [1].' };
      assert.equal(opts.validate(JSON.stringify(valid)), true);
      assert.equal(opts.validate(JSON.stringify({ ...valid, risk_outlook: 'Uncited claims' })), false);
      assert.equal(opts.validate(JSON.stringify({ ...valid, situation_recap: 'Port closure [999]' })), false);
      assert.equal(opts.validate(JSON.stringify({ ...valid, key_developments: ['Uncited bullet'] })), false);
      return { text: JSON.stringify(valid), model: 'powerful', provider: 'codex' };
    },
  });
  assert.equal(result.sources[0].id, 'e1');
  assert.equal(result.sources[0].observedAt, 99);
  assert.equal(result.sourceGeneratedAt, 123);
});


test('regional and weekly jobs reject malformed or empty source records before inference', async () => {
  for (const kind of ['regional', 'weekly']) {
    await assert.rejects(generateWorkerReport(kind, { regionId }, {
      readRedis: async (cmd) => cmd[1].endsWith(':latest') ? 'snapshot-id' : JSON.stringify({ ...snapshot, evidence: [{ id: 'e1' }] }),
      generateNarrative: async () => { assert.fail('source-free narrative'); },
      generateWeekly: async () => { assert.fail('source-free weekly brief'); },
    }), { code: 'source_evidence_unavailable' });
  }
});
