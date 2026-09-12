/** Contracts for the personal deployment's authenticated inference gateway. */
export type LocalInferenceMode = 'local' | 'chatgpt';
export type LocalInferencePreset = 'local' | 'routine' | 'important';
export type LocalReportKind = 'country' | 'situation' | 'stock' | 'regional' | 'weekly' | 'daily';
export interface LocalInferenceProfile { model: string; effort: string; timeoutMs: number }
export interface LocalInferenceState {
  mode: LocalInferenceMode;
  presets: Record<LocalInferencePreset, LocalInferenceProfile>;
  gpu: { reserved: boolean; unloaded: boolean; error?: string };
}
export interface LocalInferenceCapabilities {
  account: { type: string; planType?: string } | null;
  models: Array<{ model: string; displayName?: string; supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }> }>;
  localModels: Array<{ name: string }>;
  rateLimits?: unknown;
  error?: string;
}
export interface LocalInferenceLogin { verificationUrl: string; userCode: string; loginId: string }
export interface LocalReportRequest {
  kind: LocalReportKind;
  input: Record<string, string>;
  preset: LocalInferencePreset;
  overrides?: { model: string; effort: string };
}
export interface LocalReportJob {
  id: string;
  kind: LocalReportKind;
  status: 'preparing' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: number;
  deadlineAt: number;
  profile: LocalInferenceProfile & { provider: 'ollama' | 'codex' };
  actual?: { provider: string; model: string; effort: string };
  completedAt?: number;
  result?: unknown;
  error?: string | { message?: string; code?: string };
}
