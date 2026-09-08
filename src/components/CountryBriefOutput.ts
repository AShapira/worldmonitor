import { h } from '@/utils/dom-utils';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { BRIEF_TOPICS, type BriefTopic, type BriefSectionState } from './country-brief-presentation';
import briefCss from '@/styles/country-deep-dive.css?inline';

export interface BriefOutputSection {
  id: string;
  title: string;
  topics: readonly BriefTopic[];
  state: BriefSectionState;
  content: HTMLElement;
}

export interface BriefOutputSnapshot {
  country: string;
  code: string;
  capturedAt: string;
  sections: BriefOutputSection[];
  story: { title: string; content: HTMLElement }[];
}

export function freezeBriefContent(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const idMap = new Map<string, string>();
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    if (element.id) {
      const id = `export-${element.id}`;
      idMap.set(element.id, id);
      element.id = id;
    }
    element.removeAttribute('hidden');
    element.removeAttribute('tabindex');
    element.removeAttribute('aria-busy');
    if (element instanceof HTMLDetailsElement) element.open = true;
  }
  for (const element of clone.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of ['aria-labelledby', 'aria-controls', 'for']) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, value.split(' ').map(id => idMap.get(id) ?? id).join(' '));
    }
    for (const attribute of ['fill', 'clip-path', 'mask', 'filter']) {
      const value = element.getAttribute(attribute);
      if (value?.startsWith('url(#')) {
        const id = value.slice(5, -1);
        if (idMap.has(id)) element.setAttribute(attribute, `url(#${idMap.get(id)})`);
      }
    }
    if (element.getAttribute('role') === 'tablist') element.removeAttribute('role');
  }
  for (const link of clone.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href')!;
    if (href.startsWith('#')) link.setAttribute('href', `#${idMap.get(href.slice(1)) ?? href.slice(1)}`);
    else link.href = new URL(href, WEB_APP_ORIGIN).href;
  }
  for (const details of clone.querySelectorAll<HTMLElement>('script, iframe, object, embed, .cdp-summary-only, .cdp-card-help, .resilience-widget__help, .resilience-widget__retry, .cdp-inline-action')) details.remove();
  const controls = source.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
  clone.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((control, index) => {
    const original = controls[index];
    const value = original instanceof HTMLSelectElement ? original.selectedOptions[0]?.textContent ?? original.value : original?.value;
    control.replaceWith(h('span', { className: 'cdp-export-control-value' }, value ?? ''));
  });
  for (const button of clone.querySelectorAll<HTMLButtonElement>('button')) {
    const label = h('div', { className: button.className, ...(button.id ? { id: button.id } : {}) });
    label.append(...Array.from(button.childNodes));
    button.replaceWith(label);
  }
  clone.hidden = false;
  return clone;
}

const reportTheme = `
  :root{color-scheme:light;--bg:#fff;--panel-bg:#fff;--surface:#f4f6f5;--surface-hover:#e8eeea;--border:#ccd6d0;--border-subtle:#e0e6e2;--text:#17251c;--text-secondary:#344a3c;--text-dim:#344a3c;--text-muted:#55645b;--text-faint:#66746c;--green:#16a34a;--accent:#17251c;--semantic-normal:#15803d;--semantic-elevated:#946200;--semantic-high:#b45309;--semantic-critical:#b91c1c}
  *{box-sizing:border-box}body{margin:0;padding:30px;font-family:Arial,sans-serif}.cdp-output-paper{max-width:1100px;margin:auto;overflow-wrap:anywhere}.cdp-output-paper .cdp-expanded-only{display:block}.cdp-output-paper .cdp-summary-only{display:none}.cdp-output-paper [hidden]{display:none}.cdp-output-paper .cdp-card{break-inside:avoid}.cdp-output-paper .cdp-card-body,.cdp-output-paper .cdp-table-scroll,.cdp-output-paper .cdp-maritime-scroll{overflow:visible;max-height:none}.cdp-output-paper table{width:100%;border-collapse:collapse}.cdp-output-paper td,.cdp-output-paper th{padding:10px 8px;border-bottom:1px solid var(--border);text-align:left}.cdp-output-paper .cdp-output-story-slide{break-after:page;padding:32px 0;min-height:500px}.cdp-output-paper .cdp-scorecard-factor-evidence{display:block}.cdp-output-paper .cdp-scorecard-evidence{display:block}.cdp-output-paper .cdp-pro-locked{color:var(--text-muted)}.cdp-output-manifest{font-size:12px;color:var(--text-muted);padding:16px 0;border-bottom:1px solid var(--border);line-height:1.6}h1{font-size:32px}h2{font-size:24px}a{color:var(--green)}@media print{body{padding:0}a{color:inherit}.cdp-output-paper .cdp-card{break-inside:auto}.cdp-card-title{break-after:avoid}}
`;

