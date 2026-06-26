#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.override.yml"
INSTANCES_DIR="$SCRIPT_DIR/instances"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

OPENCLAW_IMAGE="vm-friends-vm-openclaw:latest"
PICOCLAW_IMAGE="vm-friends-vm-picoclaw:latest"
NANOBOT_IMAGE="vm-friends-vm-nanobot:latest"
HERMES_IMAGE="vm-friends-vm-hermes:latest"
DEFAULT_ALLOW_FROM="${DEFAULT_ALLOW_FROM:-532156945}"
DEFAULT_MODEL_BASE_URL="${DEFAULT_MODEL_BASE_URL:-http://10.69.1.131:11434/v1}"
DEFAULT_MODEL_NAME="${DEFAULT_MODEL_NAME:-gpt-oss:20b-73728}"
DEFAULT_CONTEXT_LENGTH="${DEFAULT_CONTEXT_LENGTH:-96000}"

image_for_agent() {
    local agent="$1"
    case "$agent" in
        picoclaw) echo "$PICOCLAW_IMAGE" ;;
        nanobot) echo "$NANOBOT_IMAGE" ;;
        hermes) echo "$HERMES_IMAGE" ;;
        *) echo "$OPENCLAW_IMAGE" ;;
    esac
}

build_context_for_agent() {
    local agent="$1"
    case "$agent" in
        picoclaw) echo "./vm_picoclaw" ;;
        nanobot) echo "./vm_nanobot" ;;
        hermes) echo "./vm_hermes" ;;
        *) echo "./vm_openclaw" ;;
    esac
}

container_data_dir_for_agent() {
    local agent="$1"
    case "$agent" in
        hermes) echo "/opt/data" ;;
        *) echo "/root/.$agent" ;;
    esac
}

usage() {
    cat <<EOF
Usage: $(basename "$0") <vm-name> [options]

Options:
  --fresh              Create empty workspace (default)
  --clone [vm-name]    Clone from existing VM or most recent instance
  --agent NAME         Assistant profile: openclaw, picoclaw, nanobot, or hermes (default: openclaw)
  --ssh                Enable SSH port (default: off)
  --password PASS      Root password (default: vm suffix)
  --port PORT          SSH port (implies --ssh, default: next free port)
  --default-config     Auto-apply Telegram + Ollama defaults after first start
  --bot-token TOKEN    Telegram bot token (used with --default-config)
  --allow-from ID      Telegram user id allowlist entry (default: ${DEFAULT_ALLOW_FROM})
  -h, --help           Show help

Examples:
  ./add-vm.sh vm-alice --fresh
  ./add-vm.sh vm-alice --ssh
  ./add-vm.sh vm-alice --agent picoclaw
  ./add-vm.sh vm-alice --agent nanobot
  ./add-vm.sh vm-alice --agent hermes
  ./add-vm.sh vm-alice --clone vm-ozden
EOF
}

error() { echo "Error: $1" >&2; exit 1; }

ensure_dirs() {
    mkdir -p "$INSTANCES_DIR"
}

existing_services() {
    {
        grep -E '^  [A-Za-z0-9_.-]+:$' "$COMPOSE_FILE" 2>/dev/null | sed 's/^  //; s/:$//'
        grep -E '^  [A-Za-z0-9_.-]+:$' "$OVERRIDE_FILE" 2>/dev/null | sed 's/^  //; s/:$//'
    } | sort -u
}

used_ports() {
    {
        grep -hoE '"[0-9]+:22"' "$COMPOSE_FILE" "$OVERRIDE_FILE" 2>/dev/null || true
    } | grep -oE '[0-9]+' | sort -n | uniq
}

next_port() {
    local port=43817
    while used_ports | grep -qx "$port"; do
        port=$((port + 1))
    done
    echo "$port"
}

latest_instance() {
    find "$INSTANCES_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -k1,1r | head -1 | xargs -r basename
}

