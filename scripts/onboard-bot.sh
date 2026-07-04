#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCES_DIR="$SCRIPT_DIR/../instances"
SCRIPT_NAME="$(basename "$0")"

error() { echo "Error: $1" >&2; exit 1; }
info()  { echo ":: $1"; }
ok()    { echo ":: $1"; }

usage() {
    cat <<EOF
Usage: $SCRIPT_NAME <vm-name> [options]

Onboard a bot: run onboard, configure Telegram, set up OpenAI auth,
and/or configure API key providers (OpenRouter, Ollama Cloud, etc.).

Options:
  --bot-token <token>     Telegram bot token
  --bot <name>            Look up bot token from telegram-users.json (by name)
  --add-bot <name>=<tok>  Save a new bot token to telegram-users.json
  --allow-from <id>       Telegram user ID for allowlist
  --user <name>           Look up user ID from telegram-users.json (by name)
  --add-user <name>=<id>  Save a new user ID to telegram-users.json
  --agent <name>          Agent type (default: openclaw)
  --continue              Finalize after auth (device-code mode)
  --redirect-url <url>    Complete OAuth with redirect URL
  --reset                 Reset and start fresh
  --setup-api-key         Interactive: pick provider + paste API key
  --api-key <prov>=<key>  Direct: set API key for a provider (repeatable)
  --help                  Show this help

Examples:
  $SCRIPT_NAME vm-devel --bot wilmaa_bot --user boniface
  $SCRIPT_NAME vm-devel --redirect-url 'http://localhost:...'
  $SCRIPT_NAME vm-devel --continue
  $SCRIPT_NAME vm-devel --reset --bot wilmaa_bot --user boniface
  $SCRIPT_NAME vm-devel --setup-api-key
  $SCRIPT_NAME vm-devel --api-key openrouter=sk-or-v1-xxx --api-key ollama-cloud=oll-xxx
EOF
    exit 0
}

VM_NAME=""
BOT_TOKEN=""
ALLOW_FROM=""
AGENT="openclaw"
CONTINUE="false"
RESET="false"
REDIRECT_URL=""
SETUP_API_KEY="false"
declare -a API_KEYS=()

parse_args() {
    [[ $# -eq 0 ]] && usage
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help|-h) usage ;;
            --bot-token) BOT_TOKEN="$2"; shift 2 ;;
            --bot) lookup_bot_token "$2"; shift 2 ;;
            --add-bot) add_bot_token "$2"; shift 2 ;;
            --allow-from) ALLOW_FROM="$2"; shift 2 ;;
            --user) lookup_user_id "$2"; shift 2 ;;
            --add-user) add_telegram_user "$2"; shift 2 ;;
            --user) lookup_user_id "$2"; shift 2 ;;
            --agent) AGENT="$2"; shift 2 ;;
            --continue) CONTINUE="true"; shift ;;
            --redirect-url) REDIRECT_URL="$2"; shift 2 ;;
            --reset) RESET="true"; shift ;;
            --setup-api-key) SETUP_API_KEY="true"; shift ;;
            --api-key) [[ "$2" == *=* ]] || error "--api-key format: <provider>=<key>"; API_KEYS+=("$2"); shift 2 ;;
            -*) error "Unknown option: $1" ;;
            *) [[ -z "$VM_NAME" ]] && VM_NAME="$1" || error "Unexpected argument: $1"; shift ;;
        esac
    done
    [[ -n "$VM_NAME" ]] || error "VM name is required"
    [[ "$VM_NAME" == vm-* ]] || error "VM name must start with vm-"
}

check_vm() {
    local status
    status="$(docker inspect --format='{{.State.Status}}' "$VM_NAME" 2>/dev/null || true)"
    [[ -n "$status" ]] || error "Container $VM_NAME not found. Create it: sudo ./add-vm.sh $VM_NAME"
    [[ "$status" == "running" ]] || error "Container $VM_NAME is $status, not running. Start it first"
}

lookup_bot_token() {
    local name="$1"
    local users_file="$SCRIPT_DIR/../bot-prefixes.json"
    [[ -f "$users_file" ]] || error "bot-prefixes.json not found at $users_file"
    local token
    token="$(python3 -c "import json; print(json.load(open('$users_file'))['bots'].get('$name', ''))" 2>/dev/null || true)"
    [[ -n "$token" ]] || error "Unknown bot: $name (not found in bot-prefixes.json bots)"
    BOT_TOKEN="$token"
    info "Looked up bot $name"
}

