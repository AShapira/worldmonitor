#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BASE_COMPOSE="${PROJECT_DIR}/docker-compose.yml"
OLLAMA_COMPOSE="${PROJECT_DIR}/compose.ollama.yml"
ENV_FILE="${PROJECT_DIR}/.env"

find_podman_compose() {
  local candidate
  for candidate in \
    "${PODMAN_COMPOSE:-}" \
    /usr/local/bin/podman-compose \
    "${HOME}/.local/bin/podman-compose" \
    "$(command -v podman-compose 2>/dev/null || true)"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  printf 'ERROR: podman-compose was not found.\n' >&2
  return 1
}

compose() {
  local podman_compose
  local -a podman_args=()
  if [[ -n "${WM_CDI_SPEC_DIR:-}" ]]; then
    podman_args+=("--podman-args=--cdi-spec-dir=${WM_CDI_SPEC_DIR}")
  fi
  podman_compose="$(find_podman_compose)"
  "${podman_compose}" \
    --env-file "${ENV_FILE}" \
    -p "${WM_COMPOSE_PROJECT:-worldmonitor}" \
    "${podman_args[@]}" \
    -f "${BASE_COMPOSE}" \
    -f "${OLLAMA_COMPOSE}" \
    "$@"
}

compose_up() {
  if compose up -d "$@"; then
    return 0
  fi

  # RHEL under WSL can leave aardvark-dns unable to reach the direct user-bus
  # socket after a network recreation. Re-exec the same user manager through
  # systemd's machine transport, then retry once. Native RHEL normally never
  # enters this path.
  printf 'Podman start failed; refreshing the user systemd manager and retrying once.\n' >&2
  systemctl --user --machine="${USER}@.host" daemon-reexec
  systemctl --user --machine="${USER}@.host" daemon-reload
  compose up -d "$@"
}

has_env_key() {
  grep -qE "^${1}=" "${ENV_FILE}" 2>/dev/null
}

append_env() {
  local key="$1"
  local value="$2"
  if ! has_env_key "${key}"; then
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

init_env() {
  command -v openssl >/dev/null || {
    printf 'ERROR: openssl is required to generate local secrets.\n' >&2
    return 1
  }

  umask 077
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  append_env RELAY_SHARED_SECRET "$(openssl rand -hex 32)"
  append_env REDIS_PASSWORD "$(openssl rand -hex 32)"
  append_env REDIS_TOKEN "$(openssl rand -hex 32)"
  append_env WM_SESSION_SECRET "$(openssl rand -hex 32)"
  append_env WORLDMONITOR_API_KEY "wm_local_$(openssl rand -hex 32)"
  append_env WORLDMONITOR_VALID_KEYS "$(env_value WORLDMONITOR_API_KEY)"
  # Host-run warmers use this dedicated name when authenticating back to the
  # local gateway. Reuse the local operator key; it is already allowlisted and
  # remains confined to the ignored mode-0600 environment file.
  append_env WORLDMONITOR_RELAY_KEY "$(env_value WORLDMONITOR_API_KEY)"
  append_env API_BASE_URL "http://127.0.0.1:3000"
  append_env WM_PORT "127.0.0.1:3000"
  append_env VITE_VARIANT full
  append_env VITE_MAP_INTERACTION_MODE 3d
  append_env VITE_PMTILES_URL ""
  append_env OLLAMA_API_URL "http://127.0.0.1:11434"
  append_env OLLAMA_MODEL "qwen3.5:9b"
  append_env WM_LOCAL_LLM_PROFILE balanced
  append_env LLM_TOOL_PROVIDER ollama
  append_env LLM_TOOL_MODEL "qwen3.5:9b"
  append_env LLM_REASONING_PROVIDER ollama
  append_env LLM_REASONING_MODEL "qwen3.5:9b"
  append_env LLM_API_URL "http://127.0.0.1:11434/v1/chat/completions"
  append_env LLM_API_KEY ollama
  append_env LLM_MODEL "qwen3.5:9b"
  append_env LLM_REASONING_EFFORT none
  append_env YAHOO_USER_AGENT worldmonitor-local/1.0
  append_env GROQ_API_KEY ""
  append_env OPENROUTER_API_KEY ""
  append_env WM_LOCAL_LLM_MODEL_DIGEST "$(jq -r .modelDigest "${PROJECT_DIR}/deploy/local-llm-lock.json")"
  append_env OLLAMA_CONTEXT_LENGTH 16384
  append_env OLLAMA_NUM_PARALLEL 2
  append_env OLLAMA_MAX_LOADED_MODELS 1
  append_env OLLAMA_KEEP_ALIVE 24h
  append_env OLLAMA_FLASH_ATTENTION 1
  append_env OLLAMA_KV_CACHE_TYPE q8_0
  append_env SEED_TIMEOUT 1800

  printf 'Local environment initialized at %s (mode 0600).\n' "${ENV_FILE}"
}

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "${ENV_FILE}" | tail -n 1
}

