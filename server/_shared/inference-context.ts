// The Node sidecar owns AsyncLocalStorage. Edge bundles only inspect a getter
// that is absent in public deployments and cannot be supplied by HTTP callers.
export function inferenceDeadlineTimeout(defaultMs: number): number {
  const getter = (globalThis as Record<symbol, unknown>)[Symbol.for('worldmonitor.inference.context')];
  const context = typeof getter === 'function' ? getter() : undefined;
  const deadline = context?.deadlineAt;
  return Number.isFinite(deadline) ? Math.max(1, Math.min(305_000, deadline - Date.now() + 1_000)) : defaultMs;
}