lookup_user_id() {
    local name="$1"
    local users_file="$SCRIPT_DIR/../bot-prefixes.json"
    [[ -f "$users_file" ]] || error "bot-prefixes.json not found at $users_file"
    local id
    id="$(python3 -c "import json; print(json.load(open('$users_file'))['users'].get('$name', ''))" 2>/dev/null || true)"
    [[ -n "$id" ]] || error "Unknown user: $name (not found in bot-prefixes.json users)"
    ALLOW_FROM="$id"
    info "Looked up $name -> $id"
}

add_bot_token() {
    local arg="$1" name token
    name="${arg%%=*}"
    token="${arg#*=}"
    [[ "$arg" == *=* && -n "$name" && -n "$token" ]] || error "Format: --add-bot <name>=<token>"
    local users_file="$SCRIPT_DIR/../bot-prefixes.json"
    [[ -f "$users_file" ]] || error "bot-prefixes.json not found"
    python3 -c "
import json
path = '$users_file'
with open(path) as f:
    d = json.load(f)
d.setdefault('bots', {})['$name'] = '$token'
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
" || error "Failed to save bot token"
    info "Saved bot $name to bot-prefixes.json"
    BOT_TOKEN="$token"
}

add_telegram_user() {
    local arg="$1" name uid
    name="${arg%%=*}"
    uid="${arg#*=}"
    [[ "$arg" == *=* && -n "$name" && -n "$uid" ]] || error "Format: --add-user <name>=<id>"
    local users_file="$SCRIPT_DIR/../bot-prefixes.json"
    [[ -f "$users_file" ]] || error "bot-prefixes.json not found"
    python3 -c "
import json
path = '$users_file'
with open(path) as f:
    d = json.load(f)
d.setdefault('users', {})['$name'] = '$uid'
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
" || error "Failed to save user ID"
    info "Saved user $name -> $uid to telegram-users.json"
    ALLOW_FROM="$uid"
}

config_path() {
    echo "$INSTANCES_DIR/$VM_NAME/$AGENT/openclaw.json"
}

container_exec() {
    docker exec -i "$VM_NAME" sh -lc "$*"
}

run_onboard() {
    local cfg="$(config_path)"

    if [[ "$RESET" == "true" ]]; then
        info "Resetting bot state..."
        local old_pid_file="/tmp/onboard-auth-$VM_NAME.pid"
        [[ -f "$old_pid_file" ]] && kill "$(cat "$old_pid_file")" 2>/dev/null || true
        rm -f "$old_pid_file" "/tmp/onboard-auth-$VM_NAME.log"
        rm -f "/tmp/onboard-oauth-$VM_NAME.pid" "/tmp/onboard-oauth-$VM_NAME.fifo" "/tmp/onboard-oauth-$VM_NAME.url"
        sudo rm -f "$INSTANCES_DIR/$VM_NAME/$AGENT/openclaw.json.last-good" 2>/dev/null || true
        sudo rm -f "$cfg" 2>/dev/null || true
    fi

    local has_model has_channels
    has_model="$(container_exec "openclaw config get agents.defaults.model.primary" 2>/dev/null || true)"
    has_channels="$(container_exec "openclaw config get channels.telegram.enabled" 2>/dev/null || true)"
    if [[ -n "$has_model" ]] || [[ "$has_channels" == "true" ]]; then
        info "Config already has model or Telegram — onboard already done"
        return 0
    fi

    if container_exec "test -f /root/.$AGENT/openclaw.json" 2>/dev/null; then
        info "Skeleton config exists — skipping onboard"
        return 0
    fi

    info "Running openclaw onboard to generate skeleton config..."
    container_exec "openclaw onboard --non-interactive --accept-risk --mode local --flow manual --auth-choice skip --skip-channels --skip-skills --skip-search --skip-ui --skip-health --no-install-daemon >/dev/null 2>&1" || true

    local i=0
    while [[ $i -lt 30 ]]; do
        if container_exec "test -f /root/.$AGENT/openclaw.json" 2>/dev/null; then
            sudo chown "$(id -u):$(id -g)" "$cfg" 2>/dev/null || true
            ok "Config created"
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    error "Config file was not created within 30s. Check: docker exec $VM_NAME openclaw doctor"
}

