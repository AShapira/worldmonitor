import type {
  LocalInferenceCapabilities, LocalInferenceLogin, LocalInferenceState, LocalReportJob, LocalReportRequest,
} from '@/types/local-inference';

export const localInferenceEnabled = import.meta.env.VITE_LOCAL_INFERENCE === '1';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!localInferenceEnabled) throw new Error('AI controls are only available in the personal local deployment.');
  const response = await fetch(`/api/local-ai${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    throw new Error(detail || `AI service unavailable (${response.status}). No fallback was attempted.`);
  }
  return payload as T;
}

export const localInference = {
  state: () => request<LocalInferenceState>('/state'),
  save: (state: Pick<LocalInferenceState, 'mode' | 'presets'>) => request<LocalInferenceState>('/state', 'PUT', state),
  capabilities: () => request<LocalInferenceCapabilities>('/capabilities'),
  login: () => request<LocalInferenceLogin>('/auth/login', 'POST', {}),
  logout: () => request<void>('/auth/logout', 'POST', {}),
  jobs: async () => (await request<{ jobs: LocalReportJob[] }>('/jobs')).jobs,
  submit: (job: LocalReportRequest) => request<LocalReportJob>('/jobs', 'POST', job),
  job: (id: string) => request<LocalReportJob>(`/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<LocalReportJob>(`/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}),
};
