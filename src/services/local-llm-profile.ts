/** Public build-time policy only; credentials stay in the API service. */
export interface LocalLlmBrowserEnv {
  VITE_LOCAL_LLM_PROFILE?: string;
  VITE_LOCAL_LLM_MODEL?: string;
}

function browserEnv(): LocalLlmBrowserEnv {
  return import.meta.env ?? {};
}

export function isLocalLlmBrowserProfile(env: LocalLlmBrowserEnv = browserEnv()): boolean {
  return env.VITE_LOCAL_LLM_PROFILE === 'balanced';
}

/** Separate browser-persisted prose when the selected deployment model changes. */
export function localLlmBrowserCacheTag(env: LocalLlmBrowserEnv = browserEnv()): string {
  return isLocalLlmBrowserProfile(env)
    ? `:local-balanced-v1:${encodeURIComponent(env.VITE_LOCAL_LLM_MODEL || 'qwen3.5:9b')}`
    : '';
}
