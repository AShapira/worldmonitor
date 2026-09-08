import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  briefGroundingGap,
  briefGroundingPublisherCount,
  COUNTRY_INDEX_ORIGIN,
  developmentsHasDatedItem,
  hasBriefGrounding,
  isVerifiableArticleUrl,
  MIN_BRIEF_GROUNDING_PUBLISHERS,
  normalizeBriefText,
  normalizeFrozenDevelopments,
  registrableDomain,
} from '../scripts/crawlable-developments.mjs';
import { isVerifiableArticleUrl as freezeIsVerifiableArticleUrl } from '../scripts/freeze-crawlable-live-pulse.mjs';

// Shapes taken from the 2026-09-04 frozen snapshot: 32 of 40 briefs carried
// `**` markers, 23 carried the ISO code in the "WHAT THIS MEANS FOR" heading,
// and Georgia's opened with an "INTELLIGENCE BRIEF / CLASSIFICATION:
// CONFIDENTIAL" preamble (#7738, #7748).
const NORWAY_RAW = [
  'SITUATION NOW',
  'Norway’s $2 trillion fund proposed cutting U.S. Treasury holdings [1][2].',
  '',
  'WHAT THIS MEANS FOR NO',
  '• **Norges Bank Investment Management (NBIM)**: Proposed slashing of holdings — billions moved [1][2].',
  '• **Norwegian krone**: could strengthen temporarily.',
  '',
  'KEY RISKS',
  '- **Retaliation**: Moscow may respond.',
  '',
  'OUTLOOK',
  'NEXT 24H: Pushback from U.S. Treasury officials.',
  'NEXT 48H: Security measures in the Barents Sea.',
  '',
  'WATCH ITEMS',
  'NBIM announcement · Russian maritime declarations',
].join('\n');

const GEORGIA_RAW = [
  '**INTELLIGENCE BRIEF: GE (GEORGIA)**',
  '**DATE:** 2026-09-04',
  '**CLASSIFICATION:** CONFIDENTIAL',
  '',
  '**SITUATION NOW**',
  'Georgia faces an energy inflection point [1].',
  '',
  '**WHAT THIS MEANS FOR GE**',
  '- **Black Sea Petroleum terminal:** cessation of Russian crude processing.',
].join('\n');

