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
const { ensureOwned } = require('./ownership');

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
  ensureOwned(p);
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

// ── Plan 41: user "Build commands" block (dev-container build stage) ──────

/** The anchor the custom-build block is inserted before: the ENTRYPOINT banner
 *  that every driver template shares. Plan 43 renumbered it from 9 to 10 on the
 *  four pad-user templates, hermes kept 9 — match any number. */
const ENTRYPOINT_BANNER_RE = /^# ---- \d+\.\s*ENTRYPOINT\s+[- ]*.*$/m;

/** Marker comments delimiting the web-managed block. The whole block (markers
 *  + contents) is machine-managed: any user edits INSIDE it are overwritten on
 *  the next write; edits outside it (anywhere else in the Dockerfile) survive. */
const BUILD_BLOCK_HEAD = '# \u2500\u2500 PADDOCK CUSTOM BUILD COMMANDS (managed by the web UI) \u2500\u2500';
const BUILD_BLOCK_TAIL = '# \u2500\u2500 END PADDOCK CUSTOM BUILD COMMANDS \u2500\u2500';

/** The per-instance Dockerfile path (`instances/<name>/build/Dockerfile`). */
function dockerfilePath(name) {
  return path.join(buildDir(name), 'Dockerfile');
}

/** Read the current user "Build commands" text from the instance Dockerfile.
 *  Returns the text between the markers (trimmed), or '' when the block (or the
 *  file) is absent. */
function readCustomBuild(name) {
  const p = dockerfilePath(name);
  if (!fs.existsSync(p)) return '';
  const content = fs.readFileSync(p, 'utf8');
  const m = content.match(/(?:^|\n)#\s*\u2500\u2500 PADDOCK CUSTOM BUILD COMMANDS[\s\S]*?\n#\s*\u2500\u2500 END PADDOCK CUSTOM BUILD COMMANDS[^\n]*\n?/);
  if (!m) return '';
  return m[0]
    .replace(/^#\s*\u2500\u2500 PADDOCK CUSTOM BUILD COMMANDS.*\n/, '')
    .replace(/\n?#\s*\u2500\u2500 END PADDOCK CUSTOM BUILD COMMANDS[^\n]*\n?$/, '')
    .trim();
}

/** Set (or clear) the user "Build commands" block in the instance Dockerfile
 *  (plan 41). `text` is injected between the marker comments, inserted right
 *  before the ENTRYPOINT banner (so custom `ARG` lines are picked up by
 *  `argsFromDockerfile` on the next compose regeneration). Empty text removes
 *  the block entirely. Returns the final Dockerfile text (for tests). */
function writeCustomBuild(name, text) {
  const p = dockerfilePath(name);
  fs.mkdirSync(buildDir(name), { recursive: true });
  let content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (!content) throw new Error(`No Dockerfile for ${name} — seed the build dir first`);
  const blockText = String(text || '').replace(/\s*$/, '');
  const block = blockText
    ? `${BUILD_BLOCK_HEAD}\n${blockText}\n${BUILD_BLOCK_TAIL}\n\n`
    : '';

  // Replace an existing managed block if present.
  const blockRe = /^#\s*\u2500\u2500 PADDOCK CUSTOM BUILD COMMANDS[\s\S]*?\n#\s*\u2500\u2500 END PADDOCK CUSTOM BUILD COMMANDS[^\n]*\n?/m;
  if (blockRe.test(content)) {
    content = content.replace(blockRe, block);
  } else {
    const anchor = ENTRYPOINT_BANNER_RE.exec(content);
    if (anchor) {
      const at = anchor.index;
      content = content.slice(0, at) + block + content.slice(at);
    } else if (block) {
      content = content.replace(/\s*$/, '') + '\n\n' + block;
    }
  }
  fs.writeFileSync(p, content);
  ensureOwned(p);
  return content;
}

module.exports = {
  imageFor,
  legacySharedImage,
  buildDir,
  buildEnvPath,
  readBuildEnv,
  setBuildEnv,
  argsFromDockerfile,
  dockerfilePath,
  readCustomBuild,
  writeCustomBuild,
  BUILD_BLOCK_HEAD,
  BUILD_BLOCK_TAIL,
};
