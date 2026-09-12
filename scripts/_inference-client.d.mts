import type { LocalEnv, LocalLlmOptions } from './_local-llm-profile.mjs';
export interface InferenceContext { id: string; deadlineAt: number; profile: { provider: string; model: string; effort: string; promptVersion: string; timeoutMs: number } }
export function inferenceContext(): InferenceContext | undefined;
export function isManagedInference(env?: LocalEnv): boolean;
export function inferenceTimeout(fallback: number): number;
export function inferenceCacheTag(env?: LocalEnv): string;
export function callManagedInference(opts: LocalLlmOptions): Promise<{text: string; model: string; provider: string; tokens: number; finishReason: string | null} | null>;