parse_args() {
    if [[ $# -eq 0 ]]; then
        usage
        exit 1
    fi
    if [[ "$1" == "-h" || "$1" == "--help" ]]; then
        usage
        exit 0
    fi

    VM_NAME="$1"
    shift

  MODE="fresh"
  CLONE_SOURCE=""
  AGENT="openclaw"
  SSH_ENABLED=""
  PASSWORD=""
  PORT=""
  DEFAULT_CONFIG="false"
  BOT_TOKEN=""
  ALLOW_FROM="$DEFAULT_ALLOW_FROM"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --fresh) MODE="fresh"; shift ;;
            --clone)
                MODE="clone"
                if [[ $# -ge 2 && ! "$2" =~ ^-- ]]; then CLONE_SOURCE="$2"; shift 2; else shift; fi
                ;;
            --agent)
                AGENT="$2"
                shift 2
                ;;
            --ssh) SSH_ENABLED="yes"; shift ;;
            --password) PASSWORD="$2"; shift 2 ;;
            --port) SSH_ENABLED="yes"; PORT="$2"; shift 2 ;;
            --default-config) DEFAULT_CONFIG="true"; shift ;;
            --bot-token) BOT_TOKEN="$2"; shift 2 ;;
            --allow-from) ALLOW_FROM="$2"; shift 2 ;;
            -h|--help) usage; exit 0 ;;
            *) error "Unknown option: $1" ;;
        esac
    done

    [[ "$VM_NAME" == vm-* ]] || error "VM name must start with vm-"
    [[ "$AGENT" == "openclaw" || "$AGENT" == "picoclaw" || "$AGENT" == "nanobot" || "$AGENT" == "hermes" ]] || error "--agent must be one of: openclaw, picoclaw, nanobot, hermes"
    [[ -n "$PASSWORD" ]] || PASSWORD="${VM_NAME#vm-}"
    [[ "$ALLOW_FROM" =~ ^[0-9]+$ ]] || error "--allow-from must be a numeric Telegram user id"
}

service_exists() {
    existing_services | grep -qx "$1"
}

resolve_source() {
    if [[ -n "$CLONE_SOURCE" ]]; then
        echo "$CLONE_SOURCE"
    else
        latest_instance
    fi
}

write_override() {
    shopt -s nullglob
    cat > "$OVERRIDE_FILE" <<EOF
services:
$(for d in "$INSTANCES_DIR"/*; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    pfile="$d/meta.env"
    [[ -f "$pfile" ]] || continue
    . "$pfile"
    agent="$(grep -E '^AGENT=' "$pfile" 2>/dev/null | tail -n1 | cut -d'=' -f2-)"
    agent="${agent:-openclaw}"
    image="$(image_for_agent "$agent")"
    build_context="$(build_context_for_agent "$agent")"
    cat <<EOT
  $name:
    build:
      context: $build_context
    image: $image
    container_name: $name
    restart: unless-stopped
$(if [[ -n "${PORT:-}" ]]; then echo "    ports:
      - \"${PORT}:22\""; fi)
    volumes:
      - ./instances/$name/$agent:$(container_data_dir_for_agent "$agent")
    environment:
      TZ: Asia/Kolkata
      ROOT_PASSWORD: ${ROOT_PASSWORD}
EOT
done)
EOF
}

regenerate_override() {
    if compgen -G "$INSTANCES_DIR"'/*/meta.env' > /dev/null; then
        write_override
    else
        rm -f "$OVERRIDE_FILE"
    fi
}

config_file_path_for_agent() {
    local workspace_dir="$1"
    local agent="$2"
    case "$agent" in
        openclaw) echo "$workspace_dir/openclaw.json" ;;
        picoclaw) echo "$workspace_dir/config.json" ;;
        nanobot) echo "$workspace_dir/config.json" ;;
        hermes) echo "$workspace_dir/config.yaml" ;;
        *) return 1 ;;
    esac
}

bootstrap_config_generation() {
    local vm_name="$1"
    local agent="$2"
    local run_cmd=""

    case "$agent" in
        openclaw)
            run_cmd="openclaw onboard --non-interactive --accept-risk --mode local --flow manual --auth-choice skip --skip-channels --skip-skills --skip-search --skip-ui --skip-health --no-install-daemon >/tmp/openclaw_onboard.log 2>&1 || true"
            ;;
        picoclaw)
            run_cmd="picoclaw onboard >/tmp/picoclaw_onboard.log 2>&1 || true"
            ;;
        nanobot)
            run_cmd="nanobot onboard >/tmp/nanobot_onboard.log 2>&1 || true"
            ;;
        hermes)
            run_cmd="hermes setup >/tmp/hermes_onboard.log 2>&1 || true"
            ;;
    esac

    if command -v timeout >/dev/null 2>&1; then
        timeout 25 docker exec "$vm_name" sh -lc "$run_cmd" >/dev/null 2>&1 || true
    else
        docker exec "$vm_name" sh -lc "$run_cmd" >/dev/null 2>&1 || true
    fi
}