setup_telegram() {
    local tg_enabled
    tg_enabled="$(container_exec "openclaw config get channels.telegram.enabled" 2>/dev/null || true)"
    if [[ "$tg_enabled" == "true" ]]; then
        info "Telegram already configured — skipping"
        return 0
    fi
    [[ -n "$BOT_TOKEN" ]] || error "--bot-token is required for Telegram setup"
    [[ "$BOT_TOKEN" == *:* ]] || error "Telegram bot token should look like '123456:ABCdef'"

    info "Adding Telegram channel..."
    local add_out
    add_out="$(container_exec "openclaw channels add --channel telegram --token '$BOT_TOKEN'" 2>&1)" || true
    echo "$add_out" | grep -qi "added" || info "Note: $add_out"

    info "Setting Telegram allowlist..."
    container_exec "openclaw config set 'channels.telegram.allowFrom' '[\"$ALLOW_FROM\"]' --strict-json --merge" >/dev/null
    container_exec "openclaw config set channels.telegram.dmPolicy allowlist" >/dev/null
    ok "Telegram configured"
}

# ---------------------------------------------------------------------------
# OAuth flow — uses a Python pty helper kept alive in the background
# ---------------------------------------------------------------------------
ensure_oauth_helper() {
    local helper_path="/tmp/oauth-helper-$VM_NAME.py"
    # Write helper inside the container (where openclaw binary lives)
    docker exec -i "$VM_NAME" sh -c "cat > '$helper_path'" << 'PYEOF'
import pty, os, sys, time, select, re

fifo_path = sys.argv[1]
url_path  = sys.argv[2]

pid, fd = pty.fork()
if pid == 0:
    os.execvp("openclaw", ["openclaw", "models", "auth", "login", "--provider", "openai"])
else:
    output = b""
    oauth_url = None
    sent = False
    done = False

    def ansi_free():
        text = output.decode("utf-8", errors="replace")
        text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text)
        text = re.sub(r'\x1b\].*?(?:\x1b\\|\x07)', '', text, flags=re.S)
        return text

    def flat_bytes():
        return output.replace(b'\r\n', b'').replace(b'\r', b'').lower()

    try:
        while True:
            r, w, e = select.select([fd], [], [], 0.5)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                output += data
                text = ansi_free()

                # Extract OAuth URL (first time we see it)
                if oauth_url is None:
                    m = re.search(r'https://auth\.openai\.com/[^\s\r\n]+', text)
                    if m:
                        oauth_url = m.group(0)
                        with open(url_path, "w") as f:
                            f.write(oauth_url + "\n")

                # Wait for paste prompt using raw bytes (no ANSI issues)
                flat = flat_bytes()
                if oauth_url and not sent and (b'authorization code' in flat or b'full redirect url' in flat):
                    sent = True
                    # Open fifo (blocks until writer connects)
                    with open(fifo_path, "r") as fifo:
                        line = fifo.readline().strip()
                    if line:
                        os.write(fd, (line + "\n").encode())
                        done = True
            elif oauth_url and not sent:
                time.sleep(0.1)

            if done:
                child_alive = True
                while child_alive:
                    r2, w2, e2 = select.select([fd], [], [], 0.5)
                    if r2:
                        try:
                            d2 = os.read(fd, 65536)
                            if d2:
                                output += d2
                            else:
                                break
                        except OSError:
                            break
                    wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                    if wpid == pid:
                        child_alive = False
                break
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass

    raw_text = output.decode("utf-8", errors="replace")
    result_text = ansi_free()
    with open(url_path + ".result", "w") as f:
        f.write(result_text)
    with open(url_path + ".repr", "w") as f:
        f.write(repr(raw_text))
PYEOF
}

