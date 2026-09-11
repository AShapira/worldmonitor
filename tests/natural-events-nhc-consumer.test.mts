import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { listNaturalEvents } from '../server/worldmonitor/natural/v1/list-natural-events.ts';

const NOW = Date.parse('2026-09-07T10:05:00.000Z');
const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

test('natural-events consumer serves a retained NHC storm from the seeded envelope', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.nhc-consumer.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-only';
  const storm = {
    id: 'nhc-AL01-7',
    title: 'Tropical Storm Alpha',
    category: 'severeStorms',
    lat: 20,
    lon: -60,
    date: NOW - 60_000,
    sourceName: 'NHC',
  };
  const values = new Map([
    ['natural:events:v1', JSON.stringify({
      _seed: { fetchedAt: NOW, recordCount: 1, sourceVersion: 'fixture', schemaVersion: 2, state: 'OK' },
      data: { events: [storm] },
    })],
    ['seed-meta:natural:events', JSON.stringify({ fetchedAt: NOW, recordCount: 1, sourceState: 'degraded' })],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.slice('/get/'.length));
    return Response.json({ result: values.get(key) ?? null });
  };

  const response = await listNaturalEvents({} as never, {});

  assert.equal(response.dataAvailable, true);
  assert.equal(response.fetchedAt, NOW);
  assert.deepEqual(response.events, [storm]);
});
