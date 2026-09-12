import { randomUUID } from 'node:crypto';

export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const DEFAULT_STATE = {
  mode: 'chatgpt', revision: 1,
  presets: {
    local: { model: 'qwen3.5:9b', effort: 'balanced', timeoutMs: 90000 },
    routine: { model: 'gpt-5.6-luna', effort: 'low', timeoutMs: 90000 },
    important: { model: 'gpt-6-astra', effort: 'high', timeoutMs: 300000 },
  },
  gpu: { reserved: true, unloaded: false },
  ownedLocalModels: ['qwen3.5:9b'],
};
export class InferenceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function validateSettings(value) {
  if (!value || !['local', 'chatgpt'].includes(value.mode)) throw new InferenceError('Choose Local or ChatGPT');
  const presets = {};
  for (const [key, budget] of [['local', 90000], ['routine', 90000], ['important', 300000]]) {
    const preset = value.presets?.[key];
    if (!preset || typeof preset.model !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,150}$/.test(preset.model)) throw new InferenceError(`Invalid ${key} model`);
    if (typeof preset.effort !== 'string' || !/^[a-z]{2,12}$/.test(preset.effort)) throw new InferenceError(`Invalid ${key} reasoning effort`);
    if (key === 'local' && !['balanced', 'off', 'on'].includes(preset.effort)) throw new InferenceError('Local effort must be balanced, off, or on');
    presets[key] = { model: preset.model, effort: preset.effort, timeoutMs: budget };
  }
  return { mode: value.mode, presets };
}
export function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 64 || messages.some(m => !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new InferenceError('Invalid report evidence');
  if (JSON.stringify(messages).length > 500000) throw new InferenceError('Report evidence is too large');
  return messages.map(({ role, content }) => ({ role, content }));
}