describe('normalizeBriefText', () => {
  it('strips markdown emphasis, keeps structure, and repairs the coded heading', () => {
    const text = normalizeBriefText(NORWAY_RAW, { countryCode: 'NO', countryName: 'Norway' });
    assert.ok(!text.includes('**'));
    assert.ok(text.includes('WHAT THIS MEANS FOR NORWAY'));
    assert.ok(!/\bFOR NO\b/.test(text));
    assert.ok(text.startsWith('SITUATION NOW\n'));
    assert.ok(text.includes('• Norges Bank Investment Management (NBIM): Proposed slashing'));
    assert.ok(text.includes('NEXT 24H: Pushback'));
    assert.ok(text.endsWith('NBIM announcement · Russian maritime declarations'));
  });

  it('repairs ISO headings regardless of letter case', () => {
    for (const heading of ['What this means for NO', 'What this means for no', 'WHAT THIS MEANS FOR NO']) {
      const text = normalizeBriefText(`${heading}\nNorway updates shipping rules [1][2].`, {
        countryCode: 'NO', countryName: 'Norway',
      });
      assert.equal(text, 'WHAT THIS MEANS FOR NORWAY\nNorway updates shipping rules [1][2].');
    }
  });

  it('drops a model preamble before the first contract section', () => {
    const text = normalizeBriefText(GEORGIA_RAW, { countryCode: 'GE', countryName: 'Georgia' });
    assert.ok(text.startsWith('SITUATION NOW\n'), `preamble must go, got: ${text.slice(0, 40)}`);
    assert.ok(!text.includes('CLASSIFICATION'));
    assert.ok(!text.includes('INTELLIGENCE BRIEF'));
    assert.ok(text.includes('WHAT THIS MEANS FOR GEORGIA'));
  });

  it('keeps a cited lead the model wrote under its own header name', () => {
    const text = normalizeBriefText('CURRENT SITUATION\nConvoys move under escort [1].\n\nKEY RISKS\n• item', { countryCode: 'SD', countryName: 'Sudan' });
    assert.ok(text.startsWith('CURRENT SITUATION\nConvoys move under escort [1].'), 'a cited paragraph is content, not theatre');
  });

  it('keeps a brief that has no contract sections at all', () => {
    const prose = 'Two paragraphs of plain analysis [1].\n\nSecond paragraph.';
    assert.equal(normalizeBriefText(prose, { countryCode: 'NO', countryName: 'Norway' }), prose);
  });

  it('strips every markdown marker the model reaches for, not just the one first reported', () => {
    const text = normalizeBriefText('## SITUATION NOW\n__Port Sudan__ closed [1].\n* **Convoys** rerouted.', { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(text, 'SITUATION NOW\nPort Sudan closed [1].\n* Convoys rerouted.');
  });

  it('repairs the heading only for the page country and only when a name is known', () => {
    const foreign = normalizeBriefText('WHAT THIS MEANS FOR SD\n• item', { countryCode: 'NO', countryName: 'Norway' });
    assert.ok(foreign.includes('WHAT THIS MEANS FOR SD'), 'another country code is not this page’s to rewrite');
    const unnamed = normalizeBriefText('WHAT THIS MEANS FOR NO\n• item', { countryCode: 'NO', countryName: '' });
    assert.ok(unnamed.includes('WHAT THIS MEANS FOR NO'), 'without a name there is nothing to repair with');
    const trailing = normalizeBriefText('WHAT THIS MEANS FOR ES  \n• item', { countryCode: 'ES', countryName: 'Spain' });
    assert.ok(trailing.includes('WHAT THIS MEANS FOR SPAIN'));
    const named = normalizeBriefText('WHAT THIS MEANS FOR NORWAY\n• item', { countryCode: 'NO', countryName: 'Norway' });
    assert.ok(named.includes('WHAT THIS MEANS FOR NORWAY'));
  });

  it('is idempotent', () => {
    const once = normalizeBriefText(NORWAY_RAW, { countryCode: 'NO', countryName: 'Norway' });
    assert.equal(normalizeBriefText(once, { countryCode: 'NO', countryName: 'Norway' }), once);
  });
});

describe('brief grounding floor', () => {
  it('counts distinct publisher families, never raw source labels', () => {
    // Egypt's committed brief cleared a raw count on three Egypt Independent
    // articles; three labels from one newsroom are one publisher (#6428).
    assert.equal(MIN_BRIEF_GROUNDING_PUBLISHERS, 2);
    const egypt = ['Egypt Independent', 'Egypt Independent', 'Egypt Independent'].map((source) => ({ source }));
    assert.equal(briefGroundingPublisherCount(egypt), 1);
    assert.equal(hasBriefGrounding(egypt), false);
    assert.equal(briefGroundingPublisherCount([{ source: 'BBC World' }, { source: 'BBC Africa' }]), 1, 'two editions of one newsroom are one family');
    assert.equal(hasBriefGrounding([{ source: 'UN News' }, { source: 'Test Wire' }]), true);
    assert.equal(hasBriefGrounding([]), false);
    assert.equal(hasBriefGrounding(null), false);
  });

  it('counts two rows on one site as one publisher whatever their labels say', () => {
    // GDELT index rows (#7748) carry the publishing domain as their label,
    // digest rows carry a feed label: "Guardian ME" and "theguardian.com"
    // are one newsroom, and the floor must not clear on it twice.
    const mixed = [
      { source: 'Guardian ME', url: 'https://www.theguardian.com/world/2026/sep/03/a' },
      { source: 'theguardian.com', url: 'https://www.theguardian.com/world/2026/sep/04/b' },
    ];
    assert.equal(briefGroundingPublisherCount(mixed), 1);
    assert.equal(hasBriefGrounding(mixed), false);
    // Editions on different hosts still fold through the family table.
    assert.equal(briefGroundingPublisherCount([
      { source: 'BBC World', url: 'https://www.bbc.co.uk/news/a' },
      { source: 'BBC Africa', url: 'https://www.bbc.com/news/b' },
    ]), 1);
    // Two genuinely different sites are two publishers, including
    // second-level country TLDs that a naive "last two labels" rule folds.
    assert.equal(briefGroundingPublisherCount([
      { source: 'rnz.co.nz', url: 'https://www.rnz.co.nz/news/pacific/1' },
      { source: 'abc.net.au', url: 'https://www.abc.net.au/news/2' },
    ]), 2);
    assert.equal(briefGroundingPublisherCount([
      { source: 'rnz.co.nz', url: 'https://www.rnz.co.nz/news/pacific/1' },
      { source: 'stuff.co.nz', url: 'https://www.stuff.co.nz/world/2' },
    ]), 2, 'rnz.co.nz and stuff.co.nz share a suffix, not a site');
    // A row without a usable URL counts by label alone.
    assert.equal(briefGroundingPublisherCount([
      { source: 'UN News' },
      { source: 'Test Wire', url: 'not a url' },
    ]), 2);
    // A shared host bridges two labels into one family transitively.
    assert.equal(briefGroundingPublisherCount([
      { source: 'Wire A', url: 'https://news.example/a' },
      { source: 'Wire B', url: 'https://news.example/b' },
      { source: 'Wire B', url: 'https://other.example/c' },
    ]), 1);
  });

  it('resolves a curated newsroom by its domains, so two BBC hosts are one publisher', () => {
    // A digest label and an index row labelled by domain, on two different
    // registrable domains of one newsroom (review of #7748).
    assert.equal(briefGroundingPublisherCount([
      { source: 'BBC World', url: 'https://www.bbc.com/news/world-1' },
      { source: 'bbc.co.uk', url: 'https://www.bbc.co.uk/news/uk-2' },
    ]), 1);
    assert.equal(briefGroundingPublisherCount([
      { source: 'apnews.com', url: 'https://apnews.com/article/x' },
      { source: 'AP News', url: 'https://apnews.com/article/y' },
      { source: 'Reuters World', url: 'https://www.reuters.com/world/z' },
    ]), 2);
    // A subdomain edition folds into its newsroom.
    assert.equal(briefGroundingPublisherCount([
      { source: 'Guardian World', url: 'https://www.theguardian.com/world/a' },
      { source: 'amp.theguardian.com', url: 'https://amp.theguardian.com/world/b' },
    ]), 1);
  });

  it('never treats an aggregator redirect host as a site', () => {
    // Canada's committed brief: three Google News redirect rows from two
    // families. A redirect host is not a site two labels can share.
    assert.equal(briefGroundingPublisherCount([
      { source: 'Reuters India', url: 'https://news.google.com/rss/articles/a' },
      { source: 'Reuters World', url: 'https://news.google.com/rss/articles/b' },
      { source: 'Gold & Metals', url: 'https://news.google.com/rss/articles/c' },
    ]), 2);
    assert.equal(isVerifiableArticleUrl('https://news.google.com/rss/articles/a'), false);
    assert.equal(isVerifiableArticleUrl('https://www.rnz.co.nz/news/a'), true);
    assert.equal(isVerifiableArticleUrl('http://www.rnz.co.nz/news/a'), false);
    assert.equal(freezeIsVerifiableArticleUrl, isVerifiableArticleUrl, 'the freeze re-exports the shared rule for the welcome strip');
  });

  it('requires a curated row behind a brief: index rows corroborate, they do not ground', () => {
    const index = (n, host) => ({
      title: `Story ${n}`, source: host, url: `https://${host}/${n}`, publishedAt: '2026-09-02T10:00:00.000Z', origin: COUNTRY_INDEX_ORIGIN,
    });
    const digest = { title: 'Digest story', source: 'Test Wire', url: 'https://wire.test/d', publishedAt: '2026-09-02T10:00:00.000Z' };
    assert.equal(briefGroundingGap([index(1, 'rnz.co.nz'), index(2, 'abc.net.au')]), 'uncurated-grounding');
    assert.equal(hasBriefGrounding([index(1, 'rnz.co.nz'), index(2, 'abc.net.au')]), false);
    assert.equal(briefGroundingGap([digest, index(1, 'rnz.co.nz')]), null);
    assert.equal(hasBriefGrounding([digest, index(1, 'rnz.co.nz')]), true);
    assert.equal(briefGroundingGap([digest]), 'thin-grounding', 'the publisher count is checked first');
    assert.equal(briefGroundingGap([index(1, 'rnz.co.nz')]), 'thin-grounding');
    // The publish-time rule withholds the brief with the same reason.
    const row = {
      headlines: [index(1, 'rnz.co.nz'), index(2, 'abc.net.au')],
      brief: { text: 'SITUATION NOW\nCalm [1].', model: 'm', generatedAt: '2026-09-02T12:00:00.000Z', sources: [index(1, 'rnz.co.nz'), index(2, 'abc.net.au')] },
      timeline: [],
      briefSkipped: null,
    };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'NR', countryName: 'Nauru' });
    assert.equal(out.brief, null);
    assert.equal(out.briefSkipped, 'uncurated-grounding');
    assert.equal(out.headlines.length, 2, 'the dated headlines stay');
  });

  it('derives registrable domains with second-level suffixes intact', () => {
    assert.equal(registrableDomain('https://www.bbc.co.uk/news/a'), 'bbc.co.uk');
    assert.equal(registrableDomain('https://amp.theguardian.com/world/b'), 'theguardian.com');
    assert.equal(registrableDomain('https://www.abc.net.au/news/c'), 'abc.net.au');
    assert.equal(registrableDomain('https://example.test/x'), 'example.test');
    assert.equal(registrableDomain('not a url'), '');
  });
});