setup_auth_oauth() {
    local auth_json profile_count
    auth_json="$(container_exec "openclaw models auth list --provider openai --json" 2>/dev/null || echo '{"profiles":[]}')"
    profile_count="$(echo "$auth_json" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('profiles', [])))" 2>/dev/null || echo "0")"
    if [[ "$profile_count" -gt 0 ]]; then
        ok "OpenAI auth already configured ($profile_count profile(s))"
        return 0
    fi

    local helper_path="/tmp/oauth-helper-$VM_NAME.py"
    local c_fifo="/tmp/onboard-oauth-$VM_NAME.fifo"
    local c_url="/tmp/onboard-oauth-$VM_NAME.url"
    local c_log="/tmp/onboard-oauth-$VM_NAME.log"
    local c_pid_file="/tmp/onboard-oauth-$VM_NAME.pid"
    local h_pid_file="/tmp/onboard-oauth-$VM_NAME.host-pid"

    # Cleanup stale state inside container
    container_exec "rm -f '$c_fifo' '$c_url' '$c_url.result' '$c_pid_file' '$c_log'" 2>/dev/null || true
    [[ -f "$h_pid_file" ]] && kill "$(cat "$h_pid_file")" 2>/dev/null || true
    rm -f "$h_pid_file"

    ensure_oauth_helper

    # Create fifo inside container
    container_exec "mkfifo '$c_fifo'" || { info "Fifo creation failed — falling back to device-code..."; setup_auth_devicecode; return $?; }

    # Run the Python helper inside the container in background
    container_exec "nohup python3 '$helper_path' '$c_fifo' '$c_url' > '$c_log' 2>&1 & echo \$! > '$c_pid_file'"

    # Read PID from inside container
    local helper_pid
    helper_pid="$(container_exec "cat '$c_pid_file'" 2>/dev/null || true)"

    # Wait up to 25s for OAuth URL to appear
    local i=0
    while [[ $i -lt 25 ]]; do
        local url_content
        url_content="$(container_exec "cat '$c_url'" 2>/dev/null || true)"
        if [[ -n "$url_content" ]]; then
            break
        fi
        sleep 1
        i=$((i + 1))
    done

    local url_content
    url_content="$(container_exec "cat '$c_url'" 2>/dev/null || true)"
    if [[ -z "$url_content" ]]; then
        # Fallback: try device-code if OAuth is stuck
        container_exec "kill \$(cat '$c_pid_file') 2>/dev/null || true; rm -f '$c_fifo'" || true
        info "OAuth URL not detected — falling back to device-code..."
        setup_auth_devicecode
        return $?
    fi

    # Store host-side PID so --redirect-url can find the session
    echo "$helper_pid" > "$h_pid_file"

    echo ""
    echo "=============================================="
    echo "  OpenAI OAuth Authentication Required"
    echo "=============================================="
    echo ""
    echo "  Open this URL in your browser, sign in,"
    echo "  then copy the redirect URL and run:"
    echo ""
    echo "    $SCRIPT_NAME $VM_NAME --redirect-url '<paste-url>'"
    echo ""
    echo "  URL:"
    echo "  $url_content"
    echo ""
    echo "=============================================="
}

complete_auth_oauth() {
    local h_pid_file="/tmp/onboard-oauth-$VM_NAME.host-pid"
    local c_fifo="/tmp/onboard-oauth-$VM_NAME.fifo"
    local c_pid_file="/tmp/onboard-oauth-$VM_NAME.pid"
    local c_log="/tmp/onboard-oauth-$VM_NAME.log"

    if [[ ! -f "$h_pid_file" ]]; then
        error "No OAuth session found. Run without --redirect-url first."
    fi

    local helper_pid
    helper_pid="$(cat "$h_pid_file")"
    if ! container_exec "kill -0 \$(cat '$c_pid_file' 2>/dev/null) 2>/dev/null"; then
        rm -f "$h_pid_file"
        # Check if auth somehow completed anyway
        local auth_json profile_count
        auth_json="$(container_exec "openclaw models auth list --provider openai --json" 2>/dev/null || echo '{"profiles":[]}')"
        profile_count="$(echo "$auth_json" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('profiles', [])))" 2>/dev/null || echo "0")"
        if [[ "$profile_count" -gt 0 ]]; then
            ok "Auth already completed!"
            finalize
            return 0
        fi
        error "OAuth helper died. Run without --redirect-url to restart."
    fi

    # Write redirect URL to fifo inside container (unblocks the helper)
    container_exec "echo '$(echo "$REDIRECT_URL" | sed "s/'/'\\\\''/g")' > '$c_fifo'"

    # Wait for completion
    local j=0
    while [[ $j -lt 30 ]]; do
        if ! container_exec "kill -0 \$(cat '$c_pid_file' 2>/dev/null) 2>/dev/null"; then
            break
        fi
        sleep 1
        j=$((j + 1))
    done

    # Check auth
    local auth_json profile_count
    auth_json="$(container_exec "openclaw models auth list --provider openai --json" 2>/dev/null || echo '{"profiles":[]}')"
    profile_count="$(echo "$auth_json" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('profiles', [])))" 2>/dev/null || echo "0")"
    if [[ "$profile_count" -eq 0 ]]; then
        error "Auth failed. Check: docker exec $VM_NAME cat $c_log"
    fi

    ok "OpenAI auth completed!"
    rm -f "$h_pid_file"
    finalize
}

