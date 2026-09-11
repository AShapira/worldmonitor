import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

// Run the production HTTP handler with the redis@4 transaction interface.
// The old multi.sendCommand call failed before EXEC on every real transaction.
test('Redis transaction HTTP route queues allowed commands and rejects the entire forbidden batch', async () => {
  let executions = 0;
  const batches = [];
  const client = {
    on() {}, async connect() {},
    multi() {
      const commands = []; batches.push(commands);
      return {
        addCommand(command) { commands.push(command); return this; },
        async exec() { executions++; return commands.map((_, i) => i === 0 ? 'OK' : 'value'); },
      };
    },
  };
  const source = (await readFile(new URL('../docker/redis-rest-proxy.mjs', import.meta.url), 'utf8'))
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const server = await new AsyncFunction('http', 'crypto', 'createClient', 'process', 'console', `${source}\nreturn server;`)(
    http, crypto, () => client, { env: { PORT: '0', SRH_TOKEN: 'fixture' } }, { log() {}, error() {} },
  );
  try {
    if (!server.listening) await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/multi-exec`;
    const post = body => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: JSON.stringify(body) });
    const ok = await post([['SET', 'test-key', 'value'], ['GET', 'test-key']]);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), [{ result: 'OK' }, { result: 'value' }]);
    assert.deepEqual(batches[0], [['SET', 'test-key', 'value'], ['GET', 'test-key']]);
    assert.equal(executions, 1);
    const denied = await post([['SET', 'test-key', 'unsafe'], ['FLUSHALL']]);
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /not allowed/);
    assert.equal(executions, 1, 'no part of the forbidden transaction may execute');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
