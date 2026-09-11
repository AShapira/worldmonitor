import type { Page } from '@playwright/test';
import us from './fixtures/country-brief-us.json' with { type: 'json' };

export async function installCountryBriefDesignData(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wm-pro-key', 'e2e-country-brief-design'));
  let releaseFactors: () => void = () => {};
  const factorsReady = new Promise<void>(resolve => { releaseFactors = resolve; });
  const countriesRequested: string[] = [];
  await page.route('**/api/scorecard/v1/get-five-factor-scorecard*', async route => {
    const code = new URL(route.request().url()).searchParams.get('countryCode') ?? '';
    countriesRequested.push(code);
    await factorsReady;
    await route.fulfill({ json: code === 'US' ? us.scorecard : { unavailable: true, unavailableReason: 'snapshot-unavailable' } });
  });
  await page.route('**/api/intelligence/v1/get-country-intel-brief*', route => route.fulfill({ json:
    new URL(route.request().url()).searchParams.get('country_code') === 'US' ? us.brief : { brief: '' },
  }));
  await page.route('**/api/intelligence/v1/get-country-facts*', route => route.fulfill({ json:
    new URL(route.request().url()).searchParams.get('country_code') !== 'US' ? {} : {
    countryCode: 'US', countryName: 'United States', capital: 'Washington, D.C.', population: '340100000',
    areaSqKm: 9826675, languages: ['English'], currencies: ['US dollar'], headOfState: '', headOfStateTitle: '',
    wikipediaSummary: '', wikipediaThumbnailUrl: '',
  } }));
  await page.route('**/api/economic/v1/get-national-debt*', route => route.fulfill({ json: {
    entries: [{ iso3: 'USA', debtToGdp: 128.6, debtUsd: 43446021592.1e12, annualGrowth: 2.2, source: 'IMF WEO 2027' }], unavailable: false,
  } }));
  await page.route('**/api/trade/v1/get-tariff-trends*', route => route.fulfill({ json:
    new URL(route.request().url()).searchParams.get('reporting_country') !== '840' ? { datapoints: [] } : {
    effectiveTariffRate: { tariffRate: 8.83 }, datapoints: [{ year: 2024, tariffRate: 8.83 }, { year: 2025, tariffRate: 8.83 }],
  } }));
  await page.route('**/api/bootstrap?*', async route => {
    if (!new URL(route.request().url()).searchParams.get('keys')?.includes('bisDsr')) return route.fallback();
    await route.fulfill({ json: { data: {
      bisPropertyResidential: { entries: [{ countryCode: 'US', indexValue: 156.4, yoyChange: -2.1, qoqChange: null, period: '2026-Q1' }] },
      bisPropertyCommercial: { entries: [{ countryCode: 'US', indexValue: 186.6, yoyChange: 6.6, qoqChange: null, period: '2026-Q1' }] },
      bisDsr: { entries: [{ countryCode: 'US', dsrPct: 8, change: 1.3, period: '2026-Q1' }] },
    } } });
  });
  return { releaseFactors, countriesRequested };
}
