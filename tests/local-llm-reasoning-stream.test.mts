import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { callLlmReasoningStream } from '../server/_shared/llm.ts';

const originalFetch = globalThis.fetch;
const envKeys = ['WM_LOCAL_LLM_PROFILE', 'OLLAMA_API_URL', 'OLLAMA_MODEL', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_REASONING_PROVIDER', 'LLM_REASONING_MODEL', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'USAGE_TELEMETRY'];
let saved: Record<string, string | undefined>;
const messages = [{ role: 'system', content: 'Use only supplied evidence.' }, { role: 'user', content: 'Prepare a brief.' }];

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    WM_LOCAL_LLM_PROFILE: 'balanced', OLLAMA_API_URL: 'http://localhost:11434', OLLAMA_MODEL: 'qwen3.5:9b',
    LLM_REASONING_PROVIDER: 'openrouter', LLM_REASONING_MODEL: 'cloud-model-must-not-run',
    OPENROUTER_API_KEY: 'fixture-cloud-key', GROQ_API_KEY: 'fixture-cloud-key',
    LLM_API_URL: 'https://cloud.fixture/v1/chat/completions', LLM_API_KEY: 'fixture-generic-key',
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function completion(content: string, finishReason = 'stop') {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content, reasoning_content: 'PRIVATE_PROVIDER_REASONING' } }] });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function events(text: string) {
  return text.trim().split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, '')));
}

describe('balanced local reasoning SSE adapter', () => {
  it('emits one validated final answer after rejecting a truncated attempt, without cloud calls or reasoning', async () => {
    const bodies: Array<Record<string, any>> = [];
    const final = deferred<Response>();
    const retryStarted = deferred<void>();
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), 'http://localhost:11434/v1/chat/completions');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) return completion('PARTIAL_UNSAFE_ANSWER', 'length');
      retryStarted.resolve();
      return final.promise;
    }) as typeof fetch;
    const reader = callLlmReasoningStream({ messages, timeoutMs: 1000 }).getReader();
    const first = reader.read();
    let emitted = false;
    void first.then(() => { emitted = true; });
    await retryStarted.promise;
    assert.equal(emitted, false, 'a rejected attempt must not publish any SSE bytes');
    final.resolve(completion('<think>PRIVATE_INLINE_REASONING</think>Confirmed source-backed final answer.'));
    const chunks = [await first, await reader.read(), await reader.read()];
    const output = chunks.filter(chunk => chunk.value).map(chunk => new TextDecoder().decode(chunk.value)).join('');
    assert.deepEqual(events(output), [{ delta: 'Confirmed source-backed final answer.' }, { done: true }]);
    assert.equal(chunks[2].done, true);
    assert.doesNotMatch(output, /PRIVATE|PARTIAL/);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].model, 'qwen3.5:9b');
    assert.equal(bodies[0].think, true);
    assert.equal(bodies[0].max_tokens, 6144);
    assert.equal(bodies[1].think, false);
    assert.ok(bodies.every(body => body.stream === false), 'buffered validation is required before publishing SSE');
  });

  it('reports unavailable without emitting hidden-reasoning-only completions', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => { attempts++; return completion('<think>PRIVATE_ONLY</think>'); }) as typeof fetch;
    const output = await new Response(callLlmReasoningStream({ messages, timeoutMs: 1000 })).text();
    assert.deepEqual(events(output), [{ error: 'llm_unavailable' }]);
    assert.equal(attempts, 2);
  });

  it('honors caller cancellation before dispatch', async () => {
    globalThis.fetch = (async () => { assert.fail('an already-cancelled request must not dispatch'); }) as typeof fetch;
    const signal = AbortSignal.abort();
    const output = await new Response(callLlmReasoningStream({ messages, signal })).text();
    assert.deepEqual(events(output), [{ error: 'llm_unavailable' }]);
  });

  it('aborts an active request without retrying when the caller cancels', { timeout: 2000 }, async () => {
    const dispatched = deferred<AbortSignal>();
    let attempts = 0;
    globalThis.fetch = (async (_input, init) => {
      attempts++;
      dispatched.resolve(init!.signal as AbortSignal);
      return new Promise<Response>(() => {}); // Deliberately ignores abort, as a stalled transport can.
    }) as typeof fetch;
    const abort = new AbortController();
    const output = new Response(callLlmReasoningStream({ messages, signal: abort.signal })).text();
    const requestSignal = await dispatched.promise;
    abort.abort();
    assert.deepEqual(events(await output), [{ error: 'llm_unavailable' }]);
    assert.equal(requestSignal.aborted, true);
    assert.equal(attempts, 1);
  });

  it('aborts transport when an SSE consumer cancels its reader', { timeout: 2000 }, async () => {
    const dispatched = deferred<AbortSignal>();
    let attempts = 0;
    globalThis.fetch = (async (_input, init) => {
      attempts++;
      dispatched.resolve(init!.signal as AbortSignal);
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const reader = callLlmReasoningStream({ messages }).getReader();
    const requestSignal = await dispatched.promise;
    await reader.cancel();
    assert.equal(requestSignal.aborted, true);
    assert.equal((await reader.read()).done, true);
    assert.equal(attempts, 1);
  });

  it('closes a stalled response at the total deadline without starting another attempt', { timeout: 2000 }, async () => {
    let requestSignal: AbortSignal | undefined;
    let attempts = 0;
    globalThis.fetch = (async (_input, init) => {
      attempts++;
      requestSignal = init!.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const startedAt = Date.now();
    const output = await new Response(callLlmReasoningStream({ messages, timeoutMs: 20 })).text();
    assert.deepEqual(events(output), [{ error: 'llm_unavailable' }]);
    assert.equal(requestSignal?.aborted, true);
    assert.equal(attempts, 1);
    assert.ok(Date.now() - startedAt < 1000);
  });

  it('fails closed on a nonlocal Ollama endpoint despite configured cloud fallbacks', async () => {
    process.env.OLLAMA_API_URL = 'https://cloud.fixture';
    globalThis.fetch = (async () => { assert.fail('a local stream must never dispatch to cloud inference'); }) as typeof fetch;
    const output = await new Response(callLlmReasoningStream({ messages })).text();
    assert.deepEqual(events(output), [{ error: 'llm_unavailable' }]);
  });

  it('strips recognized reasoning tags from local final content consistently with shared LLM callers', async () => {
    for (const [open, close] of [
      ['<reasoning>', '</reasoning>'], ['<reflection>', '</reflection>'],
      ['<|thinking|>', '<|/thinking|>'], ['<|begin_of_thought|>', '<|end_of_thought|>'],
    ]) {
      globalThis.fetch = (async () => completion(`${open}PRIVATE_REASONING_BLOCK${close}Supported final answer.`)) as typeof fetch;
      const output = await new Response(callLlmReasoningStream({ messages, timeoutMs: 1000 })).text();
      assert.deepEqual(events(output), [{ delta: 'Supported final answer.' }, { done: true }], open);
      globalThis.fetch = (async () => completion(`${open}PRIVATE_UNTERMINATED_REASONING`)) as typeof fetch;
      const rejected = await new Response(callLlmReasoningStream({ messages, timeoutMs: 1000 })).text();
      assert.deepEqual(events(rejected), [{ error: 'llm_unavailable' }], `${open} without closing tag`);
    }
  });
});