describe('developmentsHasDatedItem', () => {
  it('counts a headline, a brief with text, or a timeline event, and nothing else', () => {
    const headline = { title: 't', source: 's', url: 'https://example.test/a', publishedAt: '2026-09-02T10:00:00.000Z' };
    assert.equal(developmentsHasDatedItem({ headlines: [headline], brief: null, timeline: [] }), true);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: { text: 'SITUATION NOW' }, timeline: null }), true);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: null, timeline: [{ title: 'e' }] }), true);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: { text: '  ' }, timeline: [] }), false);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: null, timeline: null, briefSkipped: 'no-grounding' }), false);
    assert.equal(developmentsHasDatedItem(null), false);
  });
});

describe('normalizeFrozenDevelopments', () => {
  // Distinct hosts per wire: rows on one site are one publisher (#7748).
  const source = (n) => ({
    title: `Story ${n}`,
    source: `Wire ${n}`,
    url: `https://wire${n}.test/${n}`,
    publishedAt: '2026-09-02T10:00:00.000Z',
  });
  const brief = (sources) => ({
    text: 'SITUATION NOW\n**Bold** claim [1].\n\nWHAT THIS MEANS FOR SD\n• item',
    model: 'm',
    generatedAt: '2026-09-02T12:00:00.000Z',
    sources,
  });

  it('withholds a brief grounded on fewer than the floor and records why', () => {
    const row = { headlines: [source(1)], brief: brief([source(1)]), timeline: [], briefSkipped: null };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(out.brief, null);
    assert.equal(out.briefSkipped, 'thin-grounding');
    assert.deepEqual(out.headlines, row.headlines, 'the dated headline stays');
    assert.equal(row.brief !== null, true, 'the input is not mutated');
    // Two sources from one publisher are still one publisher.
    const oneOutlet = { ...row, brief: brief([source(1), { ...source(2), source: 'Wire 1' }]) };
    assert.equal(normalizeFrozenDevelopments(oneOutlet, { countryCode: 'SD', countryName: 'Sudan' }).brief, null);
  });

  it('normalizes the text of a sufficiently grounded brief and keeps its sources', () => {
    const row = { headlines: [source(1), source(2)], brief: brief([source(1), source(2)]), timeline: [], briefSkipped: null };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(out.briefSkipped, null);
    assert.equal(out.brief.sources.length, 2);
    assert.ok(!out.brief.text.includes('**'));
    assert.ok(out.brief.text.includes('WHAT THIS MEANS FOR SUDAN'));
    assert.equal(out.brief.generatedAt, '2026-09-02T12:00:00.000Z');
  });

  it('clears markdown markers from every published string, not only the brief', () => {
    // The build guard reads the whole <main>; one marker in a timeline
    // summary would otherwise fail a complete weekly capture.
    const row = {
      headlines: [{ ...source(1), title: '**Breaking**: convoys move' }],
      brief: brief([source(1), { ...source(2), title: '__Darfur__ harvest outlook' }]),
      timeline: [{ title: 'Port call **logged**', summary: 'A __scheduled__ call', sourceUrl: 'https://example.test/t', occurredAt: '2026-09-02T06:00:00.000Z', domain: 'maritime' }],
      briefSkipped: null,
    };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(out.headlines[0].title, 'Breaking: convoys move');
    assert.equal(out.brief.sources[1].title, 'Darfur harvest outlook');
    assert.equal(out.timeline[0].title, 'Port call logged');
    assert.equal(out.timeline[0].summary, 'A scheduled call');
    assert.equal(out.headlines[0].url, row.headlines[0].url, 'URLs are untouched');
    assert.equal(row.headlines[0].title, '**Breaking**: convoys move', 'the input is not mutated');
  });

  it('hands a malformed sources field back untouched for the renderer to reject', () => {
    for (const sources of [undefined, null, 'UN News', [{ title: 'no outlet', url: 'https://example.test/x' }]]) {
      const row = { headlines: [source(1)], brief: { ...brief([]), sources }, timeline: [], briefSkipped: null };
      const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
      assert.deepEqual(out.brief, row.brief, `sources=${JSON.stringify(sources)} must not be withheld as thin grounding`);
      assert.equal(out.briefSkipped, null);
    }
  });

  it('passes rows without a brief through unchanged', () => {
    const row = { headlines: [], brief: null, timeline: null, briefSkipped: 'no-grounding' };
    assert.deepEqual(normalizeFrozenDevelopments(row, { countryCode: 'PW', countryName: 'Palau' }), row);
    assert.equal(normalizeFrozenDevelopments(null, {}), null);
    assert.equal(normalizeFrozenDevelopments(undefined, {}), undefined);
  });
});