migrate_model_env() {
  [[ -f "${ENV_FILE}" ]] || init_env
  local backup
  backup="$(mktemp "${ENV_FILE}.backup-qwen35.$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")"
  (umask 077; cp -p "${ENV_FILE}" "${backup}")
  local key value
  while IFS='=' read -r key value; do
    if has_env_key "${key}"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
    else
      append_env "${key}" "${value}"
    fi
  done <<'MODEL_SETTINGS'
OLLAMA_MODEL=qwen3.5:9b
LLM_MODEL=qwen3.5:9b
WM_LOCAL_LLM_PROFILE=balanced
LLM_TOOL_PROVIDER=ollama
LLM_TOOL_MODEL=qwen3.5:9b
LLM_REASONING_PROVIDER=ollama
LLM_REASONING_MODEL=qwen3.5:9b
LLM_REASONING_EFFORT=none
OLLAMA_CONTEXT_LENGTH=16384
OLLAMA_NUM_PARALLEL=2
OLLAMA_MAX_LOADED_MODELS=1
MODEL_SETTINGS
  local digest
  digest="$(jq -r .modelDigest "${PROJECT_DIR}/deploy/local-llm-lock.json")"
  if has_env_key WM_LOCAL_LLM_MODEL_DIGEST; then
    sed -i "s|^WM_LOCAL_LLM_MODEL_DIGEST=.*|WM_LOCAL_LLM_MODEL_DIGEST=${digest}|" "${ENV_FILE}"
  else
    append_env WM_LOCAL_LLM_MODEL_DIGEST "${digest}"
  fi
  chmod 600 "${ENV_FILE}" "${backup}"
  printf 'Updated local model settings; backup: %s\n' "${backup}"
}

model_name() {
  local model
  model="$(env_value OLLAMA_MODEL)"
  printf '%s\n' "${model:-qwen3.5:9b}"
}

worldmonitor_api_key() {
  local api_key
  api_key="$(env_value WORLDMONITOR_API_KEY)"
  if [[ -z "${api_key}" ]]; then
    printf 'ERROR: WORLDMONITOR_API_KEY is missing; run scripts/podman-local.sh init.\n' >&2
    return 1
  fi
  printf '%s\n' "${api_key}"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-60}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  printf 'ERROR: timed out waiting for %s\n' "${url}" >&2
  return 1
}

verify_model_digest() {
  local model expected
  model="$(model_name)"
  [[ "${model}" == qwen3.5:9b ]] || return 0
  expected="$(jq -r '.modelDigest' "${PROJECT_DIR}/deploy/local-llm-lock.json")"
  curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags \
    | jq -e --arg model "${model}" --arg digest "${expected}" \
      '.models | any(.name == $model and .digest == $digest and .details.quantization_level == "Q4_K_M")' >/dev/null
}

pull_model() {
  wait_for_url http://127.0.0.1:11434/api/tags 90
  podman exec worldmonitor-ollama ollama pull "$(model_name)"
  verify_model_digest
}

preload_model() {
  local model
  model="$(model_name)"
  curl -fsS --max-time 120 \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg model "${model}" '{model:$model,messages:[{role:"user",content:"Reply with OK"}],stream:false,keep_alive:"24h",think:false}')" \
    http://127.0.0.1:11434/api/chat >/dev/null
  printf 'Preloaded %s.\n' "${model}"
}

