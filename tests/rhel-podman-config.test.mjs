import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

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
    assert.ok(rules.has('.env'));
    assert.ok(rules.has('.env.*'));
    assert.ok(rules.has('!.env.example'));
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
    assert.match(sidecar, /\['OLLAMA_API_URL', 'LLM_API_URL'\]/);
    assert.match(sidecar, /extraAllowedPrivateOrigins\.push\(new URL\(configuredUrl\)\.origin\)/);
  });
});
