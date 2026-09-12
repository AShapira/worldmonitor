import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const storage = new AsyncLocalStorage();
// Bundled handlers and ESM workers share the request scope without importing
// node:async_hooks into the Edge build.
globalThis[Symbol.for('worldmonitor.inference.context')] = () => storage.getStore();

const PREFIX = '/api/local-ai';
const METHODS = new Map([
  ['/state', ['GET', 'PUT']], ['/capabilities', ['GET']],
  ['/auth/login', ['POST']], ['/auth/logout', ['POST']], ['/jobs', ['GET', 'POST']],
]);
export const REPORT_ROUTES = Object.freeze({
  country: { path: '/api/intelligence/v1/get-country-intel-brief', params: { countryCode: 'country_code' } },
  situation: { path: '/api/intelligence/v1/deduct-situation', params: { query: 'query', geoContext: 'geo_context', framework: 'framework' } },
  stock: { path: '/api/market/v1/analyze-stock', params: { symbol: 'symbol', name: 'name', includeNews: 'include_news' } },
});

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export function hasInferenceAuth(headers, env = process.env) {
  const token = env.WM_INFERENCE_TOKEN;
  const value = typeof headers.authorization === 'string' ? headers.authorization : '';
  if (!token || !env.WM_INFERENCE_URL) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = Buffer.from(value);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function inferenceRequestTimeout(defaultMs) {
  const deadline = storage.getStore()?.deadlineAt;
  return Number.isFinite(deadline) ? Math.max(1, Math.min(300_000, deadline - Date.now())) : defaultMs;
}

export function buildReportRequest(kind, input, port) {
  const route = REPORT_ROUTES[kind];
  if (!route) throw new Error('Unsupported report kind');
  const url = new URL(route.path, `http://127.0.0.1:${port}`);
  for (const [key, param] of Object.entries(route.params)) {
    if (['string', 'boolean'].includes(typeof input[key])) url.searchParams.set(param, String(input[key]));
  }
  if (kind === 'stock' && input.includeNews === undefined) url.searchParams.set('include_news', 'true');
  url.searchParams.set('lang', 'en');
  if (kind === 'situation') {
    return new Request(url, { method: 'POST', headers: { 'User-Agent': 'WorldMonitor/LocalAI', Origin: url.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: input.query, geoContext: input.geoContext || '', framework: input.framework || '' }) });
  }
  return new Request(url, { headers: { 'User-Agent': 'WorldMonitor/LocalAI', Origin: url.origin } });
}

export function validateRun(body) {
  if (!body || typeof body !== 'object' || !/^[\w-]{1,80}$/.test(body.id || '')
      || !['country', 'situation', 'stock', 'regional', 'weekly', 'daily'].includes(body.kind)
      || !body.input || typeof body.input !== 'object' || Array.isArray(body.input)
      || !body.profile || typeof body.profile !== 'object'
      || !Number.isFinite(body.deadlineAt) || body.deadlineAt <= Date.now()
      || body.deadlineAt > Date.now() + 305_000) return false;
  if (body.kind === 'country') return /^[A-Z]{2}$/.test(body.input.countryCode || '');
  if (body.kind === 'stock') return typeof body.input.symbol === 'string' && /^[A-Za-z0-9.^=\-]{1,20}$/.test(body.input.symbol);
  if (body.kind === 'situation') return typeof body.input.query === 'string' && body.input.query.trim().length > 0 && body.input.query.length <= 500;
  if (['regional', 'weekly'].includes(body.kind)) return /^[a-z][a-z0-9-]{1,50}$/.test(body.input.regionId || '');
  return true;
}

/** No raw RPC, arbitrary path, caller credentials, or tool options cross this proxy. */
export async function proxyLocalAi(requestUrl, req, { readBody, fetch = globalThis.fetch, env = process.env }) {
  if (!env.WM_INFERENCE_URL || !env.WM_INFERENCE_TOKEN) return json({ error: 'inference_not_configured' }, 503);
  // Literal loopback hosts prevent public exposure and DNS-rebinding writes.
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) return json({ error: 'local_only' }, 403);
  const suffix = requestUrl.pathname.slice(PREFIX.length);
  const methods = METHODS.get(suffix) || (/^\/jobs\/[\w-]{1,80}$/.test(suffix) ? ['GET']
    : /^\/jobs\/[\w-]{1,80}\/cancel$/.test(suffix) ? ['POST'] : null);
  if (!methods) return json({ error: 'not_found' }, 404);
  if (!methods.includes(req.method)) return json({ error: 'method_not_allowed' }, 405);
  // nginx authenticates the operator and supplies the hop token. Same-origin
  // JSON mutations prevent a different website from spending that operator's allowance.
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      let sameHost = false;
      try { sameHost = new URL(origin).host === req.headers.host; } catch { /* deny malformed origin */ }
      if (!sameHost) return json({ error: 'cross_origin_denied' }, 403);
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json({ error: 'json_required' }, 415);
  }
  const body = req.method === 'GET' ? undefined : await readBody(req);
  if (body?.length > 64 * 1024) return json({ error: 'request_too_large' }, 413);
  try {
    const response = await fetch(new URL(suffix, env.WM_INFERENCE_URL).toString(), {
      method: req.method,
      headers: { Authorization: `Bearer ${env.WM_INFERENCE_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor/LocalAI' },
      body, signal: AbortSignal.timeout(suffix === '/state' ? 45_000 : 20_000),
    });
    return new Response(await response.text(), { status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { return json({ error: 'inference_unavailable' }, 503); }
}

export async function runLocalAiReport(body, { invoke, resourceRoot, runWorker = runWorkerReport }) {
  if (!validateRun(body)) return json({ error: 'invalid_report_request' }, 400);
  const context = Object.freeze({ id: body.id, profile: Object.freeze({ ...body.profile }), deadlineAt: body.deadlineAt });
  return storage.run(context, async () => {
    try {
      const result = REPORT_ROUTES[body.kind] ? await invoke(body.kind, body.input)
        : await runWorker(body.kind, body.input, resourceRoot);
      if (Date.now() >= body.deadlineAt) return json({ error: 'report_deadline_exceeded' }, 504);
      if (result instanceof Response) {
        if (!result.ok) return result;
        const value = await result.json();
        // Native handlers intentionally return empty/degraded 200s on a failed
        // model. A requested job must surface that failure, never call it done.
        const valid = body.kind === 'country' ? Boolean(value.brief?.trim() && value.model && value.sources?.length)
          : body.kind === 'situation' ? Boolean(value.analysis?.trim() && value.model && !['error', 'skipped'].includes(value.provider))
          : Boolean(value.model && value.fallback !== true);
        return valid ? json(value) : json({ error: 'invalid_report_output' }, 502);
      }
      return json(result);
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'report_generation_failed';
      return json({ error: code }, 502);
    }
  });
}

async function runWorkerReport(kind, input, root) {
  const { generateWorkerReport } = await import(pathToFileURL(path.join(root, 'local-ai/worker-reports.mjs')).href);
  return generateWorkerReport(kind, input);
}
