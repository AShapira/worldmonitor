// Keep report evidence and generation time together when automatic inference
// is paused. Never attach a previous narrative to newly observed evidence.
export function retainNarrative(previous) {
  if (!previous || typeof previous !== 'object') return null;
  const candidate = previous.retained_narrative || {
    generated_at: previous.generated_at,
    snapshot_id: previous.meta?.snapshot_id,
    provider: previous.meta?.narrative_provider,
    model: previous.meta?.narrative_model,
    evidence: previous.evidence,
    narrative: previous.narrative,
  };
  if (!Number.isFinite(candidate.generated_at) || candidate.generated_at <= 0
    || !candidate.snapshot_id || !candidate.model || !candidate.provider
    || !Array.isArray(candidate.evidence) || !candidate.evidence.length || !candidate.narrative) return null;
  const ids = new Set(candidate.evidence.filter((e) => typeof e.id === 'string' && e.id && e.summary && e.source).map((e) => e.id));
  const sections = ['situation', 'balance_assessment', 'outlook_24h', 'outlook_7d', 'outlook_30d']
    .map((key) => candidate.narrative[key]);
  sections.push(...(candidate.narrative.watch_items || []));
  if (sections.some((section) => !section || typeof section.text !== 'string' || !section.text.trim()
    || !Array.isArray(section.evidence_ids) || !section.evidence_ids.length
    || section.evidence_ids.some((id) => !ids.has(id)))) return null;
  return structuredClone(candidate);
}
