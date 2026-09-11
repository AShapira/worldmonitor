import type { Page, TestInfo } from '@playwright/test';
import { test, expect, HYDRATED_MARKET } from './country-brief-fixtures';
import { readFile } from 'node:fs/promises';
import { installCountryBriefDesignData } from './country-brief-design-fixtures';

test.use({ trace: 'on', serviceWorkers: 'block' });

function marketsCard(page: Page) {
  return page.locator('#country-deep-dive-panel .cdp-card').filter({
    has: page.getByRole('heading', { name: 'Prediction Markets', exact: true }),
  });
}

async function expectCountry(page: Page) {
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.cdp-country-name')).toHaveText('Ukraine');
  await expect(panel.locator('.cdp-country-name')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBe('UA');
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Economy & trade', exact: true }).click();
}

async function expectMarkets(page: Page) {
  const card = marketsCard(page);
  await expect(card.locator('.cdp-market-title')).toHaveText([
    'Ukraine QA ceasefire agreement?', 'Ukraine QA reconstruction funding?',
  ]);
  await expect(card.locator('.cdp-market-prob')).toHaveText(['Probability: 67%', 'Probability: 38%']);
  await expect(card.locator('.prediction-source')).toHaveText(['Polymarket', 'Kalshi']);
  await expect(card.locator('.cdp-market-link').nth(0)).toHaveAttribute('href', 'https://polymarket.com/event/qa-ua-ceasefire');
  await expect(card.locator('.cdp-market-link').nth(1)).toHaveAttribute('href', 'https://kalshi.com/markets/qa-ua-funding');
  await expect(card.locator('.cdp-loading-inline, .cdp-empty')).toHaveCount(0);
  await expect(card.locator('.cdp-market-item').nth(0)).toBeVisible();
  await expect(card.locator('.cdp-market-item').nth(1)).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await marketsCard(page).scrollIntoViewIfNeeded();
  await marketsCard(page).evaluate(card => card.scrollIntoView({ block: 'center' }));
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('country brief renders exact RPC records and preserves the country after reload', async ({ page, countryBrief }, testInfo) => {
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expectMarkets(page);
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'rpc-before-reload');

  const requestsBeforeReload = countryBrief.requests.length;
  if (countryBrief.fault === 'drop-reload-country') {
    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.delete('country');
      history.replaceState(null, '', url);
    });
  }
  await page.reload();
  await expectCountry(page);
  await expectMarkets(page);
  expect(countryBrief.requests.length).toBeGreaterThan(requestsBeforeReload);
  expect(countryBrief.requests.every(request => request.category === 'country:UA' && request.status === 200)).toBe(true);
  await screenshot(page, testInfo, 'rpc-after-reload');
});

test('country brief uses bootstrap fallback when the country index is unavailable', async ({ page, countryBrief }, testInfo) => {
  countryBrief.hydrate = true;
  countryBrief.response = { markets: [], dataAvailable: false, fetchedAt: 0 };
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  const card = marketsCard(page);
  await expect(card.locator('.cdp-market-title')).toHaveText([HYDRATED_MARKET.title]);
  await expect(card.locator('.cdp-market-prob')).toHaveText(['Probability: 54%']);
  await expect(card.locator('.prediction-source')).toHaveText(['Polymarket']);
  await expect(card.locator('.cdp-market-link')).toHaveAttribute('href', HYDRATED_MARKET.url);
  await expect(card.locator('.cdp-market-item')).toBeVisible();
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'bootstrap-fallback');
});

test('country brief honors an authoritative empty index over bootstrap fallback', async ({ page, countryBrief }, testInfo) => {
  countryBrief.hydrate = true;
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expect(marketsCard(page).locator('.cdp-empty')).toHaveText('No active markets for this country.');
  await expect(marketsCard(page).locator('.cdp-market-item, .cdp-loading-inline')).toHaveCount(0);
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'authoritative-empty');
});

test('country brief recovers from a failed RPC when the user reloads', async ({ page, countryBrief }, testInfo) => {
  countryBrief.status = 503;
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expect(marketsCard(page).locator('.cdp-empty')).toHaveText('No active markets for this country.');
  await expect(marketsCard(page).locator('.cdp-market-item, .cdp-loading-inline')).toHaveCount(0);
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 503 });
  await screenshot(page, testInfo, 'rpc-failure');

  countryBrief.status = 200;
  await page.reload();
  await expectCountry(page);
  await expectMarkets(page);
  expect(countryBrief.requests[countryBrief.requests.length - 1]).toEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'rpc-recovered');
});

