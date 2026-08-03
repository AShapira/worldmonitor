# RHEL Podman with Local Ollama

This profile runs World Monitor, Redis, the AIS relay, and Ollama with rootless
Podman. The dashboard, Redis REST proxy, and Ollama are bound to loopback. Do
not expose them to a LAN without a TLS reverse proxy and authentication.

## Requirements

- Podman with a working rootless user session
- `podman-compose`, Node.js 22+, OpenSSL, curl, and jq
- NVIDIA Container Toolkit CDI device `nvidia.com/gpu=all`
- An NVIDIA driver supported by Ollama

Verify CDI before deployment:

```bash
nvidia-ctk cdi list
podman run --rm --device nvidia.com/gpu=all \
  docker.io/nvidia/cuda:13.0.1-base-ubi9 nvidia-smi
```

## Deploy

The launcher keeps host-side LLM URLs in the ignored `.env` file while
`compose.ollama.yml` gives containers the internal `http://ollama:11434`
address. Do not put LLM URLs in `docker-compose.override.yml`; the host seeder
wrapper parses that file and container-only DNS names would break host runs.

```bash
./scripts/podman-local.sh deploy
./scripts/podman-local.sh install-systemd
systemctl --user start worldmonitor-podman.service
systemctl --user start worldmonitor-seeders.timer
```

The full host-side seeder fleet runs once on startup and then every 24 hours.
Some backfills make hundreds of paced public API requests, while the AIS relay
container maintains its own faster loops for time-sensitive feeds; scheduling
the full fleet every 30 minutes would keep a keyless local deployment almost
continuously busy. The first full backfill can take well over 30 minutes and is
bounded by a two-hour systemd timeout; individual standalone seeds retain their
own `SEED_TIMEOUT` cap.

The default model is `qwen3:14b`, with an 8K context, two parallel requests,
Flash Attention, q8 K/V cache, one loaded model, and a 24-hour keep-alive. Edit
the ignored `.env` before deployment to change these values.

The launcher also generates a local operator API key in `.env` and allowlists
it inside the application. This enables authenticated and premium API handlers
without a cloud account. Nginx injects it into same-origin API requests while a
public build flag unlocks local panels; the key itself is never embedded in the
browser bundle. API clients may also send it as `X-WorldMonitor-Key`.

The same ignored key is exposed to host-side warmers as
`WORLDMONITOR_RELAY_KEY`, with `API_BASE_URL=http://127.0.0.1:3000`. Scheduled
seeders can therefore warm protected local caches without contacting the public
World Monitor API.

Both the native and generic World Monitor LLM routes point at Ollama.
`LLM_REASONING_EFFORT=none` prevents Qwen 3 from spending short handler output
budgets on hidden reasoning through the OpenAI-compatible route.
`YAHOO_USER_AGENT` is an explicit service identifier because Yahoo currently
rate-limits upstream's shared Chrome impersonation string on stock requests.

Open <http://127.0.0.1:3000> after verification succeeds.

On RHEL running under WSL, a recreated Podman network can occasionally expose
a stale user-bus socket to `aardvark-dns`. The launcher detects a failed start,
re-execs the existing user manager through systemd's machine transport, and
retries once. Native RHEL normally does not use this recovery path.

## Operations

```bash
./scripts/podman-local.sh status
./scripts/podman-local.sh verify
./scripts/podman-local.sh logs worldmonitor
./scripts/podman-local.sh seed
./scripts/podman-local.sh restart
./scripts/podman-local.sh down
```

Normal `down` operations preserve the Redis and Ollama named volumes. Do not
use `podman-compose down -v` unless deleting all cached intelligence data and
downloaded models is intentional.

To guarantee user services start before an interactive login, enable linger
once as an administrator:

```bash
sudo loginctl enable-linger "$USER"
```

## Privacy Boundary

The tracked overlay clears Groq and OpenRouter keys, configures both World
Monitor LLM interfaces against local Ollama, and sets `OLLAMA_NO_CLOUD=1`.
External OSINT data sources still require Internet access. Their credentials,
when used, belong only in `.env` or the ignored `docker-compose.override.yml`.

## Network Use and License

This repository is AGPL-3.0. If the modified service is made available to
network users, provide those users the Corresponding Source for the running
version, including these deployment and integration changes. Review the
license itself for the complete obligations before LAN or public exposure.
