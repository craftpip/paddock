/**
 * Per-instance image + build-file helpers (plan 25 — independent build files).
 *
 * Every agent is self-contained: its build files live in
 * `instances/<name>/build/` (copied from the shared template at create time)
 * and it builds its OWN image tag `paddock-vm-<name>:latest`. Nothing is
 * shared between PADs of the same type anymore.
 *
 * This module is the single source of truth for:
 *   - the per-instance image tag (`imageFor`),
 *   - the per-instance build dir paths,
 *   - reading/writing `build.env` (K=V ARG overrides, # comments allowed),
 *   - extracting the `ARG` lines from an instance Dockerfile (the compose
 *     `build.args:` block is generated from them).
 *
 * It must stay dependency-free (no vm-manager/drivers) so both drivers and
 * vm-manager can require it without circular imports.
 */

const fs = require('fs');
const path = require('path');

/** Resolved each call so runtime env overrides (tests) take effect. */
function instancesDir() {
  return path.join(process.env.WORKSPACE_ROOT || '/workspace', 'instances');
}

/** Per-instance image tag, e.g. `paddock-vm-pad-opencode-yo:latest`.
 *  Name never changes → the tag is stable; nothing needs persisting.
 *  Lowercased defensively (docker repo names must be lowercase). */
function imageFor(name) {
  return `paddock-vm-${String(name).toLowerCase()}:latest`;
}

/** Legacy shared tag that pre-migration PADs were built from. Used only by the
 *  one-time migration to retag the running image into the per-instance tag. */
function legacySharedImage(agent) {
  return `paddock-vm-${agent}:latest`;
}

/** Per-instance build directory (Dockerfile, start.sh, build.env, extras/). */
function buildDir(name) {
  return path.join(instancesDir(), name, 'build');
}

/** Path of the per-instance build.env (ARG overrides for compose builds). */
function buildEnvPath(name) {
  return path.join(buildDir(name), 'build.env');
}

/** Parse a build.env into a plain object (K=V, # comments skipped). */
function readBuildEnv(name) {
  const out = {};
  const p = buildEnvPath(name);
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** Set KEY=VALUE lines in an instance's build.env (preserves comments + other
 *  keys; appends missing keys). Creates the file when absent. */
function setBuildEnv(name, kv) {
  const dir = buildDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const p = buildEnvPath(name);
  let content = '';
  if (fs.existsSync(p)) {
    content = fs.readFileSync(p, 'utf8');
  } else {
    content = '# Per-instance build args (ARG overrides for this PAD\'s image).\n';
    content += '# Hand-edit or set via Settings → Allow docker. Applied on next rebuild.\n';
  }
  for (const [key, value] of Object.entries(kv)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = content.replace(/\s*$/, '') + '\n' + line + '\n';
    }
  }
  fs.writeFileSync(p, content);
}

/** Extract `ARG <NAME>[=<default>]` lines from a Dockerfile. Returns
 *  [{ name, default }] in file order (commented-out ARGs are skipped). The
 *  compose `build.args:` block is generated from these. */
function argsFromDockerfile(dockerfilePath) {
  if (!fs.existsSync(dockerfilePath)) return [];
  const out = [];
  for (const line of fs.readFileSync(dockerfilePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(t);
    if (m) out.push({ name: m[1], default: (m[2] || '').trim() });
  }
  return out;
}

module.exports = {
  imageFor,
  legacySharedImage,
  buildDir,
  buildEnvPath,
  readBuildEnv,
  setBuildEnv,
  argsFromDockerfile,
};
