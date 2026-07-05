#!/bin/bash

BACKUP_DIR="backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$BACKUP_DIR"

usage() {
    echo "Usage: $0 {backup|restore} [agent]"
    echo ""
    echo "Commands:"
    echo "  backup [agent]   - Backup all agents, or a specific one (e.g. backup vm-ramsey)"
    echo "  restore <agent>  - Restore an agent from its latest backup"
    exit 1
}

if [ "$#" -lt 1 ]; then
    usage
fi

command=$1
agent_arg=$2

do_backup() {
    target=$1

    if [ -n "$target" ]; then
        if [ -d "instances/$target" ]; then
            agents="instances/$target"
        else
            echo "❌ Agent '$target' not found in instances/."
            exit 1
        fi
    else
        agents=$(ls -d instances/vm-* 2>/dev/null)
    fi

    if [ -z "$agents" ]; then
        echo "❌ No agents found to backup."
        exit 1
    fi

    echo "🚀 Starting backup..."
    for agent_path in $agents; do
        agent_name=$(basename "$agent_path")
        echo "📦 Backing up: $agent_name..."

        if sudo docker exec "$agent_name" openclaw backup create --output "/tmp/${agent_name}_${TIMESTAMP}.tar.gz" > /dev/null 2>&1; then
            sudo docker cp "${agent_name}:/tmp/${agent_name}_${TIMESTAMP}.tar.gz" "$BACKUP_DIR/"
            sudo docker exec "$agent_name" rm "/tmp/${agent_name}_${TIMESTAMP}.tar.gz"
            echo "✅ Backed up $agent_name to $BACKUP_DIR/${agent_name}_${TIMESTAMP}.tar.gz"
        else
            echo "⚠️ Failed to backup $agent_name"
        fi
    done
    echo "✨ Done!"
}

case "$command" in
    backup)
        do_backup "$agent_arg"
        ;;
    restore)
        if [ -z "$agent_arg" ]; then
            echo "❌ Usage: $0 restore <agent-name>"
            echo "   Example: $0 restore vm-ramsey"
            exit 1
        fi
        latest=$(ls -t "$BACKUP_DIR/${agent_arg}_"*.tar.gz 2>/dev/null | head -1)
        if [ -z "$latest" ]; then
            echo "❌ No backup found for '$agent_arg' in $BACKUP_DIR/"
            exit 1
        fi
        echo "🛠️ Restoring $agent_arg from $latest..."
        sudo docker cp "$latest" "${agent_arg}:/tmp/restore.tar.gz"
        if sudo docker exec "$agent_arg" tar -xzf "/tmp/restore.tar.gz" -C /root/.openclaw; then
            echo "✅ Restored successfully!"
            sudo docker exec "$agent_arg" rm "/tmp/restore.tar.gz"
            sudo docker compose restart "$agent_arg"
            echo "✨ Finished!"
        else
            echo "❌ Restore failed."
            exit 1
        fi
        ;;
    *)
        usage
        ;;
esac