wait_for_file() {
    local file_path="$1"
    local timeout_seconds="$2"
    local i=0
    while [[ $i -lt $timeout_seconds ]]; do
        [[ -f "$file_path" ]] && return 0
        sleep 1
        i=$((i + 1))
    done
    return 1
}

apply_default_config_patch() {
    local config_path="$1"
    local agent="$2"
    local bot_token="$3"
    local allow_from="$4"
    local model_base_url="$5"
    local model_name="$6"
    local context_length="$7"

    python3 - "$config_path" "$agent" "$bot_token" "$allow_from" "$model_base_url" "$model_name" "$context_length" <<'PY'
import json
import os
import sys

config_path, agent, bot_token, allow_from, model_base_url, model_name, context_length = sys.argv[1:8]

def ensure_path(obj, path):
    cur = obj
    for key in path:
        nxt = cur.get(key)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[key] = nxt
        cur = nxt
    return cur

def set_path(obj, path, value):
    parent = ensure_path(obj, path[:-1])
    parent[path[-1]] = value

data = {}
if os.path.exists(config_path) and os.path.getsize(config_path) > 0:
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)

if not isinstance(data, dict):
    data = {}

# Shared patches
set_path(data, ["channels", "telegram", "enabled"], True)
set_path(data, ["channels", "telegram", "allowFrom"], [allow_from])

if agent == "openclaw":
    telegram = ensure_path(data, ["channels", "telegram"])
    telegram.pop("token", None)
    telegram.pop("allow_from", None)
    telegram["botToken"] = bot_token
    telegram["dmPolicy"] = "allowlist"

    agent_defaults = ensure_path(data, ["agents", "defaults"])
    model_cfg = agent_defaults.get("model")
    if not isinstance(model_cfg, dict):
        model_cfg = {}
    model_cfg["primary"] = f"ollama/{model_name}"
    agent_defaults["model"] = model_cfg
    agent_defaults.pop("contextLength", None)

    models = ensure_path(data, ["models"])
    providers = ensure_path(models, ["providers"])
    ollama = ensure_path(providers, ["ollama"])
    base = model_base_url
    if base.endswith("/v1"):
        base = base[:-3]
    ollama["baseUrl"] = base
    ollama["apiKey"] = "ollama"
    ollama["api"] = "ollama"
    ollama["models"] = [{
        "id": model_name,
        "name": model_name,
        "reasoning": False,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": int(context_length),
        "maxTokens": int(context_length) * 10,
    }]

    data.pop("providers", None)
elif agent == "picoclaw":
    set_path(data, ["channels", "telegram", "token"], bot_token)
    set_path(data, ["channels", "telegram", "allow_from"], [allow_from])

    model_list = data.get("model_list")
    if not isinstance(model_list, list):
        model_list = []
    model_list = [m for m in model_list if not (isinstance(m, dict) and m.get("model_name") == model_name)]
    model_list.append({
        "model_name": model_name,
        "model": f"ollama/{model_name}",
        "api_base": model_base_url,
    })
    data["model_list"] = model_list

    set_path(data, ["agents", "defaults", "model"], model_name)
    set_path(data, ["agents", "defaults", "model_name"], model_name)
    set_path(data, ["agents", "defaults", "provider"], "openai")
    set_path(data, ["agents", "defaults", "contextLength"], int(context_length))
    set_path(data, ["providers", "openai", "apiBase"], model_base_url)
    set_path(data, ["providers", "openai", "apiKey"], "ollama")
    set_path(data, ["model"], model_name)
    set_path(data, ["model_context_length"], int(context_length))
elif agent == "nanobot":
    set_path(data, ["channels", "telegram", "token"], bot_token)
    set_path(data, ["channels", "telegram", "allow_from"], [allow_from])

    set_path(data, ["agents", "defaults", "model"], model_name)
    set_path(data, ["agents", "defaults", "provider"], "openai")
    set_path(data, ["agents", "defaults", "contextLength"], int(context_length))
    set_path(data, ["providers", "openai", "apiBase"], model_base_url)
    set_path(data, ["providers", "openai", "apiKey"], "ollama")

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