export class InferenceEngine {
  constructor({ store, codex, ollama, runReport, now = Date.now }) {
    this.store = store; this.codex = codex; this.ollama = ollama; this.runReport = runReport; this.now = now;
    this.active = new Map(); this.tail = Promise.resolve(); this.localRequests = new Set();
    this.changing = false;
  }
  async initialize() {
    this.state = await this.store.get('state') || structuredClone(DEFAULT_STATE);
    this.state.ownedLocalModels = [...new Set([...(this.state.ownedLocalModels || []), this.state.presets.local.model])];
    for (const job of await this.store.jobs()) {
      if (!TERMINAL.has(job.status)) { job.status = 'interrupted'; job.error = 'Service restarted. Retry explicitly.'; await this.save(job); }
    }
    await this.store.put('state', this.state);
    if (this.state.mode === 'chatgpt') await this.reserveGpu();
  }
  async reserveGpu() {
    this.state.gpu = { reserved: true, unloaded: false };
    await this.store.put('state', this.state);
    try {
      for (const model of this.state.ownedLocalModels) await this.ollama.unload(model);
      this.state.gpu = { reserved: true, unloaded: true };
    } catch { this.state.gpu.error = 'Local inference blocked; GPU unload could not be verified. Retry reserving the GPU.'; }
    await this.store.put('state', this.state);
  }
  async checkStorage() {
    const stored = await this.store.get('state');
    if (!stored || stored.revision !== this.state.revision) throw new InferenceError('Inference policy unavailable or changed; restart the service', 503);
  }
  async getState() { await this.checkStorage(); return structuredClone(this.state); }
  async capabilities() {
    const localModels = await this.ollama.models().catch(() => []);
    try { return { ...await this.codex.capabilities(), localModels }; }
    catch { return { account: null, models: [], rateLimits: null, localModels, error: 'Codex unavailable. Check the inference service and sign in.' }; }
  }
  async selectProfile(preset, overrides = {}) {
    if (!['local', 'routine', 'important'].includes(preset)) throw new InferenceError('Invalid report preset');
    const local = preset === 'local';
    if (local !== (this.state.mode === 'local')) throw new InferenceError('Report preset does not match the selected operating mode', 409);
    const saved = this.state.presets[preset];
    const profile = { ...saved, model: overrides.model || saved.model, effort: overrides.effort || saved.effort, provider: local ? 'ollama' : 'codex', preset, promptVersion: 'worldmonitor-reports-v1' };
    if (local) {
      if (!['balanced', 'off', 'on'].includes(profile.effort)) throw new InferenceError('Unsupported local reasoning effort');
      const models = await this.ollama.models();
      if (!models.some(m => m.name === profile.model)) throw new InferenceError('Local model is not installed');
    } else {
      const caps = await this.codex.capabilities();
      if (!caps.account) throw new InferenceError('Sign in with ChatGPT before generating reports', 401);
      const model = caps.models.find(m => m.model === profile.model);
      if (!model) throw new InferenceError('Selected model is unavailable. Choose another model.');
      if (!model.supportedReasoningEfforts?.some(e => e.reasoningEffort === profile.effort)) throw new InferenceError('Selected reasoning effort is unavailable for this model');
    }
    return profile;
  }
  async updateSettings(value) {
    if (this.changing) throw new InferenceError('An operating-mode change is already in progress', 409);
    this.changing = true;
    try {
      const selected = validateSettings(value);
      // Reservation is persisted BEFORE unloading, including when sign-in or Ollama is unavailable.
      if (selected.mode !== this.state.mode) {
        for (const [id] of this.active) await this.cancel(id);
        for (const controller of this.localRequests) controller.abort();
      }
      const previousLocal = this.state.presets.local.model;
      this.state = { ...selected, revision: this.state.revision + 1, gpu: { reserved: selected.mode === 'chatgpt', unloaded: false }, ownedLocalModels: [...new Set([...this.state.ownedLocalModels, previousLocal, selected.presets.local.model])] };
      await this.store.put('state', this.state);
      if (selected.mode === 'chatgpt') {
        await this.reserveGpu();
      }
      return this.getState();
    } finally { this.changing = false; }
  }
  publicJob(job) {
    // Evidence stays in Redis for reproducibility; never expose prompts or internal execution context in job listings.
    const { evidence, input, providerError, ...visible } = job;
    return visible;
  }
  async save(job) { await this.store.put('job:' + job.id, job, 86400); }
  async jobs() { return { jobs: (await this.store.jobs()).slice(0, 100).map(job => this.publicJob(job)) }; }
  async getJob(id) {
    const job = await this.store.get('job:' + id);
    if (!job) throw new InferenceError('Report not found or expired', 404);
    return this.publicJob(job);
  }
  async submit({ kind, input, preset, overrides }) {
    if (!['country', 'situation', 'stock', 'regional', 'weekly', 'daily'].includes(kind) || !input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 12000) throw new InferenceError('Invalid report request');
    await this.checkStorage();
    const profile = await this.selectProfile(preset, overrides);
    // No await between admission check and reservation: concurrent submissions cannot overbook.
    if (this.changing || this.active.size >= 3) throw new InferenceError('Report queue is full. Wait or cancel an existing report.', 429);
    if ((profile.provider === 'ollama') !== (this.state.mode === 'local')) throw new InferenceError('Operating mode changed; submit again', 409);
    const job = { id: randomUUID(), kind, input: structuredClone(input), profile, createdAt: this.now(), deadlineAt: this.now() + profile.timeoutMs, status: 'preparing', evidence: [], completionCount: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, profile.timeoutMs);
    this.active.set(job.id, { job, controller, timer });
    try { await this.save(job); }
    catch (error) { clearTimeout(timer); this.active.delete(job.id); throw error; }
    void this.execute(job, controller).catch(() => {});
    return this.publicJob(job);
  }
  async execute(job, controller) {
    try {
      const result = await this.runReport(job, controller.signal);
      if (controller.signal.aborted) throw new InferenceError('Report cancelled or timed out');
      if (!job.completionCount) throw new InferenceError('No valid AI report was produced. Required evidence may be unavailable.');
      job.result = result; job.status = 'completed'; job.completedAt = this.now();
    } catch (error) {
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.error = controller.signal.aborted ? 'Report deadline exceeded. Retry explicitly.' : (job.providerError || (error instanceof InferenceError ? error.message : 'Report failed; check evidence coverage, sign-in, and provider availability.'));
      }
    } finally {
      await this.save(job).catch(() => {});
      clearTimeout(this.active.get(job.id)?.timer); this.active.delete(job.id);
    }
  }
  async cancel(id) {
    const active = this.active.get(id);
    if (!active) return this.getJob(id);
    active.job.status = 'cancelled'; active.job.error = 'Cancelled by user'; active.controller.abort();
    await this.save(active.job); return this.publicJob(active.job);
  }
  async complete(body, requestSignal) {
    const messages = validateMessages(body.messages);
    // A store read is intentional: do not perform inference during a policy-storage outage.
    await this.checkStorage();
    if (this.changing) throw new InferenceError('Operating mode is changing', 409);
    const active = body.jobId ? this.active.get(body.jobId) : null;
    if (body.jobId && (!active || TERMINAL.has(active.job.status))) throw new InferenceError('Report job is no longer active', 409);
    if (!active && this.state.mode !== 'local') throw new InferenceError('Automatic AI is paused while the GPU is reserved', 409);
    const profile = active?.job.profile || { ...this.state.presets.local, provider: 'ollama' };
    if ((profile.provider === 'ollama') !== (this.state.mode === 'local')) throw new InferenceError('Provider is disabled in the current mode', 409);
    const controller = new AbortController();
    const deadlineAt = active?.job.deadlineAt || this.now() + (body.report ? 90000 : 25000);
    const signal = AbortSignal.any([controller.signal, ...(active ? [active.controller.signal] : []), ...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(Math.max(1, deadlineAt - this.now()))]);
    if (profile.provider === 'ollama') this.localRequests.add(controller);
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    try {
    // Save the prepared source/prompt snapshot immediately, before waiting for the inference slot.
    if (active) {
      active.job.evidence.push({ capturedAt: this.now(), messages, profile, responseFormat: body.responseFormat });
      active.job.status = 'queued'; await this.save(active.job);
    }
      await new Promise((resolve, reject) => {
        const abort = () => reject(new InferenceError('Report cancelled or timed out'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      if (signal.aborted || (profile.provider === 'ollama') !== (this.state.mode === 'local')) throw new InferenceError('Report cancelled or provider disabled', 409);
      await this.checkStorage();
      if (this.changing || signal.aborted) throw new InferenceError('Report cancelled or policy changing', 409);
      if (active) { active.job.status = 'running'; await this.save(active.job); }
      if (profile.provider === 'ollama' && !this.state.ownedLocalModels.includes(profile.model)) {
        this.state.ownedLocalModels.push(profile.model);
        await this.store.put('state', this.state);
      }
      const result = profile.provider === 'codex'
        ? await this.codex.complete({ messages, profile, signal, deadlineAt })
        : await this.ollama.complete({ ...body, messages, profile, signal, deadlineAt });
      if (signal.aborted || !result?.text) throw new InferenceError('No valid report was returned');
      if (active) { active.job.actual = { provider: result.provider || profile.provider, model: result.model || profile.model, effort: result.effort || profile.effort }; active.job.completionCount++; await this.save(active.job); }
      return result;
    } catch (error) {
      if (active && error?.inferenceSafe) { active.job.providerError = error.message; await this.save(active.job); }
      throw error;
    } finally {
      // A cancelled waiter must not let a later request overtake the request still running ahead of it.
      previous.finally(release); this.localRequests.delete(controller);
    }
  }
  close() { for (const entry of this.active.values()) { clearTimeout(entry.timer); entry.controller.abort(); } for (const c of this.localRequests) c.abort(); this.codex.close(); }
}
