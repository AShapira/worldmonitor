export type LocalEnv = Record<string, string | undefined>;
export const LOCAL_REPORT_TIMEOUT_MS: number;
export const LOCAL_REPORT_MAX_TOKENS: number;
export function isLocalLlmProfile(env?: LocalEnv): boolean;
export function localLlmCacheTag(env?: LocalEnv): string;
export function localLlmOptions(report: boolean, env?: LocalEnv): {
  timeoutMs?: number; maxTokens?: number; providerOrder?: string[];
  enableReasoning?: boolean; retryOnLengthLimit?: boolean;
};
export interface LocalLlmOptions {
  env?: LocalEnv;
  messages?: Array<{role: string; content: string}>;
  systemPrompt?: string; userPrompt?: string; maxTokens?: number;
  temperature?: number; report?: boolean; background?: boolean;
  deadlineMs?: number; timeoutMs?: number; signal?: AbortSignal;
  responseFormat?: Record<string, unknown>;
  validate?: (text: string) => boolean | Promise<boolean>;
  fetch?: typeof globalThis.fetch;
}
export function callLocalLlm(opts: LocalLlmOptions): Promise<{
  text: string; model: string; provider: string; tokens: number; finishReason: string | null;
} | null>;