main() {
    parse_args "$@"
    ensure_dirs
    [[ -f "$COMPOSE_FILE" ]] || error "docker-compose.yml not found"

    if [[ -f /.dockerenv ]] || grep -qE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null; then
        error "run add-vm.sh from the host, not inside a container"
    fi

    if service_exists "$VM_NAME"; then
        error "VM '$VM_NAME' already exists"
    fi

    if [[ -n "$SSH_ENABLED" ]]; then
        if [[ -z "$PORT" ]]; then PORT="$(next_port)"; fi
        if used_ports | grep -qx "$PORT"; then error "Port $PORT is already in use"; fi
    fi

    inst_dir="$INSTANCES_DIR/$VM_NAME"
    workspace_dir="$inst_dir/$AGENT"
    mkdir -p "$workspace_dir"

    if [[ "$MODE" == "clone" ]]; then
        source_vm="$(resolve_source)"
        [[ -n "$source_vm" ]] || error "No source VM available to clone"
        source_meta="$INSTANCES_DIR/$source_vm/meta.env"
        source_agent=""
        if [[ -f "$source_meta" ]]; then
            source_agent="$(grep -E '^AGENT=' "$source_meta" | tail -n1 | cut -d'=' -f2-)"
        fi
        source_agent="${source_agent:-openclaw}"

        if [[ -d "$INSTANCES_DIR/$source_vm/$source_agent" ]]; then
            cp -a "$INSTANCES_DIR/$source_vm/$source_agent/." "$workspace_dir/" 2>/dev/null || sudo cp -a "$INSTANCES_DIR/$source_vm/$source_agent/." "$workspace_dir/"
        elif [[ -d "$INSTANCES_DIR/$source_vm/openclaw" ]]; then
            cp -a "$INSTANCES_DIR/$source_vm/openclaw/." "$workspace_dir/" 2>/dev/null || sudo cp -a "$INSTANCES_DIR/$source_vm/openclaw/." "$workspace_dir/"
        elif [[ -d "$SCRIPT_DIR/${source_vm#vm-}_openclaw" ]]; then
            cp -a "$SCRIPT_DIR/${source_vm#vm-}_openclaw/." "$workspace_dir/" 2>/dev/null || sudo cp -a "$SCRIPT_DIR/${source_vm#vm-}_openclaw/." "$workspace_dir/"
        else
            error "Source workspace for '$source_vm' not found"
        fi

        if [[ -n "$(command -v sudo)" ]]; then
            sudo chown -R "$(id -u):$(id -g)" "$workspace_dir" 2>/dev/null || true
        fi
    fi

    cat > "$inst_dir/meta.env" <<EOF
ROOT_PASSWORD=$PASSWORD
AGENT=$AGENT
$(if [[ -n "$SSH_ENABLED" ]]; then echo "PORT=$PORT"; fi)
EOF

    regenerate_override

    docker compose up -d "$VM_NAME"

    if [[ "$DEFAULT_CONFIG" == "true" ]]; then
        if [[ "$AGENT" == "hermes" ]]; then
            echo "Warning: --default-config is not yet supported for hermes; skipping auto-patch"
            echo "Run: docker exec -it $VM_NAME hermes setup"
            echo "Or set up /opt/data/.env and /opt/data/config.yaml manually"
            if [[ -n "$SSH_ENABLED" ]]; then echo "Done: $VM_NAME on port $PORT"; else echo "Done: $VM_NAME"; fi
            exit 0
        fi

        if [[ -z "$BOT_TOKEN" ]]; then
            read -r -p "Telegram bot token: " BOT_TOKEN
        fi
        [[ -n "$BOT_TOKEN" ]] || error "--default-config requires a Telegram bot token"

        config_path="$(config_file_path_for_agent "$workspace_dir" "$AGENT")"
        bootstrap_config_generation "$VM_NAME" "$AGENT"

        if wait_for_file "$config_path" 60; then
            if [[ ! -w "$config_path" ]]; then
                if command -v sudo >/dev/null 2>&1; then
                    sudo chown "$(id -u):$(id -g)" "$config_path" 2>/dev/null || true
                fi
            fi
            if apply_default_config_patch "$config_path" "$AGENT" "$BOT_TOKEN" "$ALLOW_FROM" "$DEFAULT_MODEL_BASE_URL" "$DEFAULT_MODEL_NAME" "$DEFAULT_CONTEXT_LENGTH"; then
                chmod 600 "$config_path" 2>/dev/null || true
                docker restart "$VM_NAME" >/dev/null
                echo "Applied default config to $config_path"
            else
                echo "Warning: failed to patch config at $config_path"
                echo "Configure manually, then restart $VM_NAME"
            fi
        else
            echo "Warning: config file not generated in time at $config_path"
            echo "Container is running. Configure manually, then restart $VM_NAME"
        fi
    fi

    local done_msg="Done: $VM_NAME"
    if [[ -n "$SSH_ENABLED" ]]; then
        done_msg="$done_msg on port $PORT"
    fi
    echo "$done_msg"
}

main "$@"