test('US brief keeps late evidence, metric design and report data connected', async ({ page, countryBrief }, testInfo) => {
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  const data = await installCountryBriefDesignData(page);
  await page.goto('/dashboard?country=US&expanded=1');
  const panel = page.locator('#country-deep-dive-panel');
  const topic = (name: string) => panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name, exact: true });
  await expect(panel.locator('.cdp-country-name')).toHaveText('United States');
  await expect(panel.locator('#cdp-section-factors')).toHaveAttribute('aria-busy', 'true');
  await topic('Economy & trade').click();
  const housing = panel.locator('#cdp-section-housing');
  await expect(housing.locator('.cdp-metric-hero')).toHaveText(['156.4', '186.6', '8.0']);
  await expect(housing).toContainText('-2.1% · ↓ Falling');
  await expect(housing).toContainText('BIS · 2026-Q1');
  await expect(panel.locator('#cdp-section-debt .cdp-metric-hero')).toHaveText('128.6%');
  await expect(panel.locator('#cdp-section-debt')).toContainText('source value needs review');
  await expect(panel.locator('#cdp-section-tariffs')).toContainText('→ Unchanged');
  data.releaseFactors();
  await expect(panel.locator('#cdp-section-factors')).toHaveAttribute('aria-busy', 'false');
  await expect(topic('Economy & trade')).toHaveAttribute('aria-current', 'page');
  await housing.scrollIntoViewIfNeeded();
  await testInfo.attach('housing-desktop', { body: await page.screenshot({ path: testInfo.outputPath('housing-desktop.png') }), contentType: 'image/png' });
  await topic('Overview').click();
  const factors = panel.locator('#cdp-section-factors');
  await expect(factors.getByRole('tab')).toHaveCount(5);
  await expect(factors.locator('.cdp-scorecard-score')).toHaveText(['5/5', '4/5', '4/5', '5/5', '5/5']);
  await factors.getByRole('tab', { name: /Food/ }).focus();
  await page.keyboard.press('End');
  await expect(factors.getByRole('tab', { name: /Defense/ })).toBeFocused();
  await expect(factors.getByRole('tabpanel', { name: /Defense/ })).toContainText('65% coverage');
  await expect(factors.getByRole('tabpanel', { name: /Defense/ })).toContainText('Arms supplier diversity');
  await expect(factors.locator('.cdp-scorecard-input')).toHaveCount(27);
  await expect(panel.locator('#cdp-section-assessment .cdp-summary-only').first()).toContainText('The United States has attacked three Iranian oil tankers');
  await expect(panel.locator('#cdp-section-assessment .cdp-summary-only').first()).not.toContainText('Classification:');
  await factors.scrollIntoViewIfNeeded();
  await testInfo.attach('factors-desktop', { body: await page.screenshot({ path: testInfo.outputPath('factors-desktop.png') }), contentType: 'image/png' });
  let releaseOutput: () => void = () => {};
  let outputRequested = false;
  const outputReady = new Promise<void>(resolve => { releaseOutput = resolve; });
  await page.route('**/src/components/CountryBriefOutput.ts*', async route => {
    outputRequested = true;
    await outputReady;
    await route.continue();
  });
  await panel.getByRole('button', { name: 'Export report ↗', exact: true }).click();
  await expect.poll(() => outputRequested).toBe(true);
  await panel.getByRole('button', { name: 'Create story', exact: true }).click();
  releaseOutput();
  await expect(panel.locator('.cdp-output')).toHaveCount(1);
  await expect(panel.locator('.cdp-output')).toHaveAccessibleName('Export country report');
  await expect(panel.locator('.cdp-output-paper .cdp-scorecard-input')).toHaveCount(27);
  await expect(panel.locator('.cdp-output-paper')).toContainText('128.6%');
  await expect(panel.locator('.cdp-output-paper')).toContainText('156.4');
  const downloadEvent = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download report HTML', exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
  const html = await readFile(testInfo.outputPath(download.suggestedFilename()), 'utf8');
  expect(html).toContain('Arms supplier diversity');
  expect(html).toContain('BIS · 2026-Q1');
  expect(html).toContain('IMF WEO 2027');
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).not.toContain('<script');
  const savedReport = await page.context().newPage();
  await savedReport.route('http://brief-export.test/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await savedReport.goto('http://brief-export.test/');
  await expect(savedReport.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /default-src 'none'/);
  await savedReport.evaluate(() => {
    const probe = document.createElement('script');
    probe.textContent = "document.body.dataset.exportScriptRan='true'";
    document.body.append(probe);
  });
  await expect(savedReport.locator('body')).not.toHaveAttribute('data-export-script-ran', 'true');
  await expect(savedReport.locator('.cdp-scorecard-input')).toHaveCount(27);
  await expect(savedReport.locator('#export-cdp-section-housing')).toContainText('BIS · 2026-Q1');
  await savedReport.setViewportSize({ width: 390, height: 844 });
  expect(await savedReport.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await savedReport.close();
  await panel.getByRole('button', { name: '← Back to brief', exact: true }).click();
  await expect(panel).toHaveClass(/maximized/);
  await expect(factors.getByRole('tab', { name: /Defense/ })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('button', { name: 'Create story', exact: true }).click();
  await expect(panel.locator('.cdp-output-paper')).toContainText('The United States has attacked three Iranian oil tankers');
  await panel.getByRole('button', { name: 'Next story slide', exact: true }).click();
  await expect(panel.locator('.cdp-output-paper')).toContainText('65% coverage');
  await page.keyboard.press('Escape');
  await expect(panel.locator('.cdp-shell')).toBeVisible();
  await expect(panel).toHaveClass(/maximized/);
  await page.setViewportSize({ width: 390, height: 844 });
  await factors.scrollIntoViewIfNeeded();
  const overflow = await panel.evaluate(element => {
    const content = element.querySelector('#deep-dive-content')!;
    return content.scrollWidth - content.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(195, 820)?.closest('#country-deep-dive-panel')))).toBe(true);
  await testInfo.attach('factors-mobile', { body: await page.screenshot({ path: testInfo.outputPath('factors-mobile.png') }), contentType: 'image/png' });
});

