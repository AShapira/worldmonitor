import { isManagedInference, inferenceTimeout, inferenceCacheTag, callManagedInference } from './_inference-client.mjs';
// Shared, opt-in policy for the local Podman deployment and host seeders.
// No credential loading here: callers retain their existing loadEnvFile path.
export const LOCAL_REPORT_TIMEOUT_MS = 90_000;
export const LOCAL_REPORT_MAX_TOKENS = 6144;
const runtimeEnv = () => typeof process === 'undefined' ? {} : process.env;
export const isLocalLlmProfile = (env = runtimeEnv()) => env.WM_LOCAL_LLM_PROFILE === 'balanced' || isManagedInference(env);
export function localLlmCacheTag(env = runtimeEnv()) {
  const managedTag = inferenceCacheTag(env);
  if (managedTag) return managedTag;
  if (!isLocalLlmProfile(env)) return '';
  const identity = [env.OLLAMA_MODEL, env.LLM_MODEL, env.WM_LOCAL_LLM_MODEL_DIGEST, env.OLLAMA_CONTEXT_LENGTH || '16384'].join('|');
  let hash = 2166136261;
  for (const char of identity) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `:local-balanced-v1-${hash.toString(16)}`;
}
export function localLlmOptions(report, env = runtimeEnv()) {
  return isLocalLlmProfile(env) ? {
    timeoutMs: inferenceTimeout(report ? LOCAL_REPORT_TIMEOUT_MS : 25_000),
    ...(report ? { maxTokens: LOCAL_REPORT_MAX_TOKENS } : {}),
    providerOrder: ['ollama'], enableReasoning: Boolean(report), retryOnLengthLimit: true,
  } : {};
}

function localEndpoint(env) {
  const raw = env.OLLAMA_API_URL || env.LLM_API_URL;
  if (!raw) return null;
  try {
    const url = env.OLLAMA_API_URL ? new URL('/v1/chat/completions', raw) : new URL(raw);
    const host = url.hostname;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!['localhost', '127.0.0.1', '[::1]', 'ollama', 'host.containers.internal', 'host.docker.internal'].includes(host)) return null;
    return url.toString();
  } catch { return null; }
}

function finalText(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
    .replace(/<(?:think|reasoning|reflection)>[\s\S]*$/gi, '')
    .replace(/<\|(?:thinking|begin_of_thought)\|>[\s\S]*$/gi, '')
    .replace(/^```(?:\w+)?\s*/, '').replace(/\s*```$/, '').trim();
}

let backgroundTail = Promise.resolve();

/** Local-only completions; the shared deadline covers queueing and body reads.
 * @param {any} opts
 * @returns {Promise<{text: string, model: string, provider: string, tokens: number, finishReason: string|null}|null>}
 */
export async function callLocalLlm(opts) {
  const env = opts.env || runtimeEnv();
  if (isManagedInference(env)) return callManagedInference(opts);
  if (!isLocalLlmProfile(env)) return null;
  const apiUrl = localEndpoint(env);
  if (!apiUrl || opts.signal?.aborted) return null;
  const model = env.OLLAMA_MODEL || env.LLM_MODEL || 'qwen3.5:9b';
  const report = opts.report !== false;
  const deadline = Math.min(opts.deadlineMs ?? Infinity,
    Date.now() + Math.min(opts.timeoutMs ?? (report ? 90_000 : 25_000), report ? 90_000 : 25_000));
  let release = () => {};
  if (opts.background !== false) {
    const previous = backgroundTail;
    const gate = new Promise(resolve => { release = resolve; });
    backgroundTail = previous.then(() => gate);
    let timer;
    let cancelWait = () => {};
    const cancelled = new Promise(resolve => { cancelWait = () => resolve(false); });
    opts.signal?.addEventListener('abort', cancelWait, { once: true });
    const admitted = await Promise.race([
      previous.then(() => true), cancelled,
      new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancelWait);
    if (!admitted || opts.signal?.aborted) { release(); return null; }
  }
  try {
    const messages = opts.messages || [
      { role: 'system', content: opts.systemPrompt || '' },
      { role: 'user', content: opts.userPrompt || '' },
    ];
    for (const thinking of report ? [true, false] : [false]) {
      const timeout = Math.min(thinking ? 60_000 : 25_000, deadline - Date.now());
      if (timeout <= 0) break;
      const controller = new AbortController();
      let timer;
      let cancelRequest = () => {};
      const cancelled = new Promise(resolve => { cancelRequest = () => resolve(null); });
      const abort = () => { controller.abort(); cancelRequest(); };
      if (opts.signal?.aborted) return null;
      opts.signal?.addEventListener('abort', abort, { once: true });
      try {
        const maxTokens = thinking ? 6144 : Math.min(opts.maxTokens || 1500, 6144);
        const request = async () => {
          const response = await (opts.fetch || globalThis.fetch)(apiUrl, {
            method: 'POST', signal: controller.signal, redirect: 'error',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-local/1.0',
              ...(env.OLLAMA_API_KEY || env.LLM_API_KEY ? { Authorization: `Bearer ${env.OLLAMA_API_KEY || env.LLM_API_KEY}` } : {}) },
            body: JSON.stringify({ model, messages, temperature: opts.temperature ?? (thinking ? 1 : 0.7),
              top_p: thinking ? 0.95 : 0.8, presence_penalty: 1.5,
              max_tokens: maxTokens, stream: false,
              think: thinking, reasoning_effort: thinking ? 'medium' : 'none',
              ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
            }),
          });
          if (!response.ok) { await response.body?.cancel(); return null; }
          const data = await response.json();
          const choice = data.choices?.[0];
          if (controller.signal.aborted || (choice?.finish_reason && choice.finish_reason !== 'stop')
            || choice?.message?.refusal || choice?.message?.tool_calls?.length) return null;
          const text = finalText(choice?.message?.content);
          if (!text || (opts.validate && !(await opts.validate(text))) || controller.signal.aborted) return null;
          return { text, model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : model, provider: 'ollama', tokens: data.usage?.total_tokens || 0, finishReason: choice?.finish_reason || null };
        };
        const result = await Promise.race([request(), cancelled, new Promise(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
        })]);
        if (result) return result;
      } catch { /* One bounded direct-answer retry may recover a failed report. */ }
      finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); }
      if (opts.signal?.aborted) return null;
    }
    return null;
  } finally { release(); }
}
