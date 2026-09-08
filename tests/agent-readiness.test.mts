import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import middleware from '../middleware';
import agentRequestPolicy from '../shared/agent-request-policy.json';

describe('public agent documents', () => {
  // auth.md is intentionally heading-led for scanner compatibility. Its title,
  // description, and canonical identity are guarded in the dedicated auth suite.
  const files = readdirSync(new URL('../public/', import.meta.url)).filter(
    (file) => file.endsWith('.md') && file !== 'auth.md',
  );
  files.push('api/download.md');
  for (const file of files) {
    it(`${file} opens with document metadata`, () => {
      const document = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
      const frontmatter = document.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(frontmatter, file);
      const metadata = load(frontmatter[1]) as Record<string, string>;
      assert.ok(metadata.title?.length > 0);
      assert.ok(metadata.description?.length > 0);
      assert.equal(new URL(metadata.canonical).origin, 'https://www.worldmonitor.app');
    });
  }
});

describe('agent homepage routing', () => {
  for (const agent of agentRequestPolicy.userAgents) {
    it(`${agent} receives the Markdown document even with Accept: text/html`, async () => {
      for (const host of ['worldmonitor.app', 'www.worldmonitor.app']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await middleware(new Request(`https://${host}/`, {
            method, headers: { 'User-Agent': `${agent}/1.0`, Accept: 'text/html' },
          }));
          assert.ok(response);
          assert.equal(response.headers.get('x-middleware-rewrite'), `https://${host}/home.md`);
          assert.match(response.headers.get('content-type')!, /text\/markdown/);
          for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
            assert.match(response.headers.get(header)!, /no-store/);
          }
          assert.equal(response.headers.get('vary'), 'User-Agent');
        }
      }
    });
  }

  it('preserves JSON agent mode, browsers, search crawlers, variants, and other paths', async () => {
    for (const [url, ua] of [
      ['https://www.worldmonitor.app/?mode=agent', 'ClaudeBot/1.0'],
      ['https://www.worldmonitor.app/', 'Mozilla/5.0'],
      ['https://www.worldmonitor.app/', 'Googlebot/2.1'],
      ['https://www.worldmonitor.app/', 'NotClaudeBot/1.0'],
      ['https://www.worldmonitor.app/dashboard', 'ClaudeBot/1.0'],
      ['https://tech.worldmonitor.app/', 'ClaudeBot/1.0'],
    ]) {
      assert.equal(await middleware(new Request(url, { headers: { 'User-Agent': ua } })), undefined);
    }
  });

  it('keeps legacy map links on the dashboard redirect', async () => {
    const response = await middleware(new Request('https://www.worldmonitor.app/?lat=1&lon=2', {
      headers: { 'User-Agent': 'ClaudeBot/1.0' },
    }));
    assert.equal(response?.status, 308);
    assert.equal(response?.headers.get('location'), 'https://www.worldmonitor.app/dashboard');
  });
});

describe('API User-Agent denial', () => {
  for (const ua of ['', 'ora-agent', 'curl/8.1.2', 'ClaudeBot/1.0']) {
    it(`keeps the denial and returns recovery details for ${ua || 'missing UA'}`, async () => {
      const response = await middleware(new Request('https://www.worldmonitor.app/api/unknown', {
        headers: { 'User-Agent': ua },
      }));
      assert.equal(response?.status, 403);
      assert.match(response!.headers.get('content-type')!, /application\/json/);
      const body = await response!.json();
      assert.equal(body.error, 'Forbidden');
      assert.equal(body.code, 'agent_request_blocked');
      assert.ok(body.message);
      assert.match(body.hint, /User-Agent.*X-WorldMonitor-Key.*auth\.md/);
    });
  }
});