function downloadHtml(name: string, article: HTMLElement, title: string): void {
  const doc = document.implementation.createHTMLDocument(title);
  doc.documentElement.lang = document.documentElement.lang || 'en';
  doc.head.prepend(h('meta', { charset: 'utf-8' }));
  doc.head.append(h('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' }),
    h('meta', { 'http-equiv': 'Content-Security-Policy', content: "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'" }),
    h('style', {}, briefCss, reportTheme));
  doc.body.append(article.cloneNode(true));
  const url = URL.createObjectURL(new Blob(['<!doctype html>', doc.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }));
  const link = h('a', { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function createCountryBriefOutput(snapshot: BriefOutputSnapshot, kind: 'story' | 'report', onClose: () => void): HTMLElement {
  const output = h('section', { className: 'cdp-output', 'aria-label': kind === 'story' ? 'Create a country story' : 'Export country report' });
  const close = h('button', { type: 'button', className: 'cdp-action-btn' }, '← Back to brief');
  close.addEventListener('click', onClose);
  const controls = h('div', { className: 'cdp-output-controls' });
  const paper = h('article', { className: 'cdp-output-paper' });
  const status = h('div', { role: 'status', 'aria-live': 'polite', className: 'cdp-output-feedback' });
  let selectedTopic: BriefTopic = 'all';
  let slide = 0;
  const selected = () => snapshot.sections.filter(section => selectedTopic === 'all' || section.topics.includes(selectedTopic));
  const heading = () => h('header', {}, h('p', { className: 'cdp-country-subtitle' }, 'WORLD MONITOR · COUNTRY BRIEF'),
    h('h1', {}, snapshot.country), h('p', { className: 'cdp-measure-note' }, `Captured ${new Date(snapshot.capturedAt).toLocaleString()} · ${snapshot.code}`));
  const renderReport = (): void => {
    const sections = selected();
    const incomplete = sections.filter(section => section.state !== 'ready');
    paper.replaceChildren(heading(), h('div', { className: 'cdp-output-manifest' },
      `${BRIEF_TOPICS[selectedTopic]} · ${sections.length} sections. This snapshot keeps each source date and the currently selected scenario/product. `,
      incomplete.length ? `${incomplete.length} sections incomplete: ${incomplete.map(section => `${section.title} (${section.state})`).join(', ')}.` : 'All selected sections are available.'),
    ...sections.map(section => section.content.cloneNode(true)));
  };
  const renderStory = (): void => {
    const item = snapshot.story[slide]!;
    paper.replaceChildren(heading(), h('div', { className: 'cdp-output-story-slide' },
      h('p', { className: 'cdp-country-subtitle' }, `${slide + 1} / ${snapshot.story.length}`),
      h('h2', {}, item.title), item.content.cloneNode(true)),
    h('p', { className: 'cdp-output-manifest' }, 'A snapshot of this country brief. Source dates and evidence coverage vary. See the full report for supporting details.'));
  };
  if (kind === 'report') {
    const scope = h('select', { 'aria-label': 'Report scope' }) as HTMLSelectElement;
    for (const [topic, label] of Object.entries(BRIEF_TOPICS)) scope.append(h('option', { value: topic, selected: topic === 'all' }, topic === 'overview' ? 'Overview & scores' : label));
    scope.addEventListener('change', () => { selectedTopic = scope.value as BriefTopic; renderReport(); });
    controls.append(h('label', {}, 'Report scope', scope));
    renderReport();
  } else {
    const previous = h('button', { type: 'button', 'aria-label': 'Previous story slide' }, '←');
    const next = h('button', { type: 'button', 'aria-label': 'Next story slide' }, '→');
    const counter = h('span', {}, `1 / ${snapshot.story.length}`);
    const change = (step: number): void => {
      slide = (slide + step + snapshot.story.length) % snapshot.story.length;
      counter.textContent = `${slide + 1} / ${snapshot.story.length}`;
      renderStory();
    };
    previous.addEventListener('click', () => change(-1));
    next.addEventListener('click', () => change(1));
    controls.append(h('p', {}, 'One country snapshot. Review every slide before downloading.'), previous, counter, next);
    renderStory();
  }
  const download = h('button', { type: 'button', className: 'cdp-action-btn cdp-export-primary' }, kind === 'story' ? 'Download story HTML' : 'Download report HTML');
  download.addEventListener('click', () => {
    const article = kind === 'report' ? paper : h('article', { className: 'cdp-output-paper' }, heading(),
      ...snapshot.story.map(item => h('section', { className: 'cdp-output-story-slide' }, h('h2', {}, item.title), item.content.cloneNode(true))));
    downloadHtml(`${snapshot.code.toLowerCase()}-${kind}-${snapshot.capturedAt.slice(0, 10)}.html`, article, `${snapshot.country} · ${kind}`);
    status.textContent = `Downloaded ${kind}. Open the HTML file to print or save as PDF.`;
  });
  controls.append(download, status);
  output.append(h('header', { className: 'cdp-output-header' }, close, h('h2', {}, kind === 'story' ? 'Create a story' : 'Export report')),
    h('div', { className: 'cdp-output-layout' }, controls, paper));
  return output;
}
