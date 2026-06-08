# VM Instance Manager

Use `add-vm.sh` to create VM instances for OpenClaw, PicoClaw, nanobot, or Hermes Agent.

Use `reset-vm.sh` to wipe a VM workspace, and `remove-vm.sh` to delete an instance entirely.

## Model

- OpenClaw image: `vm-friends-vm-openclaw:latest`
- PicoClaw image: `vm-friends-vm-picoclaw:latest`
- nanobot image: `vm-friends-vm-nanobot:latest`
- Hermes image: `vm-friends-vm-hermes:latest` (base: `nousresearch/hermes-agent:latest`)
- Instance data: `instances/<vm-name>/openclaw/` for OpenClaw, `instances/<vm-name>/picoclaw/` for PicoClaw, `instances/<vm-name>/nanobot/` for nanobot, and `instances/<vm-name>/hermes/` for Hermes Agent
- Generated services: `docker-compose.override.yml` when instances exist

## Create

```bash
./add-vm.sh vm-alice --fresh
./add-vm.sh vm-alice --agent picoclaw
./add-vm.sh vm-alice --agent nanobot
./add-vm.sh vm-alice --agent hermes
./add-vm.sh vm-alice --clone vm-ozden
./add-vm.sh vm-alice --agent nanobot --default-config --bot-token 123456:ABC
./reset-vm.sh vm-alice
./remove-vm.sh vm-alice
```

## Defaults

- Password defaults to the VM suffix, so `vm-alice` uses `alice`
- Port defaults to the next free port starting at `43817`
- Agent defaults to `openclaw`; set `--agent picoclaw`, `--agent nanobot`, or `--agent hermes` for alternatives
- `--default-config` applies Telegram + Ollama defaults after first start
- `--default-config` is currently supported for OpenClaw, PicoClaw, and nanobot; Hermes uses manual setup (`hermes setup`)
- Global defaults are loaded from `.env` (optional; falls back to built-ins if missing)
- Default allow-from user id: `DEFAULT_ALLOW_FROM` (current: `532156945`)
- Default model endpoint: `DEFAULT_MODEL_BASE_URL` (current: `http://10.69.1.131:11434/v1`)
- Default model: `DEFAULT_MODEL_NAME` with context length `DEFAULT_CONTEXT_LENGTH` (current: `gpt-oss:20b-73728`, `96000`)

## What it does

1. Creates `instances/<vm-name>/<agent>/`
2. Optionally clones data from another instance or legacy workspace
3. Writes instance metadata
4. Regenerates or removes `docker-compose.override.yml`
5. Starts the container

## Reset

`reset-vm.sh` removes `instances/<vm-name>/<agent>/`, recreates an empty workspace, and restarts the VM.

## Remove

`remove-vm.sh` stops the container and deletes `instances/<vm-name>/`.

## Notes

- Fresh instances stay running even with an empty workspace.
- Clone mode copies the source workspace contents.
- Existing legacy VMs still work, but new VMs are managed from `instances/`.
