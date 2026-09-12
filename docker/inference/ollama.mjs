export class OllamaClient {
  constructor(url, fetcher = fetch) { this.url = url; this.fetch = fetcher; }
  async request(path, body, signal = AbortSignal.timeout(10000)) {
    const response = await this.fetch(new URL(path, this.url), {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-inference/1.0' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error',
    });
    if (!response.ok) throw new Error('Ollama request failed');
    return response.json();
  }
  async models() { return (await this.request('/api/tags')).models || []; }
  async unload(model) {
    const loaded = (await this.request('/api/ps')).models || [];
    if (loaded.some(m => m.name === model || m.model === model)) await this.request('/api/generate', { model, keep_alive: 0 });
    for (let attempt = 0; attempt < 20; attempt++) {
      const remaining = (await this.request('/api/ps')).models || [];
      if (!remaining.some(m => m.name === model || m.model === model)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Model remained loaded');
  }
  async complete({ messages, profile, signal, deadlineAt, report, maxTokens, responseFormat }) {
    const efforts = profile.effort === 'off' || !report ? [false] : profile.effort === 'on' ? [true] : [true, false];
    for (const thinking of efforts) {
      if (signal.aborted) return null;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return null;
      try {
        const data = await this.request('/v1/chat/completions', {
          model: profile.model, messages, stream: false,
          temperature: thinking ? 1 : 0.7, top_p: thinking ? 0.95 : 0.8, presence_penalty: 1.5,
          max_tokens: thinking ? 6144 : Math.min(maxTokens || 1500, 6144),
          think: thinking, reasoning_effort: thinking ? 'medium' : 'none',
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(remaining, thinking ? 60000 : 25000)))]));
        const choice = data.choices?.[0];
        if (choice?.finish_reason !== 'stop' || choice?.message?.refusal || choice?.message?.tool_calls?.length) continue;
        const text = choice?.message?.content?.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (text) return { text, model: data.model || profile.model, provider: 'ollama', effort: thinking ? 'on' : 'off', tokens: data.usage?.total_tokens || 0, finishReason: 'stop' };
      } catch { if (signal.aborted) return null; }
    }
    return null;
  }
}