test('limited country coverage stays navigable and China keeps its own section', async ({ page, countryBrief }, testInfo) => {
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  const data = await installCountryBriefDesignData(page);
  data.releaseFactors();
  await page.goto('/dashboard?country=LS&expanded=1');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel.locator('.cdp-country-name')).toHaveText('Lesotho');
  await expect(panel.locator('#cdp-section-factors')).toHaveAttribute('data-load-state', 'unavailable');
  await expect(panel.locator('#cdp-section-factors')).toContainText('Five-factor scorecard unavailable.');
  await expect(panel.locator('.cdp-scorecard-score')).toHaveCount(0);
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'All sections', exact: true }).click();
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(23);
  await expect(panel.locator('#cdp-section-facts')).not.toContainText('Washington');
  await expect(panel.locator('#cdp-section-assessment')).not.toContainText('UNITED STATES');
  for (const id of ['maritime', 'trade', 'scenario']) {
    await expect(panel.locator(`#cdp-section-${id}`)).toHaveAttribute('data-load-state', 'unavailable');
  }
  await expect(panel.locator('#cdp-section-china')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(panel.locator('#cdp-section-housing')).toBeHidden();
  await expect(panel.locator('#cdp-section-assessment')).toBeVisible();
  await panel.getByRole('button', { name: 'Full brief', exact: true }).click();
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(23);
  await expect(panel.locator('#cdp-section-housing')).toBeVisible();
  await page.goto('/dashboard?country=CN&expanded=1');
  await expect(panel.locator('.cdp-country-name')).toHaveText('China');
  await expect(panel.locator('#cdp-section-china')).toBeVisible();
  await expect(panel.locator('.cdp-scorecard-score')).toHaveCount(0);
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'All sections', exact: true }).click();
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(24);
  await testInfo.attach('china-sections', { body: await page.screenshot({ path: testInfo.outputPath('china-sections.png') }), contentType: 'image/png' });
  expect(data.countriesRequested).toContain('LS');
  expect(data.countriesRequested).toContain('CN');
});
