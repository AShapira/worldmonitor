// Collection and report generation have different clocks. A paused model must
// not freeze incoming headlines or make an old report look newly generated.
export function retainInsightsBrief(fresh, previous) {
  const generatedAt = previous?.briefGeneratedAt || previous?.generatedAt;
  const sources = previous?.worldBriefSources;
  const text = previous?.worldBrief;
  const citations = typeof text === 'string' ? [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])) : [];
  const sourceComplete = Array.isArray(sources) && sources.length > 0 && sources.every((source) => {
    try { return source.title && source.source && ['https:', 'http:'].includes(new URL(source.url).protocol); }
    catch { return false; }
  });
  const canRetain = typeof text === 'string' && text.trim() && previous?.briefModel && previous?.briefProvider
    && typeof generatedAt === 'string' && Number.isFinite(Date.parse(generatedAt))
    && sourceComplete && citations.length > 0 && citations.every((n) => n >= 1 && n <= sources.length);
  if (!canRetain) return { ...fresh, worldBrief: '', worldBriefSources: [], briefStoryLines: [], sourceAgeRange: null,
    briefProvider: '', briefModel: '', briefGeneratedAt: null, briefStatus: 'unavailable', status: 'degraded' };
  return { ...fresh,
    worldBrief: text, worldBriefSources: structuredClone(sources),
    briefStoryLines: structuredClone(previous.briefStoryLines || []), sourceAgeRange: structuredClone(previous.sourceAgeRange || null),
    briefProvider: previous.briefProvider, briefModel: previous.briefModel, briefGeneratedAt: generatedAt,
    briefTopStories: structuredClone(previous.briefTopStories || previous.topStories || []),
    briefStatus: 'retained', status: 'degraded',
  };
}
