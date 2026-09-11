import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import vm from 'node:vm';
import { parse as parseYaml } from 'yaml';
import modelPolicy from '../scripts/lib/llm-model-policy.cjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('Podman environment upgrades', () => {
  it('explicit model migration preserves credentials and saves a protected rollback copy', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'wm-qwen35-migrate-'));
    try {
      mkdirSync(resolve(fixture, 'scripts'));
      copyFileSync(resolve(root, 'scripts/podman-local.sh'), resolve(fixture, 'scripts/podman-local.sh'));
      mkdirSync(resolve(fixture, 'deploy'));
      copyFileSync(resolve(root, 'deploy/local-llm-lock.json'), resolve(fixture, 'deploy/local-llm-lock.json'));
      const original = 'OLLAMA_MODEL=qwen3:14b\nLLM_MODEL=qwen3:14b\nREDIS_TOKEN=fixture-token\n';
      writeFileSync(resolve(fixture, '.env'), original, { mode: 0o600 });
      const state = resolve(fixture, 'state');
      execFileSync('bash', [resolve(fixture, 'scripts/podman-local.sh'), 'migrate-model'], { env: { ...process.env, XDG_STATE_HOME: state } });
      const env = parseEnv(readFileSync(resolve(fixture, '.env'), 'utf8'));
      assert.equal(env.OLLAMA_MODEL, 'qwen3.5:9b');
      assert.equal(env.LLM_MODEL, 'qwen3.5:9b');
      assert.equal(env.WM_LOCAL_LLM_PROFILE, 'balanced');
      assert.equal(env.OLLAMA_CONTEXT_LENGTH, '16384');
      assert.equal(env.REDIS_TOKEN, 'fixture-token');
      assert.equal(env.WM_LOCAL_LLM_MODEL_DIGEST, JSON.parse(readFileSync(resolve(root, 'deploy/local-llm-lock.json'), 'utf8')).modelDigest);
      const backupDir = resolve(state, 'worldmonitor/env-backups');
      const backups = readdirSync(backupDir);
      assert.ok(!readdirSync(fixture).some(name => name.includes('backup-qwen35')), 'no plaintext env dumps in checkout root');
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(resolve(backupDir, backups[0]), 'utf8'), original);
      assert.equal(statSync(resolve(backupDir, backups[0])).mode & 0o777, 0o600);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('the relay requests usable Qwen classifications instead of reasoning-only completions', async () => {
    let requestBody;
    const server = http.createServer(async (req, res) => {
      let data = '';
      for await (const chunk of req) data += chunk;
      requestBody = JSON.parse(data);
      // Model the OpenAI-compatible response when reasoning consumes the
      // entire short completion budget, versus a usable classification.
      const content = requestBody.reasoning_effort === 'none'
        ? '[{"i":0,"l":"info","c":"general"}]' : '';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      // Execute the production provider chain and HTTP request implementation
      // without booting the relay's unrelated long-lived ingestion loops.
      const source = read('scripts/ais-relay.cjs');
      const start = source.indexOf('const CLASSIFY_LLM_PROVIDERS =');
      const end = source.indexOf('let classifyInFlight =', start);
      assert.ok(start >= 0 && end > start);
      const classify = vm.runInNewContext(source.slice(start, end) + '\nclassifyFetchLlm', {
        ...modelPolicy, http, https, URL, Buffer, console,
        CHROME_UA: 'worldmonitor-fixture/1.0', CLASSIFY_SYSTEM_PROMPT: 'Classify the test headline.',
        process: { env: { OLLAMA_API_URL: `http://127.0.0.1:${server.address().port}`, OLLAMA_MODEL: 'qwen3:14b' } },
      });
      const result = await classify(['A public library opens.']);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ i: 0, l: 'info', c: 'general' }]);
      assert.equal(requestBody.model, 'qwen3:14b');
      assert.equal(requestBody.max_tokens, 40);
      assert.equal(requestBody.think, false);
    } finally {
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  for (const command of ['init', 'config', 'build', 'up', 'restart']) {
    it(`${command} adds the session secret once and preserves operator settings`, () => {
      const fixture = mkdtempSync(resolve(tmpdir(), 'wm-podman-upgrade-'));
      try {
        mkdirSync(resolve(fixture, 'scripts'));
        copyFileSync(resolve(root, 'scripts/podman-local.sh'), resolve(fixture, 'scripts/podman-local.sh'));
      mkdirSync(resolve(fixture, 'deploy'));
      copyFileSync(resolve(root, 'deploy/local-llm-lock.json'), resolve(fixture, 'deploy/local-llm-lock.json'));
        const original = 'OLLAMA_MODEL=custom-model\nWORLDMONITOR_API_KEY=wm_fixture_operator\nREDIS_TOKEN=fixture-redis-token\n';
        writeFileSync(resolve(fixture, '.env'), original, { mode: 0o600 });
        // Model Compose's required-secret check before any build/start/stop.
        // This also catches init being delayed until after restart tears down.
        const compose = resolve(fixture, 'compose');
        writeFileSync(compose, '#!/bin/sh\nset -eu\n. "$2"\n[ "${#WM_SESSION_SECRET}" -ge 32 ]\n', { mode: 0o700 });
        const env = { ...process.env, PODMAN_COMPOSE: compose };
        execFileSync('bash', [resolve(fixture, 'scripts/podman-local.sh'), command], { env });
        const after = readFileSync(resolve(fixture, '.env'), 'utf8');
        assert.ok(after.startsWith(original), 'existing settings must be preserved verbatim');
        const values = parseEnv(after);
        assert.match(values.WM_SESSION_SECRET, /^[a-f0-9]{64}$/);
        assert.equal(values.OLLAMA_MODEL, 'custom-model');
        assert.equal(values.WORLDMONITOR_RELAY_KEY, 'wm_fixture_operator');
        assert.equal(statSync(resolve(fixture, '.env')).mode & 0o777, 0o600);
        execFileSync(process.execPath, [resolve(root, 'docker/validate-session-secret.mjs')], {
          env: { ...process.env, WM_SESSION_SECRET: values.WM_SESSION_SECRET },
        });
        execFileSync('bash', [resolve(fixture, 'scripts/podman-local.sh'), command], { env });
        assert.equal(readFileSync(resolve(fixture, '.env'), 'utf8'), after, 'a restart must not rotate secrets');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }

  it('keeps relay and LLM container URLs independent of host environment substitutions', () => {
    const overlay = parseYaml(read('compose.ollama.yml'));
    assert.equal(overlay.services['ais-relay'].environment.API_BASE_URL, 'http://worldmonitor:8080');
    assert.equal(overlay.services.worldmonitor.environment.OLLAMA_API_URL, 'http://ollama:11434');
    assert.equal(overlay.services.worldmonitor.environment.LLM_API_URL, 'http://ollama:11434/v1/chat/completions');
  });
});

describe('RHEL rootless Podman deployment', () => {
  const overlay = read('compose.ollama.yml');
  const launcher = read('scripts/podman-local.sh');
  const dockerignore = read('.dockerignore');
  const entrypoint = read('docker/entrypoint.sh');
  const nginx = read('docker/nginx.conf');

  it('pins Ollama, grants only the NVIDIA CDI device, and binds it to loopback', () => {
    assert.match(overlay, /docker\.io\/ollama\/ollama@sha256:[a-f0-9]{64}/);
    assert.match(overlay, /nvidia\.com\/gpu=all/);
    assert.match(overlay, /127\.0\.0\.1:11434:11434/);
    assert.match(overlay, /OLLAMA_NO_CLOUD:\s*"1"/);
  });

  it('routes native and generic LLM callers to the internal Ollama service', () => {
    const insightsSeeder = read('scripts/seed-insights.mjs');
    assert.match(overlay, /OLLAMA_API_URL:\s*"http:\/\/ollama:11434"/);
    assert.match(overlay, /LLM_API_URL:\s*"http:\/\/ollama:11434\/v1\/chat\/completions"/);
    assert.match(overlay, /LLM_API_KEY:\s*"\$\{LLM_API_KEY:-ollama\}"/);
    assert.match(overlay, /LLM_REASONING_EFFORT:\s*"\$\{LLM_REASONING_EFFORT:-none\}"/);
    assert.match(overlay, /GROQ_API_KEY:\s*""/);
    assert.match(overlay, /OPENROUTER_API_KEY:\s*""/);
    assert.match(insightsSeeder, /reasoning_effort: process\.env\.LLM_REASONING_EFFORT \|\| 'none'/);
  });

  it('passes the relay secret to both authenticated peers', () => {
    const occurrences = overlay.match(/^\s+RELAY_SHARED_SECRET:/gm) ?? [];
    assert.equal(occurrences.length, 2);
  });

  it('generates and allowlists an ignored local operator key for authenticated handlers', () => {
    assert.match(launcher, /append_env WORLDMONITOR_API_KEY "wm_local_/);
    assert.match(launcher, /append_env WORLDMONITOR_VALID_KEYS/);
    assert.match(launcher, /append_env WORLDMONITOR_RELAY_KEY/);
    assert.match(launcher, /append_env API_BASE_URL "http:\/\/127\.0\.0\.1:3000"/);
    assert.match(overlay, /WORLDMONITOR_API_KEY:\s*"\$\{WORLDMONITOR_API_KEY:\?/);
    assert.match(overlay, /WORLDMONITOR_VALID_KEYS:\s*"\$\{WORLDMONITOR_VALID_KEYS:\?/);
    assert.match(overlay, /WORLDMONITOR_RELAY_KEY:\s*"\$\{WORLDMONITOR_RELAY_KEY:\?/);
    assert.match(overlay, /VITE_LOCAL_OPERATOR_MODE:\s*"1"/);
    assert.match(nginx, /proxy_set_header X-WorldMonitor-Key \$worldmonitor_api_key/);
    assert.match(nginx, /~\^wms_ "\$\{WORLDMONITOR_API_KEY\}"/);
    assert.match(entrypoint, /\$WORLDMONITOR_API_KEY/);
  });

  it('keeps local environment files out of image build contexts', () => {
    const rules = new Set(dockerignore.split('\n').map((line) => line.trim()));
    assert.ok(rules.has('.env*'));
    assert.ok(rules.has('.npmrc'));
    assert.ok(rules.has('*.key'));
    assert.ok(rules.has('*.pem'));
  });

  it('uses an explicit two-file Podman Compose invocation', () => {
    assert.match(launcher, /-f "\$\{BASE_COMPOSE\}"/);
    assert.match(launcher, /-f "\$\{OLLAMA_COMPOSE\}"/);
    assert.match(launcher, /WM_PORT "127\.0\.0\.1:3000"/);
    assert.match(launcher, /chmod 600 "\$\{ENV_FILE\}"/);
    assert.match(launcher, /systemctl --user --machine="\$\{USER\}@\.host" daemon-reexec/);
  });

  it('ignores RHEL subscription secret filenames that are not env identifiers', () => {
    assert.match(entrypoint, /\*\[!A-Za-z0-9_\]\*\) continue/);
  });

  it('allows only configured private LLM origins through the Docker sidecar SSRF guard', () => {
    const sidecar = read('src-tauri/sidecar/local-api-server.mjs');
    assert.match(sidecar, /context\.mode === 'docker'/);
    assert.match(sidecar, /\['LLM_API_URL', 'OLLAMA_API_URL'\]/);
    assert.match(sidecar, /addConfiguredPrivateOrigin\(envKey, 'LLM calls will be SSRF-blocked'\)/);
  });
});
