# Compose Serialization And Validation (plan 29)

## Goal

Stop generated PAD compose configurations from becoming malformed. Compose content must be generated as a structured JavaScript object and serialized as JSON, which is valid YAML, instead of manually concatenated YAML strings.

## Problem

`generateInstanceCompose()` previously joined YAML lines by hand. Compose interpolation such as `${INSTALL_DOCKER:-0}` contains a colon, which is YAML syntax when it is not quoted. A Docker settings update then stopped the PAD, wrote an invalid compose file, and Compose partially recreated the services before returning an error.

## Work

- Keep `generateInstanceCompose()` object-first. Do not reintroduce YAML string concatenation.
- Serialize the final compose document with `JSON.stringify(..., null, 2)` and continue writing it to `docker-compose.yml`.
- Update unit tests to parse the generated document with `JSON.parse()` and assert the Compose structure, not layout text.
- Before every generated-compose `build`, `up`, or `config` action, run `docker compose ... config --quiet`; abort before stopping or recreating a PAD if validation fails.
- Ensure a failed settings update leaves the existing container running and reports the parser output without applying partial changes.
- Add regression cases for Compose default interpolation, colon-bearing volume/port values, peer-network web doors, and a custom workspace mount.

## Verification

- `node --test test/vm-manager.test.js`
- Generate an OpenCode PAD compose with `INSTALL_DOCKER=1`, a peer network, a published web door, and a custom workspace.
- Run `docker compose --env-file <build.env> -f <compose> config --quiet` from the WebUI container.
- Toggle Docker on and verify both `docker --version` and `/var/run/docker.sock` inside the PAD.