# ---------------------------------------------------------------------------
# Device-code flow (fallback)
# ---------------------------------------------------------------------------
setup_auth_devicecode() {
    local auth_json profile_count
    auth_json="$(container_exec "openclaw models auth list --provider openai --json" 2>/dev/null || echo '{"profiles":[]}')"
    profile_count="$(echo "$auth_json" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('profiles', [])))" 2>/dev/null || echo "0")"
    if [[ "$profile_count" -gt 0 ]]; then
        ok "OpenAI auth already configured ($profile_count profile(s))"
        return 0
    fi

    local pid_file="/tmp/onboard-auth-$VM_NAME.pid"
    local log_file="/tmp/onboard-auth-$VM_NAME.log"

    if [[ -f "$pid_file" ]]; then
        local old_pid
        old_pid="$(cat "$pid_file")"
        if kill -0 "$old_pid" 2>/dev/null; then
            info "Device-code auth still polling (PID $old_pid)..."
            show_devicecode_info "$log_file"
            echo "  Run: $SCRIPT_NAME $VM_NAME --continue"
            exit 0
        else
            rm -f "$pid_file"
            auth_json="$(container_exec "openclaw models auth list --provider openai --json" 2>/dev/null || echo '{"profiles":[]}')"
            profile_count="$(echo "$auth_json" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('profiles', [])))" 2>/dev/null || echo "0")"
            [[ "$profile_count" -gt 0 ]] && ok "Auth completed!" && return 0
        fi
    fi

    rm -f "$log_file"

    info "Starting OpenAI device auth in background..."
    nohup docker exec "$VM_NAME" script -q -c "openclaw models auth login --provider openai --device-code --force" /dev/null > "$log_file" 2>&1 &
    local auth_pid=$!
    disown
    echo "$auth_pid" > "$pid_file"

    local i=0
    while [[ $i -lt 15 ]]; do
        if grep -q "https://auth.openai.com/codex/device" "$log_file" 2>/dev/null; then
            break
        fi
        sleep 1
        i=$((i + 1))
    done

    show_devicecode_info "$log_file"
    echo ""
    echo "  Run after authenticating:"
    echo "    $SCRIPT_NAME $VM_NAME --continue"
    echo ""

    if ! kill -0 "$auth_pid" 2>/dev/null; then
        auth_json="$(container_exec "openclaw models auth list --provider openai --json" 2>/dev/null || echo '{"profiles":[]}')"
        profile_count="$(echo "$auth_json" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('profiles', [])))" 2>/dev/null || echo "0")"
        if [[ "$profile_count" -gt 0 ]]; then
            ok "Auth completed!"
            rm -f "$pid_file"
            return 0
        fi
        info "Auth process exited early. Check: cat $log_file"
    fi

    exit 0
}

