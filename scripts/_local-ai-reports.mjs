// Read-only report generation. Importing this module never schedules a seed
// run or publishes over the existing reports.
import { getRedisCredentials } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { REGIONS } from './shared/geography.js';
import { generateRegionalNarrative } from './regional-snapshot/narrative.mjs';
import { generateWeeklyBrief, parseBriefJson } from './regional-snapshot/weekly-brief.mjs';
import { callLocalLlm } from './_local-llm-profile.mjs';
import { synthesisSystemPrompt, synthesisUserPrompt, composeSynthesizedBriefResult, pickBriefCluster } from './_insights-brief.mjs';

function unavailable(code = 'source_evidence_unavailable') { return Object.assign(new Error(code), { code }); }
function evidencePayload(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw unavailable(); }
  }
  if (!raw || typeof raw !== 'object') throw unavailable();
  return unwrapEnvelope(raw).data;
}
async function readRedis(command, fetchFn) {
  // The CLI credential helper intentionally exits on missing configuration;
  // this long-lived sidecar must return an unavailable job instead.
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) throw unavailable();
  const { url, token } = getRedisCredentials();
  if (!url || !token) throw unavailable();
  const response = await fetchFn(url, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor/LocalAI',
  }, body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw unavailable();
  const data = await response.json();
  if (data.error) throw unavailable();
  return data.result;
}
function source(story) {
  try {
    const url = new URL(story.primaryLink);
    if (!['http:', 'https:'].includes(url.protocol) || !story.primaryTitle || !story.primarySource) return null;
    return { title: String(story.primaryTitle).slice(0, 160), source: String(story.primarySource).slice(0, 80), url: url.href,
      ...(story.pubDate ? { publishedAt: story.pubDate } : {}) };
  } catch { return null; }
}

export async function generateWorkerReport(kind, input, deps = {}) {
  const read = deps.readRedis || ((command) => readRedis(command, deps.fetch || globalThis.fetch));
  if (kind === 'daily') {
    const payload = evidencePayload(await read(['GET', 'news:insights:v1']));
    const stories = Array.isArray(payload?.topStories) ? payload.topStories.slice(0, 8).filter((story) => source(story)) : [];
    if (!stories.length || !pickBriefCluster(stories)) throw unavailable();
    const date = new Date().toISOString().slice(0, 10);
    const compose = (text) => composeSynthesizedBriefResult(text, stories, { sourceFromStory: source, validatorMode: 'enforce', promptScopedMembers: true }).brief;
    const result = await (deps.callLlm || callLocalLlm)({
      systemPrompt: `${synthesisSystemPrompt(date)}\nMissing feeds or old publication dates are coverage gaps, not evidence that nothing happened.`,
      userPrompt: `${synthesisUserPrompt(stories, { includeMemberTitles: true })}\nSource publication dates: ${JSON.stringify(stories.map((story, i) => ({ n: i + 1, publishedAt: story.pubDate || 'unknown' })))}`,
      report: true,
      maxTokens: 2200, validate: (text) => Boolean(compose(text)),
    });
    const brief = result && compose(result.text);
    if (!brief) throw unavailable('invalid_report_output');
    return { ...brief, model: result.model, provider: result.provider, generatedAt: Date.now(), sourceGeneratedAt: payload.updatedAt ?? payload.generatedAt ?? null };
  }
  const region = REGIONS.find((r) => r.id === input.regionId && r.id !== 'global');
  if (!region) throw unavailable('unknown_region');
  let id = await read(['GET', `intelligence:snapshot:v1:${region.id}:latest`]);
  try { id = JSON.parse(id); } catch { /* legacy bare id */ }
  if (id && typeof id === 'object') id = id.snapshot_id;
  if (typeof id !== 'string' || !id) throw unavailable();
  const snapshot = evidencePayload(await read(['GET', `intelligence:snapshot-by-id:v1:${id}`]));
  if (!snapshot || !Array.isArray(snapshot.evidence)) throw unavailable();
  snapshot.evidence = snapshot.evidence.filter((item) => item && typeof item.id === 'string' && item.id.trim()
    && typeof item.source === 'string' && item.source.trim() && typeof item.summary === 'string' && item.summary.trim());
  if (!snapshot.evidence.length) throw unavailable();
  if (kind === 'regional') {
    const result = await (deps.generateNarrative || generateRegionalNarrative)(region, snapshot, snapshot.evidence,
      { cache: { get: async () => null, set: async () => {} } });
    if (!result.model) throw unavailable('invalid_report_output');
    return { ...result, evidence: snapshot.evidence, generatedAt: Date.now(), sourceGeneratedAt: snapshot.generated_at };
  }
  if (kind !== 'weekly') throw unavailable('unsupported_report');
  const raw = await read(['LRANGE', `intelligence:regime-history:v1:${region.id}`, '0', '49']);
  if (!Array.isArray(raw)) throw unavailable();
  const cutoff = Date.now() - 7 * 86400000;
  const transitions = raw.map((entry) => {
    try { return typeof entry === 'string' ? JSON.parse(entry) : entry; } catch { throw unavailable(); }
  }).filter((entry) => entry && (entry.transitioned_at ?? 0) >= cutoff);
  const sources = snapshot.evidence.slice(0, 30).map((item, index) => ({
    n: index + 1, id: item.id, source: item.source || 'unknown', summary: item.summary || '',
    observedAt: item.observed_at ?? null, ...(item.url ? { url: item.url } : {}),
  }));
  sources.push({ n: sources.length + 1, id: `snapshot:${id}`, source: 'derived regional snapshot',
    summary: JSON.stringify({ regime: snapshot.regime ?? null, balance: snapshot.balance ?? null,
      activeTriggers: snapshot.triggers?.active ?? [], missingInputs: snapshot.meta?.missing_inputs ?? [],
      staleInputs: snapshot.meta?.stale_inputs ?? [] }), observedAt: snapshot.generated_at ?? null });
  sources.push({ n: sources.length + 1, id: `regime-history:${region.id}`, source: 'regime transition history',
    summary: JSON.stringify(transitions), observedAt: Date.now() });
  const callLlm = async ({ systemPrompt, userPrompt }, opts = {}) => {
    const validate = (text) => {
      const { brief, valid } = parseBriefJson(text);
      if (!valid || (opts.validate && !opts.validate(text))) return false;
      return [brief.situation_recap, brief.regime_trajectory, brief.risk_outlook, ...brief.key_developments]
        .every((section) => {
          const citations = [...section.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
          return citations.length > 0 && citations.every((n) => n >= 1 && n <= sources.length);
        });
    };
    return (deps.callLlm || callLocalLlm)({
      systemPrompt: `${systemPrompt}\nCite every non-empty field and bullet using the supplied numbered evidence, e.g. [1]. Do not cite sources that do not support the claim. Missing feeds and stale observations are coverage gaps. Do not treat previous model narratives as sources.`,
      userPrompt: `${userPrompt}\nSnapshot generated at: ${snapshot.generated_at}\nNumbered source evidence (retain observation dates):\n${JSON.stringify(sources)}`,
      report: true, validate,
    });
  };
  // A previous AI narrative is not independent source evidence for a new
  // stronger-model report. Regime data and numbered observations remain.
  const result = await (deps.generateWeekly || generateWeeklyBrief)(region, { ...snapshot, narrative: undefined }, transitions, { callLlm });
  if (!result.situation_recap || !result.model) throw unavailable('invalid_report_output');
  return { ...result, sources, sourceGeneratedAt: snapshot.generated_at };
}
