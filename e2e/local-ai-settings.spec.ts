import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';
test.use({ serviceWorkers: 'block' });

// Controlled gateway responses exercise the real settings path, never the GPU
// or subscription. Run with VITE_LOCAL_INFERENCE=1.
test.skip(process.env.VITE_LOCAL_INFERENCE !== '1', 'Personal deployment AI build flag required');

const initial = {
  mode: 'chatgpt',
  presets: {
    local: { model: 'qwen3.5:9b', effort: 'balanced', timeoutMs: 90000 },
    routine: { model: 'gpt-5.6-luna', effort: 'low', timeoutMs: 90000 },
    important: { model: 'gpt-6-astra', effort: 'high', timeoutMs: 300000 },
  },
  gpu: { reserved: true, unloaded: true },
};
const capabilities = {
  account: { type: 'chatgpt', planType: 'plus' }, localModels: [{ name: 'qwen3.5:9b' }],
  models: [
    { model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    { model: 'gpt-6-astra', displayName: 'GPT-6 Astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ], rateLimits: { primary: { usedPercent: 12 } },
};

async function boot(page: Page) {
  await seedAnonymousDashboard(page, 'full', { localStorage: { 'wm-community-dismissed-v2': '1' } });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/local-ai/')) return route.fallback();
    if (url.pathname === '/api/bootstrap') return route.fulfill({ json: { data: {}, missing: [] } });
    if (url.pathname.startsWith('/api/') || url.origin !== 'http://127.0.0.1:4173') return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#unifiedSettingsBtn')).toBeVisible({ timeout: 60000 });
  await page.locator('#unifiedSettingsBtn').click();
  await page.locator('#us-tab-ai').click();
  await expect(page.locator('#local-ai-mode')).toBeVisible();
}

test('settings persist, reports are explicit, and actual model and safe evidence are shown', async ({ page }) => {
  let state = structuredClone(initial);
  const submissions: any[] = [];
  let jobs: any[] = [];
  await page.route('**/api/local-ai/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/local-ai', '');
    if (path === '/state') {
      if (route.request().method() === 'PUT') state = { ...state, ...route.request().postDataJSON() };
      return route.fulfill({ json: state });
    }
    if (path === '/capabilities') return route.fulfill({ json: capabilities });
    if (path === '/jobs' && route.request().method() === 'POST') {
      const request = route.request().postDataJSON();
      submissions.push(request);
      const profile = { ...state.presets[request.preset as keyof typeof state.presets], ...request.overrides, provider: 'codex' };
      const job = { id: `report-${submissions.length}`, kind: request.kind, status: 'completed', createdAt: Date.now(), deadlineAt: Date.now() + profile.timeoutMs,
        profile, result: { brief: 'Supported finding [1](https://example.com/evidence). <script>window.__reportInjected=true</script>', sources: [{ title: 'Source one', url: 'https://example.com/evidence' }] } };
      jobs = [job];
      return route.fulfill({ json: job });
    }
    if (path === '/jobs') return route.fulfill({ json: { jobs } });
    return route.fulfill({ status: 404, json: { error: 'Unexpected test request' } });
  });
  await boot(page);
  expect(submissions).toHaveLength(0);
  await expect(page.locator('#local-ai-gpu')).toContainText('model unloaded');
  await page.locator('#local-ai-routine-effort').selectOption('high');
  await page.locator('#local-ai-save').click();
  await expect(page.locator('#local-ai-status')).toHaveText('AI settings saved.');
  expect(state.presets.routine.effort).toBe('high');
  await page.locator('.unified-settings-close').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#unifiedSettingsBtn').click();
  await page.locator('#us-tab-ai').click();
  await expect(page.locator('#local-ai-routine-effort')).toHaveValue('high');
  expect(submissions).toHaveLength(0);
  await page.locator('#local-ai-report-input').fill('il');
  await page.locator('#local-ai-report-preset').selectOption('important');
  await page.locator('#local-ai-generate').click();
  await expect(page.locator('.local-ai-job')).toHaveCount(1);
  expect(submissions).toEqual([{ kind: 'country', input: { countryCode: 'IL' }, preset: 'important', overrides: { model: 'gpt-6-astra', effort: 'high' } }]);
  await expect(page.locator('.local-ai-job')).toContainText('codex · gpt-6-astra · high');
  await page.locator('.local-ai-job summary').click();
  await expect(page.locator('.local-ai-job a').first()).toHaveAttribute('href', 'https://example.com/evidence');
  await expect(page.locator('.local-ai-job script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__reportInjected)).toBeUndefined();
});

test('unavailable models do not substitute and queued jobs can be cancelled', async ({ page }) => {
  const posted: string[] = [];
  const job = { id: 'queued-one', kind: 'weekly', status: 'queued', createdAt: Date.now(), deadlineAt: Date.now() + 90000,
    profile: { provider: 'codex', ...initial.presets.routine } };
  await page.route('**/api/local-ai/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/local-ai', '');
    if (route.request().method() === 'POST') posted.push(path);
    if (path === '/state') return route.fulfill({ json: initial });
    if (path === '/capabilities') return route.fulfill({ json: { ...capabilities, models: [capabilities.models[1]] } });
    if (path === '/jobs') return route.fulfill({ json: { jobs: [job] } });
    if (path === '/jobs/queued-one/cancel') { job.status = 'cancelled'; return route.fulfill({ json: job }); }
    return route.fulfill({ status: 404 });
  });
  await boot(page);
  await expect(page.locator('#local-ai-report-model')).toHaveValue('gpt-5.6-luna');
  await expect(page.locator('#local-ai-generate')).toBeDisabled();
  await expect(page.locator('#local-ai-model-warning')).toContainText('unavailable');
  await page.getByRole('button', { name: 'Cancel report' }).click();
  await expect(page.locator('.local-ai-job')).toHaveAttribute('data-status', 'cancelled');
  expect(posted).toEqual(['/jobs/queued-one/cancel']);
});