verify_stack() {
  local model
  local api_key
  model="$(model_name)"
  api_key="$(worldmonitor_api_key)"

  wait_for_url http://127.0.0.1:11434/api/tags 30
  wait_for_url http://127.0.0.1:3000/api/sidecar-health 60
  verify_model_digest

  curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags \
    | jq -e --arg model "${model}" '.models | any(.name == $model or .model == $model)' >/dev/null

  curl -fsS --max-time 30 \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer ollama' \
    -d "$(jq -nc --arg model "${model}" '{model:$model,messages:[{role:"system",content:"Return only strict JSON."},{role:"user",content:"Return {\"status\":\"ok\"}."}],temperature:0,max_tokens:32,reasoning_effort:"none",stream:false}')" \
    http://127.0.0.1:11434/v1/chat/completions \
    | jq -e '.choices[0].message.content | fromjson | .status == "ok"' >/dev/null

  curl -fsS --max-time 10 http://127.0.0.1:3000/api/llm-health \
    | jq -e '.providers | any(.name == "ollama" and .available == true)' >/dev/null

  curl -fsS --max-time 10 \
    -H "X-WorldMonitor-Key: ${api_key}" \
    http://127.0.0.1:3000/api/health \
    | jq -e '.status | type == "string"' >/dev/null

  podman exec worldmonitor-ollama nvidia-smi \
    --query-gpu=name,memory.total --format=csv,noheader
  podman exec worldmonitor-ollama ollama ps

  if ss -ltn | grep -Eq '(^|[[:space:]])0\.0\.0\.0:(11434|8079)([[:space:]]|$)|(^|[[:space:]])\[::\]:(11434|8079)([[:space:]]|$)'; then
    printf 'ERROR: Ollama or Redis REST is exposed on a wildcard host address.\n' >&2
    return 1
  fi

  printf 'World Monitor and local Ollama verification passed.\n'
}

install_systemd() {
  local unit_dir="${HOME}/.config/systemd/user"
  install -d -m 700 "${unit_dir}"
  install -m 644 "${PROJECT_DIR}/deploy/systemd/worldmonitor-podman.service" "${unit_dir}/"
  install -m 644 "${PROJECT_DIR}/deploy/systemd/worldmonitor-seeders.service" "${unit_dir}/"
  install -m 644 "${PROJECT_DIR}/deploy/systemd/worldmonitor-seeders.timer" "${unit_dir}/"
  if ! systemctl --user daemon-reload; then
    # RHEL under WSL can leave the direct user-bus transport unavailable even
    # while the user manager is healthy. The machine transport reaches the
    # same manager and is also valid on native systemd hosts.
    systemctl --user --machine="${USER}@.host" daemon-reload
  fi
  if ! systemctl --user enable worldmonitor-podman.service worldmonitor-seeders.timer; then
    systemctl --user --machine="${USER}@.host" enable worldmonitor-podman.service worldmonitor-seeders.timer
  fi
  printf 'Installed and enabled user units. Start with:\n'
  printf '  systemctl --user start worldmonitor-podman.service\n'
  printf '  systemctl --user start worldmonitor-seeders.timer\n'
}

usage() {
  cat <<'EOF'
Usage: scripts/podman-local.sh COMMAND

Commands:
  init             Generate missing ignored .env settings and secrets
  migrate-model    Back up .env and select Qwen3.5 9B balanced local inference
  config           Validate the merged Compose configuration
  build            Build the World Monitor and relay images
  up               Start the stack without rebuilding
  deploy           Initialize, build, start, pull/preload the model, and verify
  down             Stop and remove containers, preserving named volumes
  restart          Restart the stack
  status           Show Compose and Ollama model status
  logs [SERVICE]   Follow logs for the stack or one service
  pull-model       Pull the configured Ollama model
  preload          Load the configured model into VRAM
  seed             Run host-side seeders against the local Redis REST proxy
  verify           Validate endpoints, strict JSON, GPU use, and port bindings
  install-systemd  Install and enable user service/timer units
EOF
}

command_name="${1:-}"
shift || true

case "${command_name}" in
  init)
    init_env
    ;;
  migrate-model)
    migrate_model_env
    ;;
  config)
    init_env
    compose config >/dev/null
    printf 'Merged Compose configuration is valid.\n'
    ;;
  build)
    init_env
    compose build
    ;;
  up)
    init_env
    compose_up "$@"
    ;;
  deploy)
    init_env
    compose config >/dev/null
    compose build
    compose_up
    pull_model
    preload_model
    verify_stack
    ;;
  down)
    compose down
    ;;
  restart)
    # podman-compose restarts services in dependency-hostile order and can try
    # to start the relay while Redis/Ollama are still stopped. A down/up cycle
    # preserves named volumes and recreates the dependency graph cleanly.
    init_env
    compose config >/dev/null
    compose down
    compose_up "$@"
    ;;
  status)
    compose ps
    podman exec worldmonitor-ollama ollama ps 2>/dev/null || true
    ;;
  logs)
    compose logs -f "$@"
    ;;
  pull-model)
    pull_model
    ;;
  preload)
    preload_model
    ;;
  seed)
    cd "${PROJECT_DIR}"
    flock -n "${XDG_RUNTIME_DIR:-/tmp}/worldmonitor-seeders-${UID}.lock" ./scripts/run-seeders.sh
    ;;
  verify)
    verify_stack
    ;;
  install-systemd)
    install_systemd
    ;;
  *)
    usage
    [[ -n "${command_name}" ]] && exit 2
    ;;
esac