show_devicecode_info() {
    local log_file="$1"
    local url code error_type
    local clean
    clean="$(cat "$log_file" 2>/dev/null | tr -d '\000-\010\016-\037' | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][0-9;]*[^\x1b]*\x1b\\//g; s/\x1b[^a-zA-Z]*[a-zA-Z]//g' || true)"

    url="$(echo "$clean" | grep -oP 'https://auth\.openai\.com\S+' | head -1 || true)"
    code="$(echo "$clean" | sed -n 's/.*Code: \([A-Z0-9-]*\).*/\1/p' | head -1 || true)"

    if echo "$clean" | grep -qi "HTTP 429\|cloudflare\|Just a moment"; then
        error_type="rate_limit"
    elif echo "$clean" | grep -qi "failed\|error"; then
        error_type="error"
    else
        error_type=""
    fi

    echo ""
    echo "=============================================="
    echo "  OpenAI Device Authentication"
    echo "=============================================="

    if [[ "$error_type" == "rate_limit" ]]; then
        echo ""
        echo "  Cloudflare block detected. The OAuth flow will work better."
        echo "  Run without --continue to retry with OAuth."
    elif [[ -n "$url" ]] && [[ -n "$code" ]]; then
        echo ""
        echo "  URL:  $url"
        echo "  Code: $code"
        echo ""
        echo "  Code expires in 15 minutes."
    else
        echo ""
        echo "  Could not extract auth URL from log."
        echo "  Check: cat $log_file"
    fi
    echo "=============================================="
}

# ---------------------------------------------------------------------------
# API Key provider setup
# ---------------------------------------------------------------------------
setup_api_key() {
    local provider="$1" key="$2" default_model="$3"
    info "Configuring $provider API key..."
    local out
    out="$(printf '%s\n' "$key" | container_exec "openclaw models auth paste-api-key --provider '$provider'" 2>&1)" || true
    if echo "$out" | grep -qi "auth profile"; then
        ok "$provider API key configured"
    else
        info "$out"
        error "Failed to configure $provider. Check: docker exec $VM_NAME openclaw models auth list --json"
    fi

    # Auto-set a known default model when no model is configured yet
    local current_model
    current_model="$(container_exec "openclaw config get agents.defaults.model.primary" 2>/dev/null || true)"
    if [[ -z "$current_model" || "$current_model" == "openai/gpt-5.5" ]]; then
        if [[ -n "$default_model" ]]; then
            container_exec "openclaw config set agents.defaults.model.primary '$default_model'" >/dev/null
            ok "Default model set to $default_model"
        elif [[ "$provider" == "ollama-cloud" ]]; then
            container_exec "openclaw config set agents.defaults.model.primary 'ollama-cloud/gemma4:31b'" >/dev/null
            ok "Default model set to ollama-cloud/gemma4:31b"
        elif [[ "$provider" == "openrouter" ]]; then
            container_exec "openclaw config set agents.defaults.model.primary 'openrouter/deepseek/deepseek-v4-flash'" >/dev/null
            ok "Default model set to openrouter/deepseek/deepseek-v4-flash"
        fi
    fi
}

interactive_setup_api_key() {
    echo ""
    echo "=============================================="
    echo "  API Key Provider Setup"
    echo "=============================================="
    echo ""

    local done=false
    while [[ "$done" == "false" ]]; do
        echo "  Available providers:"
        echo "    1) openrouter"
        echo "    2) ollama-cloud"
        echo "    3) Custom (type any provider ID)"
        echo ""

        local choice provider
        read -r -p "  Pick provider [1-3] (or q to quit): " choice </dev/tty
        case "$choice" in
            1) provider="openrouter" ;;
            2) provider="ollama-cloud" ;;
            3)
                read -r -p "  Enter provider ID (e.g. openai, anthropic): " provider </dev/tty
                [[ -n "$provider" ]] || error "Provider ID cannot be empty"
                ;;
            q|Q) done="true"; echo ""; continue ;;
            *) echo "  Invalid choice: $choice"; echo ""; continue ;;
        esac

        local key
        read -r -p "  Enter API key for $provider: " key </dev/tty
        [[ -n "$key" ]] || error "API key cannot be empty"

        # Suggest a default model for known providers
        local suggested=""
        case "$provider" in
            ollama-cloud) suggested="ollama-cloud/gemma4:31b" ;;
            openrouter)   suggested="openrouter/deepseek/deepseek-v4-flash" ;;
        esac

        setup_api_key "$provider" "$key" "$suggested"

        # If we had a suggestion and it was used, skip the prompt
        if [[ -n "$suggested" ]]; then
            local current_model
            current_model="$(container_exec "openclaw config get agents.defaults.model.primary" 2>/dev/null || true)"
            if [[ "$current_model" == "$suggested" ]]; then
                echo ""
                continue
            fi
        fi

        # Optionally set a different default model
        echo ""
        read -r -p "  Set as default model? (y/n) [n]: " set_default </dev/tty
        if [[ "$set_default" == "y" ]]; then
            local model_name
            read -r -p "  Model ref (e.g. openrouter/anthropic/claude-sonnet-4-6): " model_name </dev/tty
            if [[ -n "$model_name" ]]; then
                container_exec "openclaw config set agents.defaults.model.primary '$model_name'" >/dev/null
                ok "Default model set to $model_name"
            fi
        fi

        echo ""
        read -r -p "  Set up another provider? (y/n) [n]: " another </dev/tty
        [[ "$another" != "y" ]] && done="true"
        echo ""
    done

    ok "API key setup complete"
}

