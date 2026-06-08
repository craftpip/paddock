#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCES_DIR="$SCRIPT_DIR/instances"
COMPOSE_OVERRIDE="$SCRIPT_DIR/docker-compose.override.yml"
OPENCLAW_IMAGE="vm-friends-vm-openclaw:latest"
PICOCLAW_IMAGE="vm-friends-vm-picoclaw:latest"
NANOBOT_IMAGE="vm-friends-vm-nanobot:latest"
HERMES_IMAGE="vm-friends-vm-hermes:latest"

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
    echo "Usage: $(basename "$0") <vm-name>"
    exit 1
}

[[ $# -eq 1 ]] || usage
VM_NAME="$1"
[[ "$VM_NAME" == vm-* ]] || { echo "Error: VM name must start with vm-" >&2; exit 1; }

META_FILE="$INSTANCES_DIR/$VM_NAME/meta.env"
[[ -f "$META_FILE" ]] || { echo "Error: VM '$VM_NAME' does not exist" >&2; exit 1; }
. "$META_FILE"
AGENT="${AGENT:-openclaw}"

if [[ -f /.dockerenv ]] || grep -qE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null; then
    echo "Error: run reset-vm.sh from the host, not inside a container" >&2
    exit 1
fi

docker rm -f "$VM_NAME" 2>/dev/null || true
rm -rf "$INSTANCES_DIR/$VM_NAME/$AGENT"
mkdir -p "$INSTANCES_DIR/$VM_NAME/$AGENT"

if compgen -G "$INSTANCES_DIR"'/*/meta.env' > /dev/null; then
    : > "$COMPOSE_OVERRIDE"
    echo "services:" > "$COMPOSE_OVERRIDE"
    for meta in "$INSTANCES_DIR"/*/meta.env; do
        [[ -f "$meta" ]] || continue
        . "$meta"
        name="$(basename "$(dirname "$meta")")"
        agent="$(grep -E '^AGENT=' "$meta" 2>/dev/null | tail -n1 | cut -d'=' -f2-)"
        agent="${agent:-openclaw}"
        image="$(image_for_agent "$agent")"
        build_context="$(build_context_for_agent "$agent")"
        cat >> "$COMPOSE_OVERRIDE" <<EOF
  $name:
    build:
      context: $build_context
    image: $image
    container_name: $name
    restart: unless-stopped
    ports:
      - "${PORT}:22"
    volumes:
      - ./instances/$name/$agent:$(container_data_dir_for_agent "$agent")
    environment:
      TZ: Asia/Kolkata
      ROOT_PASSWORD: ${ROOT_PASSWORD}
EOF
    done
else
    rm -f "$COMPOSE_OVERRIDE"
fi

docker compose up -d "$VM_NAME"
echo "Reset $VM_NAME"
