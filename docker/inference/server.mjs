import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { RedisStore } from './store.mjs';
import { InferenceEngine, InferenceError } from './engine.mjs';
import { CodexClient } from './codex.mjs';
import { OllamaClient } from './ollama.mjs';

export function authenticated(header, token) {
  if (!token) return false;
  const received = Buffer.from(header || ''); const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1048576) throw new InferenceError('Request too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new InferenceError('Invalid JSON'); }
}
export function createInferenceServer(engine, token) {
  if (!token || token.length < 32) throw new Error('WM_INFERENCE_TOKEN must contain at least 32 characters');
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const answer = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://inference');
    if (url.pathname === '/health' && req.method === 'GET') return answer(200, { status: 'ok' });
    if (req.headers.origin || !authenticated(req.headers.authorization, token)) return answer(401, { error: 'Unauthorized' });
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      let result;
      if (url.pathname === '/state' && req.method === 'GET') result = await engine.getState();
      else if (url.pathname === '/state' && req.method === 'PUT') result = await engine.updateSettings(await readJson(req));
      else if (url.pathname === '/capabilities' && req.method === 'GET') result = await engine.capabilities();
      else if (url.pathname === '/auth/login' && req.method === 'POST') result = await engine.codex.login();
      else if (url.pathname === '/auth/logout' && req.method === 'POST') {
        for (const id of engine.active.keys()) await engine.cancel(id);
        result = await engine.codex.logout();
      }
      else if (url.pathname === '/jobs' && req.method === 'GET') result = await engine.jobs();
      else if (url.pathname === '/jobs' && req.method === 'POST') result = await engine.submit(await readJson(req));
      else if (/^\/jobs\/[a-f0-9-]{36}$/.test(url.pathname) && req.method === 'GET') result = await engine.getJob(url.pathname.split('/')[2]);
      else if (/^\/jobs\/[a-f0-9-]{36}\/cancel$/.test(url.pathname) && req.method === 'POST') result = await engine.cancel(url.pathname.split('/')[2]);
      else if (url.pathname === '/complete' && req.method === 'POST') result = await engine.complete(await readJson(req), abort.signal);
      else return answer(404, { error: 'Not found' });
      answer(200, result ?? { ok: true });
    } catch (error) {
      answer(error instanceof InferenceError ? error.status : 503, { error: error instanceof InferenceError ? error.message : 'Inference service unavailable; check sign-in, storage, and provider status.' });
    }
  });
}
export async function main(env = process.env) {
  const token = env.WM_INFERENCE_TOKEN;
  const store = new RedisStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  const codex = new CodexClient();
  const ollama = new OllamaClient(env.WM_INFERENCE_OLLAMA_URL || 'http://ollama:11434');
  const engine = new InferenceEngine({ store, codex, ollama, runReport: async (job, signal) => {
    const response = await fetch(env.WM_INFERENCE_RUN_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-inference/1.0' },
      body: JSON.stringify({ id: job.id, kind: job.kind, input: job.input, profile: job.profile, deadlineAt: job.deadlineAt }), signal, redirect: 'error',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const errors = {
        invalid_report_output: 'Report output failed structure or citation validation. Retry explicitly.',
        source_evidence_unavailable: 'Required source evidence is unavailable. Data collection continues.',
        report_deadline_exceeded: 'Report deadline exceeded. Retry explicitly.',
        unknown_region: 'The selected region is unavailable.',
      };
      throw new InferenceError(errors[payload.error] || 'Report could not be generated from available evidence.');
    }
    return response.json();
  } });
  await engine.initialize();
  const server = createInferenceServer(engine, token);
  server.listen(Number(env.PORT || 8080), '0.0.0.0');
  const shutdown = () => { engine.close(); server.close(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