# ---------------------------------------------------------------------------
# Finalize: set model + restart
# ---------------------------------------------------------------------------
finalize() {
    info "Finalizing setup for $VM_NAME..."

    # Kill any stale auth trackers
    rm -f "/tmp/onboard-auth-$VM_NAME.pid" "/tmp/onboard-auth-$VM_NAME.log"
    rm -f "/tmp/onboard-oauth-$VM_NAME.pid" "/tmp/onboard-oauth-$VM_NAME.fifo" "/tmp/onboard-oauth-$VM_NAME.url"

    local current_model
    current_model="$(container_exec "openclaw config get agents.defaults.model.primary" 2>/dev/null || true)"
    if [[ -z "$current_model" ]]; then
        info "Setting default model to openai/gpt-5.5..."
        container_exec "openclaw config set agents.defaults.model.primary 'openai/gpt-5.5'" >/dev/null
        ok "Default model set to openai/gpt-5.5"
    else
        info "Default model already set to: $current_model"
    fi

    info "Restarting container $VM_NAME..."
    docker restart "$VM_NAME" >/dev/null
    sleep 2
    info "Done! $VM_NAME is fully onboarded."
    info "Verify with: docker exec $VM_NAME openclaw models status"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    parse_args "$@"
    check_vm

    # --continue finalizes setup without checking auth profiles
    if [[ "$CONTINUE" == "true" ]]; then
        info "Finalizing setup (auth must be configured separately)..."
        finalize
        exit 0
    fi

    # --setup-api-key: interactive provider setup
    if [[ "$SETUP_API_KEY" == "true" ]]; then
        interactive_setup_api_key
        exit 0
    fi

    # --api-key: non-interactive provider setup (repeatable)
    if [[ ${#API_KEYS[@]} -gt 0 ]]; then
        for ak in "${API_KEYS[@]}"; do
            local prov="${ak%%=*}" key="${ak#*=}"
            [[ -n "$prov" && -n "$key" ]] || error "Invalid --api-key format: $ak (use <provider>=<key>)"
            local suggested=""
            case "$prov" in
                ollama-cloud) suggested="ollama-cloud/gemma4:31b" ;;
                openrouter)   suggested="openrouter/deepseek/deepseek-v4-flash" ;;
            esac
            setup_api_key "$prov" "$key" "$suggested"
        done
        exit 0
    fi

    # --redirect-url completes OAuth flow
    if [[ -n "$REDIRECT_URL" ]]; then
        complete_auth_oauth
        exit 0
    fi

    run_onboard
    setup_telegram

    # OpenAI auth flow is currently unreliable in non-TTY tool sessions.
    # The OAuth helper code above (setup_auth_oauth, complete_auth_oauth,
    # ensure_oauth_helper) and device-code fallback (setup_auth_devicecode)
    # are kept for future debugging. To re-enable, call setup_auth_oauth here.
    info "OpenAI auth via OAuth helper is disabled."
    echo ""
    echo "  To configure OpenAI auth manually, run inside the container:"
    echo "    docker exec -it $VM_NAME openclaw models auth login --provider openai"
    echo ""
    echo "  Then finalize with:"
    echo "    $SCRIPT_NAME $VM_NAME --continue"
    echo ""
    # setup_auth_oauth  # disabled — see OAuth helper code above
}

main "$@"
