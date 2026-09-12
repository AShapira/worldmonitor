import { localInference } from '@/services/local-inference';
import type {
  LocalInferenceCapabilities, LocalInferenceLogin, LocalInferencePreset, LocalInferenceProfile,
  LocalInferenceState, LocalReportJob, LocalReportKind,
} from '@/types/local-inference';
import { h } from '@/utils/dom-utils';

const PRESETS: LocalInferencePreset[] = ['local', 'routine', 'important'];
const LABELS = { local: 'Local', routine: 'Routine hosted', important: 'Important hosted' };
const KINDS: Record<LocalReportKind, string> = {
  country: 'Country brief', situation: 'Situation analysis', stock: 'Stock analysis',
  regional: 'Regional intelligence', weekly: 'Weekly intelligence', daily: 'Daily finance',
};
const REGIONS: Array<[string, string]> = [
  ['mena', 'Middle East & North Africa'], ['east-asia', 'East Asia & Pacific'],
  ['europe', 'Europe & Central Asia'], ['north-america', 'North America'],
  ['south-asia', 'South Asia'], ['latam', 'Latin America & Caribbean'],
  ['sub-saharan-africa', 'Sub-Saharan Africa'],
];
const ACTIVE = new Set(['preparing', 'queued', 'running']);

function option(value: string, label: string): HTMLOptionElement {
  return new Option(label, value);
}
function select(id: string, choices: Array<[string, string]>, value: string): HTMLSelectElement {
  const el = document.createElement('select');
  el.id = id;
  for (const [key, label] of choices) el.add(option(key, label));
  if (!choices.some(([key]) => key === value)) el.add(option(value, `${value} (unavailable — select another)`));
  el.value = value;
  return el;
}
function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { className: 'local-ai-field', for: input.id }, h('span', label), input);
}
function button(label: string, action: () => void, id?: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (id) el.id = id;
  el.addEventListener('click', action);
  return el;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function safeLink(url: string, label: string): HTMLElement | Text {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return h('a', { href: parsed.href, target: '_blank', rel: 'noopener noreferrer' }, label);
    }
  } catch { /* Unsafe and non-URL evidence stays inert text. */ }
  return document.createTextNode(label);
}
/** Report evidence is data, never executable HTML. Keep readable prose and source links. */
function renderResult(value: unknown, depth = 0): HTMLElement {
  if (depth > 8) return h('span', '…');
  if (typeof value === 'string') {
    const el = h('div', { className: 'local-ai-prose' });
    const links = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
    let cursor = 0;
    for (const match of value.matchAll(links)) {
      el.append(document.createTextNode(value.slice(cursor, match.index)));
      el.append(safeLink(match[2] || match[3] || '', match[1] || match[3] || 'Source'));
      cursor = (match.index ?? 0) + match[0].length;
    }
    el.append(document.createTextNode(value.slice(cursor)));
    return el;
  }
  if (Array.isArray(value)) return h('ul', ...value.map(item => h('li', renderResult(item, depth + 1))));
  if (value && typeof value === 'object') {
    return h('dl', ...Object.entries(value).flatMap(([key, item]) => [
      h('dt', key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')),
      h('dd', renderResult(item, depth + 1)),
    ]));
  }
  return h('span', String(value ?? ''));
}

/** Reads on mount/poll; inference is created only by the Generate report button. */
export class LocalAiSettings {
  private state?: LocalInferenceState;
  private capabilities?: LocalInferenceCapabilities;
  private login?: LocalInferenceLogin;
  private jobs: LocalReportJob[] = [];
  private destroyed = false;
  private poll?: ReturnType<typeof setTimeout>;
  private busy = false;
  private status = h('p', { role: 'status', 'aria-live': 'polite' });
  private jobList = h('div');
  private preset: LocalInferencePreset = 'routine';
  private kind: LocalReportKind = 'country';
  private inputValue = '';
  private overrides?: { model: string; effort: string };

  constructor(private readonly root: HTMLElement) {
    root.classList.add('local-ai-settings');
    root.replaceChildren(h('p', 'Loading AI settings…'));
    void this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.poll);
  }

  private async refresh(): Promise<void> {
    clearTimeout(this.poll);
    try {
      const [state, capabilities, jobs] = await Promise.all([
        localInference.state(), localInference.capabilities(), localInference.jobs(),
      ]);
      if (this.destroyed) return;
      this.state = state;
      this.capabilities = capabilities;
      this.jobs = jobs;
      if (state.mode === 'local' && this.preset !== 'local') { this.preset = 'local'; this.overrides = undefined; }
      else if (state.mode === 'chatgpt' && this.preset === 'local') { this.preset = 'routine'; this.overrides = undefined; }
      this.render();
      this.schedulePoll();
    } catch (error) {
      if (!this.destroyed) this.root.replaceChildren(
        h('p', { role: 'alert' }, errorText(error)),
        button('Retry AI connection', () => { void this.refresh(); }),
      );
    }
  }

  private schedulePoll(): void {
    clearTimeout(this.poll);
    if (this.destroyed || !this.jobs.some(job => ACTIVE.has(job.status))) return;
    this.poll = setTimeout(async () => {
      try {
        const jobs = await localInference.jobs();
        if (this.destroyed) return;
        this.jobs = jobs;
        this.renderJobs();
        this.schedulePoll();
      } catch (error) {
        if (!this.destroyed) this.status.textContent = `${errorText(error)} Use Refresh account and reports to reconnect.`;
      }
    }, 2_000);
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.destroyed) return;
    this.busy = true;
    this.root.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Working…';
    try { await action(); }
    catch (error) { if (!this.destroyed) this.status.textContent = errorText(error); }
    finally { this.busy = false; this.root.removeAttribute('aria-busy'); }
  }

  private models(preset: LocalInferencePreset): Array<[string, string]> {
    if (preset === 'local') return (this.capabilities?.localModels ?? []).map(model => [model.name, model.name]);
    return (this.capabilities?.models ?? []).map(model => [model.model, model.displayName || model.model]);
  }

  private efforts(preset: LocalInferencePreset, model: string): Array<[string, string]> {
    if (preset === 'local') return [['balanced', 'Balanced'], ['off', 'Off'], ['on', 'On']];
    return (this.capabilities?.models.find(item => item.model === model)?.supportedReasoningEfforts ?? [])
      .map(item => [item.reasoningEffort, item.reasoningEffort]);
  }

  private profileFields(preset: LocalInferencePreset, profile: LocalInferenceProfile, prefix: string, changed?: () => void): HTMLElement {
    const model = select(`${prefix}-model`, this.models(preset), profile.model);
    const effort = select(`${prefix}-effort`, this.efforts(preset, profile.model), profile.effort);
    model.addEventListener('change', () => {
      profile.model = model.value;
      // Retain unsupported saved effort visibly until the user explicitly chooses.
      effort.replaceChildren(...this.efforts(preset, model.value).map(([key, label]) => option(key, label)));
      if (!this.efforts(preset, model.value).some(([key]) => key === profile.effort)) {
        effort.add(option(profile.effort, `${profile.effort} (unavailable — select another)`));
      }
      effort.value = profile.effort;
      changed?.();
    });
    effort.addEventListener('change', () => { profile.effort = effort.value; changed?.(); });
    return h('div', { className: 'local-ai-fields' }, field('Model', model), field('Reasoning', effort));
  }

  private render(): void {
    const state = this.state!;
    const capabilities = this.capabilities!;
    this.status = h('p', { role: 'status', 'aria-live': 'polite', id: 'local-ai-status' });
    this.jobList = h('div', { id: 'local-ai-jobs' });
    const draft = structuredClone(state);
    const mode = select('local-ai-mode', [['local', 'Local — Ollama'], ['chatgpt', 'ChatGPT — GPU reserved']], draft.mode);
    mode.addEventListener('change', () => { draft.mode = mode.value as LocalInferenceState['mode']; });
    const settings = h('section', h('h3', 'Inference settings'), field('Operating mode', mode),
      h('p', 'GPU reserved pauses automatic AI generation. Data collection continues. Hosted reports run only when you request them.'),
      h('p', { id: 'local-ai-gpu' }, state.gpu.reserved
        ? `GPU reserved · ${state.gpu.unloaded ? 'WorldMonitor model unloaded' : 'Unloading not verified'}`
        : 'Local inference enabled'),
      state.gpu.error ? h('p', { role: 'alert' }, state.gpu.error) : null,
      ...PRESETS.map(preset => h('fieldset', h('legend', LABELS[preset]),
        this.profileFields(preset, draft.presets[preset], `local-ai-${preset}`),
        h('p', `Time limit including queue: ${draft.presets[preset].timeoutMs / 1000} seconds`))),
      button('Save AI settings', () => { void this.run(async () => {
        this.overrides = undefined;
        this.state = await localInference.save({ mode: draft.mode, presets: draft.presets });
        await this.refresh();
        this.status.textContent = 'AI settings saved.';
      }); }, 'local-ai-save'));
    const auth = h('section', h('h3', 'ChatGPT subscription'),
      h('p', { id: 'local-ai-account' }, capabilities.account
        ? `Signed in · ${capabilities.account.planType || capabilities.account.type}` : 'Not signed in'),
      h('p', 'Hosted analysis uses your Codex subscription allowance. No API credits or automatic usage resets are used.'),
      capabilities.error ? h('p', { role: 'alert' }, capabilities.error) : null,
      h('div', { className: 'local-ai-actions' },
        button(capabilities.account ? 'Sign out' : 'Sign in with ChatGPT', () => { void this.run(async () => {
          if (capabilities.account) { await localInference.logout(); this.login = undefined; await this.refresh(); }
          else { this.login = await localInference.login(); this.render(); }
        }); }, 'local-ai-auth'),
        button('Refresh account and reports', () => { void this.run(async () => { await this.refresh(); }); }, 'local-ai-refresh')));
    if (this.login && !capabilities.account) auth.append(
      h('p', 'Open the sign-in page and enter this code:'),
      h('strong', { id: 'local-ai-login-code' }, this.login.userCode),
      h('p', safeLink(this.login.verificationUrl, 'Open ChatGPT sign-in')),
      h('p', 'After signing in, select Refresh account and reports.'),
    );
    if (capabilities.rateLimits != null) auth.append(h('details', h('summary', 'Subscription usage'), renderResult(capabilities.rateLimits)));
    this.root.replaceChildren(settings, auth, this.reportForm(), this.status, h('section', h('h3', 'Report jobs'), this.jobList));
    this.renderJobs();
  }

  private reportForm(): HTMLElement {
    const form = h('section', h('h3', 'Prepare a report'));
    const kind = select('local-ai-report-kind', Object.entries(KINDS), this.kind);
    const choices: Array<[string, string]> = this.state!.mode === 'local'
      ? [['local', LABELS.local]] : [['routine', LABELS.routine], ['important', LABELS.important]];
    const preset = select('local-ai-report-preset', choices, this.preset);
    const details = h('div');
    const input = document.createElement('input');
    input.id = 'local-ai-report-input';
    input.value = this.inputValue;
    input.maxLength = 500;
    input.addEventListener('input', () => { this.inputValue = input.value; });
    const inputField = field('Report subject', input);
    const region = select('local-ai-report-region', REGIONS, REGIONS.some(([id]) => id === this.inputValue) ? this.inputValue : 'mena');
    const regionField = field('Region', region);
    region.addEventListener('change', () => { this.inputValue = region.value; });
    const updateInput = () => {
      const labels: Partial<Record<LocalReportKind, string>> = {
        country: 'Country code (for example, IL)', situation: 'Situation or question',
        stock: 'Stock symbol (for example, MSFT)',
      };
      const needsRegion = this.kind === 'regional' || this.kind === 'weekly';
      regionField.hidden = !needsRegion;
      if (needsRegion) this.inputValue = region.value;
      else this.inputValue = input.value;
      inputField.hidden = !labels[this.kind];
      inputField.querySelector('span')!.textContent = labels[this.kind] || '';
    };
    const unavailable = h('p', { role: 'status', id: 'local-ai-model-warning' });
    const submit = button('Generate report', () => { void this.run(async () => {
      const value = this.inputValue.trim();
      const keys: Partial<Record<LocalReportKind, string>> = {
        country: 'countryCode', situation: 'query', stock: 'symbol', regional: 'regionId', weekly: 'regionId',
      };
      const key = keys[this.kind];
      if (key && !value) throw new Error('Enter a report subject.');
      const job = await localInference.submit({
        kind: this.kind, input: key ? { [key]: this.kind === 'country' || this.kind === 'stock' ? value.toUpperCase() : value } : {}, preset: this.preset,
        overrides: this.overrides ? { model: this.overrides.model, effort: this.overrides.effort } : undefined,
      });
      if (this.destroyed) return;
      this.jobs = [job, ...this.jobs.filter(item => item.id !== job.id)];
      this.renderJobs();
      this.schedulePoll();
      this.status.textContent = `Report ${job.status}.`;
    }); }, 'local-ai-generate');
    const check = () => {
      const profile = this.overrides ?? this.state!.presets[this.preset];
      const supported = this.models(this.preset).some(([model]) => model === profile.model)
        && this.efforts(this.preset, profile.model).some(([effort]) => effort === profile.effort);
      const signedIn = this.preset === 'local' || !!this.capabilities?.account;
      submit.disabled = !supported || !signedIn;
      unavailable.textContent = !signedIn ? 'Sign in before requesting a hosted report.'
        : !supported ? 'The selected model or reasoning level is unavailable. Select a supported choice.' : '';
    };
    const updateProfile = () => {
      const profile = { ...this.state!.presets[this.preset], ...this.overrides };
      this.overrides = profile;
      details.replaceChildren(this.profileFields(this.preset, profile, 'local-ai-report', check),
        h('p', `Time limit including queue: ${profile.timeoutMs / 1000} seconds. Model and evidence are captured when submitted.`));
      check();
    };
    kind.addEventListener('change', () => { this.kind = kind.value as LocalReportKind; updateInput(); });
    preset.addEventListener('change', () => { this.preset = preset.value as LocalInferencePreset; this.overrides = undefined; updateProfile(); });
    updateInput();
    updateProfile();
    form.append(field('Report type', kind), inputField, regionField, field('Preset', preset), details, unavailable, submit);
    return form;
  }

  private renderJobs(): void {
    this.jobList.replaceChildren(...this.jobs.map(job => {
      const actual = job.actual || job.profile;
      const entry = h('article', { className: 'local-ai-job', dataset: { jobId: job.id, status: job.status } },
        h('h4', `${KINDS[job.kind] ?? job.kind} · ${job.status}`),
        h('p', `${actual.provider} · ${actual.model} · ${actual.effort}`),
        h('p', `Submitted ${new Date(job.createdAt).toLocaleString()} · Deadline ${new Date(job.deadlineAt).toLocaleString()}`));
      if (ACTIVE.has(job.status)) entry.append(button('Cancel report', () => { void this.run(async () => {
        const updated = await localInference.cancel(job.id);
        this.jobs = this.jobs.map(item => item.id === updated.id ? updated : item);
        this.renderJobs();
        this.schedulePoll();
        this.status.textContent = 'Cancellation requested.';
      }); }));
      if (job.error) entry.append(h('p', { role: 'alert' }, typeof job.error === 'string' ? job.error : job.error.message || job.error.code || 'Report failed.'));
      if (job.status === 'interrupted') entry.append(h('p', 'Interrupted by restart. Submit a new report to retry.'));
      if (job.result != null) entry.append(h('details', h('summary', 'Read report and evidence'), renderResult(job.result)));
      return entry;
    }));
    if (!this.jobs.length) this.jobList.append(h('p', 'No reports requested.'));
  }
}
