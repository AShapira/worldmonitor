# Local Qwen3.5 9B deployment

Qwen3.5 9B (Q4_K_M) is the selected replacement for Qwen3 14B for this fork's
English intelligence and finance reports. The selection was made on September
10, 2026, and implementation was authorized on September 11. It targets the
existing RTX 5080 with 16 GB VRAM, using rootless Podman under RHEL/WSL.

## Runtime contract

The Podman overlay enables `WM_LOCAL_LLM_PROFILE=balanced`. With this opt-in,
server handlers and host seeders send inference only to the configured local
Ollama service, even if cloud credentials exist elsewhere in the environment.
Hosted configurations without this profile retain their provider behavior.

- Model: `qwen3.5:9b`, Q4_K_M. The exact validated model and runtime digests
  are recorded in `deploy/local-llm-lock.json`; pull/verify rejects tag drift.
- Runtime: Ollama 0.34.0, pinned by container digest in `compose.ollama.yml`.
- Context: 16,384 tokens; `OLLAMA_NUM_PARALLEL=2`; one loaded model. The Qwen
  runner may serialize inference internally; simultaneous requests were accepted.
- Utilities and short daily-market summaries: direct answers, existing short caps.
- Country/stock/situation analysis and longer prose: at most 90 seconds including
  queueing; a 60-second thinking attempt followed by at most 25 seconds for one
  direct-answer recovery, within the same overall deadline.
- Thinking attempts allow 6,144 completion tokens including reasoning. Only
  validated final answers are published. Existing report structures remain.
- Background prose is serialized within each worker; the local seeder launcher
  uses `flock` to prevent overlapping runs. Ollama bounds GPU concurrency.
- Regional narratives, weekly briefs, AI Insights, daily-market briefs, stock
  analysis and market implications use the local model. Financial calculations,
  evidence checks and hosted probability-stage policies remain intact.

Generated prose caches include the local profile and model identity. Historical
reports keep their original provenance. Do not flush Redis to change models.

## Existing deployment migration

Use a dedicated deployment checkout based on the upstream-sync PR. Preserve the
previous checkout, image IDs, service configuration and model before switching.
Copy the existing ignored `.env` into the new checkout with mode 0600; do not
commit environment files or print their values.

```bash
scripts/podman-local.sh migrate-model
scripts/podman-local.sh config
scripts/podman-local.sh build
scripts/podman-local.sh up
scripts/podman-local.sh pull-model
scripts/podman-local.sh preload
scripts/podman-local.sh verify
```

`migrate-model` backs up `.env` as an ignored mode-0600 `.env.backup-qwen35.*`
file and explicitly updates both model routes and the balanced profile. Normal
`init` still preserves existing operator choices. The Compose project is
`worldmonitor`, independent of the checkout directory, preserving named volumes.
Use `WM_COMPOSE_PROJECT` for a separately isolated deployment.

If a Windows NVIDIA driver update invalidates the host CDI specification,
generate a dedicated replacement without editing `/etc/cdi`:

```bash
mkdir -p "$HOME/.local/state/worldmonitor/qwen35/cdi"
nvidia-ctk cdi generate --mode=wsl \
  --output="$HOME/.local/state/worldmonitor/qwen35/cdi/nvidia.yaml"
export WM_CDI_SPEC_DIR="$HOME/.local/state/worldmonitor/qwen35/cdi"
```

Set this environment variable in the deployment's systemd override as well.
Point both application and seeder units at the dedicated deployment checkout.
Refresh the dedicated CDI specification after subsequent Windows driver changes.

## Acceptance and rollback

Run the focused local profile, report-handler, report-worker and Podman tests,
frontend/API typechecks, boundary checks, sidecar checks and required PR gates.
Live acceptance must separately verify both API routes, model identity,
quantization, GPU execution, memory use, report deadlines and rendered outputs.
Use frozen evidence for before/after comparisons; report measured outcomes.
Missing source credentials are a data gate, not permission to fabricate data.

Retain `qwen3:14b` in the model volume. To roll back, stop only the replacement
application/relay/Ollama containers, restore the saved service overrides and
image references, and start from the previous checkout and its unchanged env.
Restore only the model-related env settings when rollback is needed within the
new checkout, and disable `WM_LOCAL_LLM_PROFILE`. Rebuild the browser without
`VITE_LOCAL_LLM_PROFILE` if reverting that way. Preserve Redis and model volumes.
Neither deploying this branch locally nor passing acceptance merges either PR.

## September 11 acceptance results

The deployment used the pinned Q4_K_M weights on an RTX 5080. Ollama reported
100% GPU execution, 5.8 GB of loaded model memory, and 16,384-token context.
Simultaneous native `/api/chat` and compatible `/v1/chat/completions` requests
returned valid JSON in 6.8 and 6.9 seconds. Live application requests returned
Qwen3.5 provenance for a Ukraine brief (21.3 seconds), a situation analysis
(18.0 seconds), and an MSFT report (19.0 seconds).

A small frozen synthetic-evidence exercise passed all four Qwen3.5 checks:
country, situation, regional/weekly and finance. Each checked JSON, evidence IDs,
latest throughput and operating profit. Times ranged from 18.6 to 61.4 seconds;
the slowest exercised the bounded direct-answer recovery. This is a functional
smoke test, not a representative quality benchmark. The old-model comparison
included cold starts and different reasoning settings and cannot establish a
fair speed or quality ranking.

Validation passed frontend/API typechecks, 31,170 data tests (41 skipped), 454
sidecar tests, six controlled browser country-brief cases, and focused local
profile, cancellation, report-handler/worker and deployment tests.

The previously running Redis REST proxy also required replacement with the
version from the upstream-sync base, plus a fix to queue transactions with the
installed Redis 4 client API (`addCommand`). The HTTP regression also verifies
that a forbidden command prevents the entire transaction from executing.
Its old image is retained for rollback;
the Redis data container and named data/model volumes were preserved. Source
health still includes stale or empty datasets, and the live country request had
no linked news sources. These results do not certify source freshness or the
factual accuracy of generated prose. Review source coverage with each report.

For this workstation, the protected rollback snapshot and executable are at
`~/.local/state/worldmonitor/qwen35/rollback/`. To restore the prior deployment:

```bash
~/.local/state/worldmonitor/qwen35/rollback/rollback.sh
```

The script restores saved image IDs and service configuration, retains the
repaired CDI transport, and preserves Redis/model volumes. It has been syntax
checked; executing it is an explicit rollback operation. The previous model is
still installed. This host-specific snapshot contains configuration secrets;
do not commit or distribute it.
