/** Shared transport for managed personal deployments. This module also bundles into Edge handlers; no Node imports. */
const envNow = () => typeof process === 'undefined' ? {} : process.env;
export const inferenceContext = () => globalThis[Symbol.for('worldmonitor.inference.context')]?.();
export const isManagedInference = (env = envNow()) => env.WM_INFERENCE_ENABLED === '1' || Boolean(env.WM_INFERENCE_URL);
export function inferenceTimeout(fallback) {
  const context = inferenceContext();
  return context ? Math.max(1, context.deadlineAt - Date.now()) : fallback;
}
export function inferenceCacheTag(env = envNow()) {
  if (!isManagedInference(env)) return '';
  const context = inferenceContext();
  return context ? `:managed-v1:${context.profile.provider}:${context.profile.model}:${context.profile.effort}:${context.profile.promptVersion}:${context.id}` : '';
}
export async function callManagedInference(opts) {
  const env = opts.env || envNow();
  if (!env.WM_INFERENCE_URL || !env.WM_INFERENCE_TOKEN) return null;
  const context = inferenceContext();
  const timeout = inferenceTimeout(opts.timeoutMs ?? (opts.report === false ? 25000 : 90000));
  const signals = [AbortSignal.timeout(Math.max(1, timeout)), ...(opts.signal ? [opts.signal] : [])];
  try {
    const response = await (opts.fetch || globalThis.fetch)(new URL('/complete', env.WM_INFERENCE_URL), {
      method: 'POST', headers: { Authorization: `Bearer ${env.WM_INFERENCE_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-inference/1.0' },
      body: JSON.stringify({ jobId: context?.id, messages: opts.messages || [
        { role: 'system', content: opts.systemPrompt || '' }, { role: 'user', content: opts.userPrompt || '' },
      ], report: opts.report !== false, maxTokens: opts.maxTokens, responseFormat: opts.responseFormat }),
      signal: AbortSignal.any(signals), redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const result = await response.json();
    if (!result.text || result.finishReason !== 'stop' || (opts.validate && !(await opts.validate(result.text)))) return null;
    return result;
  } catch { return null; }
}
