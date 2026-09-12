import { getCachedJson } from './redis';
import { filterRevokedUrls, readRevokedUrlSet } from './digest-revocations';
import { sanitizeForPromptLine } from './llm-sanitize.js';

export interface SituationSource { title: string; source: string; url: string; publishedAt: string }
const QUERY_STOPWORDS = new Set('a an and are as at be by can could current data do does for from how i in is it latest likely may me might news of on or please prepare report risk situation that the their this to today update using what when where which will with worldmonitor would'.split(' '));

function itemsFromDigest(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const digest = value as Record<string, unknown>;
  const items = Array.isArray(value) ? value : Array.isArray(digest.items) ? digest.items
    : digest.categories && typeof digest.categories === 'object'
      ? Object.values(digest.categories).flatMap((bucket) => bucket && Array.isArray(bucket.items) ? bucket.items : []) : [];
  return items.filter((item) => item && typeof item === 'object');
}

/** Private jobs must resolve their evidence on the server, including operator suppression. */
export async function fetchSituationEvidence(query: string): Promise<{ context: string; sources: SituationSource[] }> {
  const [digest, revocations] = await Promise.all([
    getCachedJson('news:digest:v1:full:en', true), readRevokedUrlSet(),
  ]);
  if (!revocations.readable) return { context: '', sources: [] };
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])]
    .filter((word) => word.length > 1 && !QUERY_STOPWORDS.has(word));
  const candidates = filterRevokedUrls(itemsFromDigest(digest), revocations.urls).kept
    // A few older digest writers used url instead of link. Apply the same exact revocation rule.
    .filter((item) => !revocations.urls.has(String(item.url || '')))
    .map((item) => {
      const title = sanitizeForPromptLine(String(item.title || '')).slice(0, 180);
      const source = sanitizeForPromptLine(String(item.source || '')).slice(0, 60);
      const url = String(item.link || item.url || '');
      const date = item.pubDate ?? item.publishedAt ?? item.date;
      const timestamp = typeof date === 'number' || typeof date === 'string' ? new Date(date).getTime() : NaN;
      const tokens = new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
      const score = words.filter((word) => tokens.has(word)).length;
      if (!score || !title || !source || !Number.isFinite(timestamp)) return null;
      try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return null; } catch { return null; }
      return { score, timestamp, source: { title, source, url, publishedAt: new Date(timestamp).toISOString() } };
    }).filter((item) => item !== null).sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
  const sources: SituationSource[] = [];
  let context = 'WorldMonitor news evidence (dated source observations; coverage may be incomplete):';
  for (const candidate of candidates) {
    if (sources.length >= 4) break;
    if (sources.some((source) => source.url === candidate.source.url)) continue;
    const line = `\nSource [${sources.length + 1}]: ${JSON.stringify(candidate.source)}`;
    // The existing deduction handler caps geoContext at 2,000 characters. Never truncate a source record.
    if (context.length + line.length > 1900) continue;
    context += line;
    sources.push(candidate.source);
  }
  return { context: sources.length ? context : '', sources };
}

export function hasSupportedSituationCitations(text: string, count: number): boolean {
  const citations = [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  return citations.length > 0 && citations.every((index) => index >= 1 && index <= count)
    && !/\[\d+\s*[-,]/.test(text);
}
