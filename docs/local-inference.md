# Personal local and ChatGPT inference

This optional rootless Podman configuration adds **Settings → AI** to the local
browser deployment. It supports country briefs, situation analysis, stock
analysis, regional intelligence, weekly intelligence, and daily finance reports.
Public cloud API contracts are unchanged.

## Operating modes

- **Local:** Ollama handles inference using the saved local preset. Existing
  automatic AI policies resume. The initial model is `qwen3.5:9b`, with balanced
  thinking and bounded recovery within 90 seconds.
- **ChatGPT — GPU reserved:** automatic AI calls are rejected; data collection
  continues and saved reports remain visible with their original attribution.
  Only an explicit **Generate report** action starts a hosted job. Reservation
  persists through restarts, failed login, and exhausted subscription allowance.

The initial hosted presets are `gpt-5.6-luna` / `low` / 90 seconds and
`gpt-6-astra` / `high` / 300 seconds. These are comparison candidates, not claims
of equivalence to Qwen. Model choices come from the authenticated Codex catalog;
an unavailable preset requires an explicit supported selection. Save presets or
override model and effort for one report. All deadlines include queueing.

One inference request runs at a time, with at most three admitted report jobs.
Jobs and their prepared evidence are stored in Redis for 24 hours. A restart
marks unfinished jobs interrupted; retry by submitting a new job. Cancellation
stops the dedicated Codex process or aborts the Ollama request. No automatic
provider substitution, separately billed API fallback, or usage reset exists.

## Integration and isolation

The broker uses the documented [Codex app-server](https://learn.chatgpt.com/docs/app-server)
stdio interface, pinned to **0.153.4** in its npm lockfile and container version
check. The supported [ChatGPT login flow](https://learn.chatgpt.com/docs/auth)
uses a separate `inference-auth` named volume. This consumes Codex subscription
allowance, not general OpenAI API credits. This is a personal development
integration, and runtime upgrades require repeating the protocol test.

Codex receives supplied report evidence with tools disabled, read-only sandbox,
no approvals, no execution environment, and no MCP, apps, plugins, shell, editing,
or browsing capabilities. The broker runs as the container's unprivileged
`node` user with a read-only root filesystem, dropped capabilities, and no host
workspace, container socket, or GPU mount. The managed credentials are never
returned to the browser. Only sign-in URLs and device codes are displayed.

The browser uses the authenticated same-origin sidecar proxy. The broker and
its private report callback require a separate generated server credential.
Browser-origin requests to the broker are rejected. Keep the personal dashboard
bound to loopback; do not expose this configuration through a public proxy.
Only allowlisted state, capabilities, login, and job operations are exposed;
raw Codex RPC and usage-reset operations are unavailable.

The app, relay, and host seeders route through the same policy. Missing service,
credentials, or policy storage fails closed. Managed builds retain legacy
background cache identities to display existing reports. Explicit jobs use
provider, model, effort, prompt version, and job identity in cache keys, and
record the actual generation metadata. A stronger request cannot reuse a weaker
report. Regional snapshots and daily briefs retain original report evidence and
generation time separately from newly collected data and headlines.

## Enable after deployment approval

These commands change the deployment configuration and start services. Review
and authorize deployment separately from merging the implementation.

```bash
# Run in the intended deployment checkout, using Node 24 and rootless Podman.
bash scripts/podman-local.sh inference-init
bash scripts/podman-local.sh config
bash scripts/podman-local.sh build
bash scripts/podman-local.sh up
```

`inference-init` appends a dedicated token and enables the overlay in the ignored,
mode-0600 `.env`. It does not start services. The host broker URL defaults to
`http://127.0.0.1:46124`; containers use `http://inference:8080`. Ensure host seeders
load this checkout's `.env` through the existing `loadEnvFile()` helper. If a
custom broker port is configured, update the host `WM_INFERENCE_URL` to match.
Do not copy `.env` or the auth volume into Git, images, or PR attachments.

On first start, the policy defaults to GPU reserved. Open **Settings → AI** and
verify **WorldMonitor model unloaded**. Sign in with ChatGPT using the displayed
device-code flow, then select **Refresh account and reports**. A failed sign-in
leaves the GPU reserved and hosted generation unavailable. The model catalog may
require replacing an unavailable initial model before generation is enabled.

The model remains blocked even if Ollama cannot confirm unloading. Retry saving
GPU-reserved mode after restoring Ollama. Reservation unloads models previously
used by WorldMonitor, including overrides; it does not unload unrelated models.
`verify` checks service reachability without an inference probe in managed mode.
`preload` refuses to load a model in managed mode; select Local explicitly in AI
settings when the GPU becomes available.

## Verification

Controlled tests never consume subscription allowance or load a local model:

```bash
npm run test:inference
npm run test:e2e:local-ai
npm run typecheck
npm run typecheck:api
npm run lint:boundaries
npm run test:sidecar

# Optional protocol test against the exact pinned binary and a local mock server.
WM_CODEX_TEST_BINARY=/path/to/pinned/codex node --test docker/inference/codex.test.mjs
```

The protocol test checks the actual model request and advertised tools using an
empty credential home and a local mock Responses endpoint. Browser tests cover
settings persistence, unavailable model selection, explicit generation,
cancellation, safe source rendering, and zero hosted jobs on dashboard refresh.
Broker tests cover queue limits, immutable profiles, evidence snapshots,
provider validation, authentication, deadlines, cancellation, storage outages,
model unloading, and restart recovery. Worker tests exercise evidence validation
and suppressed automatic generation while retaining saved narrative evidence.

After the separate sign-in, generate one routine and one important report.
Record source citations, coverage gaps, output structure, elapsed time, and the
reported provider/model/effort. Compare with existing Qwen evidence; a fresh
matched comparison must wait until the GPU is available. Passing controlled
checks does not establish hosted report quality or live subscription access.

## Rollback

To pause AI safely, keep GPU-reserved mode and stop only the inference service;
managed callers fail closed while collection continues. Preserve the Redis
policy/job keys and the credential volume. Do not remove volumes as part of
routine rollback.

To restore the previous application release, restore its image/configuration
and prior automatic-worker policy deliberately. Removing the managed overlay or
setting `WM_INFERENCE_ENABLED=0` also requires removing `WM_INFERENCE_URL` from
host-seeder configuration. A legacy deployment can resume Ollama automatically;
keep its AI workers paused while the GPU is reserved. Retain the previous
Qwen3 14B model and existing Qwen3.5 rollback artifacts. Never use a rollback
command that preloads Qwen while another task owns the GPU.
