import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('Podman environment upgrades', () => {
  for (const command of ['init', 'config', 'build', 'up', 'restart']) {
    it(`${command} adds the session secret once and preserves operator settings`, () => {
      const fixture = mkdtempSync(resolve(tmpdir(), 'wm-podman-upgrade-'));
      try {
        mkdirSync(resolve(fixture, 'scripts'));
        copyFileSync(resolve(root, 'scripts/podman-local.sh'), resolve(fixture, 'scripts/podman-local.sh'));
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
