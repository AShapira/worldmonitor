import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CodexClient } from './codex.mjs';

// Optional real-protocol test uses a fresh Codex home and a LOCAL mock Responses
// endpoint. It never signs in, uses a subscription/API allowance, or loads Ollama.
test('pinned Codex request has no execution environment or filesystem/network tools', { skip: !process.env.WM_CODEX_TEST_BINARY }, async t => {
  const home = await mkdtemp('/tmp/wm-inference-codex-test-'); await mkdir(home + '/empty');
  let received;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url.includes('/responses')) {
      received = JSON.parse(body);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Controlled protocol test ends before inference', code: 'test' } }));
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new CodexClient({ binary: process.env.WM_CODEX_TEST_BINARY, home, cwd: home + '/empty', config: {
    model_provider: 'fixture', 'model_providers.fixture.name': 'fixture',
    'model_providers.fixture.base_url': `http://127.0.0.1:${server.address().port}/v1`,
    'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.requires_openai_auth': false,
    'features.enable_request_compression': false,
  } });
  t.after(async () => { client.close(); server.closeAllConnections(); server.close(); await rm(home, { recursive: true, force: true }); });
  await client.start();
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'Use only source [1].' }], profile: { model: 'gpt-5.6-luna', effort: 'low' }, signal: AbortSignal.timeout(15000), deadlineAt: Date.now() + 15000 }));
  assert.ok(received, 'real binary must reach the controlled endpoint');
  assert.equal(received.model, 'gpt-5.6-luna'); assert.equal(received.reasoning.effort, 'low');
  const tools = [...(received.tools || []), ...received.input.filter(i => i.type === 'additional_tools').flatMap(i => i.tools)];
  const specs = JSON.stringify(tools);
  for (const name of ['apply_patch', 'view_image', '### `mcp__', 'web_search', 'spawn_agent', 'request_plugin_install']) assert.ok(!specs.includes(name), `unexpected tool ${name}`);
  // Code-mode's generic examples mention exec_command; an actual executable
  // tool has a declaration section, which must not exist.
  assert.ok(!specs.includes('### `exec_command`'));
  assert.equal(client.pending.size, 0);
});

function controlledClient(notify) {
  const client = new CodexClient(); const requests = [];
  client.start = async () => {};
  client.child = { killed: false, kill() { this.killed = true; }, stdin: { write() {} } };
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      setImmediate(() => notify(client));
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  return { client, requests };
}
const completion = signal => ({ messages: [{ role: 'user', content: 'Supplied evidence [1]' }],
  profile: { model: 'gpt-6-astra', effort: 'high' }, signal, deadlineAt: Date.now() + 5000 });
const notification = (client, method, params) => client.emit('notification', { method, params: { threadId: 'thread', ...params } });

test('Codex returns only completed final text with the requested reasoning profile', async () => {
  const { client, requests } = controlledClient(c => {
    notification(c, 'item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Working...' } });
    notification(c, 'item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Report [1]' } });
    notification(c, 'turn/completed', { turn: { status: 'completed' } });
  });
  const result = await client.complete(completion(new AbortController().signal));
  assert.equal(result.text, 'Report [1]'); assert.equal(result.model, 'gpt-6-astra'); assert.equal(result.effort, 'high');
  assert.deepEqual(requests.find(r => r.method === 'thread/start').params.environments, []);
  assert.equal(requests.at(-1).method, 'thread/unsubscribe');
});
test('Codex cancellation stops its process before reporting completion', async () => {
  const controller = new AbortController();
  const { client } = controlledClient(() => controller.abort());
  await assert.rejects(client.complete(completion(controller.signal)), /cancelled/);
  assert.equal(client.child.killed, true);
  assert.equal(client.listenerCount('notification'), 0);
});
test('Codex model rerouting is an explicit failure, never a silent substitution', async () => {
  const { client } = controlledClient(c => notification(c, 'model/rerouted', { fromModel: 'gpt-6-astra', toModel: 'other' }));
  await assert.rejects(client.complete(completion(new AbortController().signal)), /changed the selected model/);
  assert.equal(client.child.killed, true);
});
test('Codex allowance and login failures are safe actionable errors', async () => {
  for (const [code, message] of [['usageLimitExceeded', /allowance exhausted/], ['unauthorized', /login expired/]]) {
    const { client } = controlledClient(c => notification(c, 'turn/completed', { turn: { status: 'failed', error: { codexErrorInfo: code } } }));
    await assert.rejects(client.complete(completion(new AbortController().signal)), message);
  }
});
