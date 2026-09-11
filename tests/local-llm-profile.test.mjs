import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLocalLlm, isLocalLlmProfile, localLlmCacheTag } from '../scripts/_local-llm-profile.mjs';
const env = { WM_LOCAL_LLM_PROFILE: 'balanced', OLLAMA_API_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'qwen3.5:9b' };
const reply = (content, finish_reason='stop') => Response.json({ choices: [{message:{content},finish_reason}],usage:{total_tokens:10} });
test('opt-in and localhost restriction prevent accidental cloud dispatch', async () => {
 let calls=0; const fetch=async()=>{calls++;return reply('ok');};
 assert.equal(await callLocalLlm({env:{},fetch}),null);
 assert.equal(await callLocalLlm({env:{...env,OLLAMA_API_URL:'https://example.org'},fetch}),null);
 assert.equal(calls,0);assert.equal(isLocalLlmProfile(env),true);
});
test('report retries length-limited thinking as direct within same model and validates final', async () => {
 const bodies=[];
 const result=await callLocalLlm({env,maxTokens:1200,background:false,validate:async t=>JSON.parse(t).ok===true,fetch:async(url,opts)=>{
  assert.equal(url,'http://127.0.0.1:11434/v1/chat/completions');
  bodies.push(JSON.parse(opts.body));
  return bodies.length===1 ? reply('unfinished','length') : reply('```json\n{"ok":true}\n```');
 }});
 assert.equal(result.text,'{"ok":true}');
 assert.equal(result.model,'qwen3.5:9b');
 assert.deepEqual(bodies.map(b=>[b.reasoning_effort,b.max_tokens]),[['medium',6144],['none',1200]]);
});
test('direct utility keeps its small token cap and never reasons',async()=>{
 let body;
 const r=await callLocalLlm({env,report:false,maxTokens:50,fetch:async(_,o)=>{body=JSON.parse(o.body);return reply('ok');}});
 assert.equal(r.text,'ok');assert.equal(body.max_tokens,50);assert.equal(body.think,false);
});
test('total deadline bounds stalled fetch and serialized background queue',async()=>{
 const started=Date.now();let calls=0;
 const fetch=()=>{calls++;return new Promise(()=>{});};
 const results=await Promise.all([callLocalLlm({env,timeoutMs:35,fetch}),callLocalLlm({env,timeoutMs:10,fetch})]);
 assert.deepEqual(results,[null,null]);assert.equal(calls,1);assert.ok(Date.now()-started<500);
 const next=await callLocalLlm({env,fetch:async()=>reply('recovered')});assert.equal(next.text,'recovered');
});
test('cache identity separates model, quantization digest and disabled mode',()=>{
 assert.equal(localLlmCacheTag({}), '');
 assert.notEqual(localLlmCacheTag(env),localLlmCacheTag({...env,OLLAMA_MODEL:'qwen3:14b'}));
 assert.notEqual(localLlmCacheTag(env),localLlmCacheTag({...env,WM_LOCAL_LLM_MODEL_DIGEST:'abc'}));
});
test('invalid and empty answers do not become successful reports',async()=>{
 assert.equal(await callLocalLlm({env,fetch:async()=>reply('<think>private reasoning</think>')}),null);
 assert.equal(await callLocalLlm({env,validate:()=>false,fetch:async()=>reply('wrong')}),null);
});

test('local dispatch refuses redirects so inference cannot escape through a local redirect', async () => {
 let calls = 0;
 assert.equal(await callLocalLlm({ env, report: false, fetch: async (_, opts) => {
  calls++;
  assert.equal(opts.redirect, 'error');
  throw new TypeError('unexpected redirect');
 }}), null);
 assert.equal(calls, 1);
});

test('caller cancellation promptly removes queued work and keeps the queue usable', async () => {
 let releaseFirst;
 let firstStarted;
 const started = new Promise(resolve => { firstStarted = resolve; });
 const first = callLocalLlm({ env, timeoutMs: 1000, fetch: () => {
  firstStarted(); return new Promise(resolve => { releaseFirst = resolve; });
 }});
 await started;
 const controller = new AbortController();
 const queued = callLocalLlm({ env, signal: controller.signal, timeoutMs: 1000,
  fetch: () => assert.fail('cancelled queued request dispatched') });
 controller.abort();
 const result = await Promise.race([queued, new Promise(resolve => setTimeout(() => resolve('slow'), 100))]);
 assert.equal(result, null);
 releaseFirst(reply('first'));
 assert.equal((await first).text, 'first');
 assert.equal((await callLocalLlm({env,fetch:async()=>reply('next')})).text, 'next');
});

test('caller cancellation returns even when transport ignores AbortSignal and late output is not validated', async () => {
 const controller = new AbortController();
 let releaseResponse;
 let requestStarted;
 const started = new Promise(resolve => { requestStarted = resolve; });
 const operation = callLocalLlm({ env, background: false, signal: controller.signal, timeoutMs: 1000,
  validate: () => assert.fail('late cancelled output validated'),
  fetch: () => { requestStarted(); return new Promise(resolve => { releaseResponse = resolve; }); } });
 await started;
 controller.abort();
 assert.equal(await Promise.race([operation, new Promise(resolve => setTimeout(() => resolve('slow'), 100))]), null);
 releaseResponse(reply('late'));
 await new Promise(resolve => setImmediate(resolve));
});

test('unsupported finish reasons and tool requests never become final prose', async () => {
 for (const finish of ['length', 'content_filter', 'tool_calls']) {
  assert.equal(await callLocalLlm({env,report:false,fetch:async()=>reply('partial',finish)}),null);
 }
 assert.equal(await callLocalLlm({env,report:false,fetch:async()=>Response.json({choices:[{
  message:{content:'partial',tool_calls:[{id:'call_1'}]},finish_reason:'stop',
 }]})}),null);
});

test('inference reports the returned model identifier as provenance', async () => {
 const result=await callLocalLlm({env,report:false,fetch:async()=>Response.json({model:'qwen3.5:9b-q4_K_M',choices:[{
  message:{content:'Final answer'},finish_reason:'stop',
 }]})});
 assert.equal(result.model,'qwen3.5:9b-q4_K_M');
});
