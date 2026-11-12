/**
 * Per-PAD build files: the Dockerfile and start.sh a PAD is built from, its
 * lifecycle hook scripts, the project image, and the machine-managed blocks
 * (SSH, web start, pad user, home ownership) kept current in them.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  readPostCreate, readPostStart, readPostAttach, hasLifecycleScripts, seedBuildDir,
  buildProjectImage, writePostCreateScript, writePostStartScript, writePostAttachScript,
  postCreateScriptPath, ensurePostStartBlock, imageHasPostStartHook, ensureSshStartBlock,
  ensureWebStartBlock, imageHasPadUser, ensureUserModeBuildFiles, imageHomeOwnershipBaked,
  ensureHomeOwnership, ensureWebHookUserDrop, migrateWebHooks, postStartScriptPath,
  postAttachScriptPath, projectImageTag, workspaceHasProjectImage, ensureInstanceBuilds,
});

const fs = require('fs');
const path = require('path');
const { runCmdStream } = require('../cmd');
const { imageFor, legacySharedImage, buildDir, buildEnvPath, setBuildEnv } = require('../instance-image');
const { ensureOwned, normalizeTree, writeFileOwned } = require('../ownership');
const devcontainer = require('../devcontainer');
const {
  BUILD_TEMPLATES_DIR, runCmd, getDriver, getDriverOr, WEB_USER_DROP_MARKER, INSTANCES_DIR,
  readMeta, VM_NAME_RE, PREFIX_RE,
} = require('./internal');
const { containerViewOf } = require('./workspace-mount');
const { writeInstanceCompose, runCompose } = require('./compose');
const { isManagedDoorContainer, getPeerNetworkName } = require('./doors-network');
const { webHookPath, readWebService, readWebAuth, buildWebHook } = require('./web');
const { imageProbe } = require('./lifecycle');

/** Shared build-template dir for an agent type (`src/vm-builds/<type>`). */
function buildTemplateDir(agent) {
  return path.join(BUILD_TEMPLATES_DIR, agent);
}

/** Seed (or top up) an instance's build dir from the shared template:
 *  `instances/<name>/build/{Dockerfile,start.sh,build.env,extras/}`. Idempotent
 *  — never overwrites an existing build file. `extras/` must exist because the
 *  Dockerfile template `COPY`s it (an empty dir breaks the build), and
 *  `build.env` is written with INSTALL_DOCKER when the agent has docker on. */
function seedBuildDir(name, agent, opts = {}) {
  const { installDocker = false } = opts;
  const dir = buildDir(name);
  const tpl = buildTemplateDir(agent);
  if (fs.existsSync(dir)) {
    // Already seeded (create/clone/migrate) — just ensure the invariants.
    fs.mkdirSync(path.join(dir, 'extras'), { recursive: true });
    const keep = path.join(dir, 'extras', '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
    if (!fs.existsSync(buildEnvPath(name))) {
      setBuildEnv(name, installDocker ? { INSTALL_DOCKER: '1' } : {});
    }
    normalizeTree(dir);
    return dir;
  }
  if (fs.existsSync(tpl)) {
    fs.cpSync(tpl, dir, { recursive: true });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'extras'), { recursive: true });
  const keep = path.join(dir, 'extras', '.gitkeep');
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  if (!fs.existsSync(buildEnvPath(name))) {
    setBuildEnv(name, installDocker ? { INSTALL_DOCKER: '1' } : {});
  }
  normalizeTree(dir);
  return dir;
}

/** Path of the per-instance post-create script (`build/post-create.sh`). */
function postCreateScriptPath(name) {
  return path.join(buildDir(name), 'post-create.sh');
}

/** Path of the per-instance post-start script (`build/post-start.sh`). */
function postStartScriptPath(name) {
  return path.join(buildDir(name), 'post-start.sh');
}

/** Path of the per-instance post-attach script (`build/post-attach.sh`). */
function postAttachScriptPath(name) {
  return path.join(buildDir(name), 'post-attach.sh');
}

/** True when any plan-41 lifecycle script exists for the instance (post-create,
 *  post-start or post-attach). The compose generator binds the build dir at
 *  /build when ANY of them exist, so every script is exec-able in the running
 *  container. */
function hasLifecycleScripts(name) {
  return [postCreateScriptPath(name), postStartScriptPath(name), postAttachScriptPath(name)]
    .some((p) => fs.existsSync(p));
}

/** Read a lifecycle script body (without the shebang / `set -e`), or '' when
 *  none. */
function readLifecycleScript(p) {
  if (!fs.existsSync(p)) return '';
  let t = fs.readFileSync(p, 'utf8');
  t = t.replace(/^#![^\n]*\n?/, '').replace(/^\s*set -e\s*\n?/, '').replace(/\s*$/, '');
  return t;
}

/** Write (or remove) a lifecycle script (plan 41). Same shape as the post-create
 *  script: `#!/usr/bin/env bash` + `set -e`; empty text removes the file. */
function writeLifecycleScript(p, text) {
  const dir = path.dirname(p);
  const body = String(text || '').replace(/\r\n/g, '\n');
  if (!body.trim()) {
    if (fs.existsSync(p)) fs.rmSync(p);
    return;
  }
  const script = '#!/usr/bin/env bash\nset -e\n' + body.replace(/^\s*$/, '') + '\n';
  writeFileOwned(p, script, { boundary: dir, mode: 0o755 });
}

/** Read the current post-create script body (without the shebang), or '' when
 *  none exists. */
function readPostCreate(name) {
  return readLifecycleScript(postCreateScriptPath(name));
}

/** Read the current post-start script body, or '' when none exists. */
function readPostStart(name) {
  return readLifecycleScript(postStartScriptPath(name));
}

/** Read the current post-attach script body, or '' when none exists. */
function readPostAttach(name) {
  return readLifecycleScript(postAttachScriptPath(name));
}

/** Write (or remove) the per-instance post-create script (plan 41). The body
 *  is wrapped in `set -e` + `#!/usr/bin/env bash` so the create job runs it
 *  streamed via `docker exec`; empty text removes the file. */
function writePostCreateScript(name, text) {
  writeLifecycleScript(postCreateScriptPath(name), text);
}

/** Write (or remove) the per-instance post-start script (plan 41). Runs on
 *  every container start (start.sh hook); empty text removes the file. */
function writePostStartScript(name, text) {
  writeLifecycleScript(postStartScriptPath(name), text);
}

/** Write (or remove) the per-instance post-attach script (plan 41). Runs when a
 *  terminal/exec session attaches to the agent; empty text removes the file. */
function writePostAttachScript(name, text) {
  writeLifecycleScript(postAttachScriptPath(name), text);
}

// ─── Project image (plan 41 multi-stage) ────────────────────────────────────

/** Tag of a pad's project image: `paddock-proj-<name>:latest`, built once from
 *  the workspace devcontainer's `build`/`image` so the build-commands box can
 *  `COPY --from=paddock-proj-<name>:latest …` / `RUN --mount=from=…` by tag (the
 *  box cannot open a `FROM … AS <name>` stage — lesson O39). The agent's
 *  runtime base stays the driver's own image — the project image is only the
 *  toolchain/stage source. */

// ─── Project image (plan 41 multi-stage) ────────────────────────
// The workspace's devcontainer `build`/`image` is NEVER the agent's base. It is
// built once as `paddock-proj-<name>:latest` so the build-commands box can
// `COPY --from=paddock-proj-<name>:latest ...` (by tag, never an `AS` alias —
// lesson O39) to pull the
// project toolchain (code, venvs, node_modules) into the agent's own image.

/** Tag of the per-pad project image (`paddock-proj-<name>:latest`). The name is
 *  lowercased like `imageFor` (registry-safe tag segment); the pad prefix is
 *  dropped since these images never map 1:1 to a running container. */
function projectImageTag(name) {
  return `paddock-proj-${name.toLowerCase()}:latest`;
}

/** Whether the workspace devcontainer declares a `build`/`image` worth building
 *  as the project image. Never throws. */
function workspaceHasProjectImage(wsHost) {
  const view = containerViewOf(wsHost);
  if (!view) return false;
  const dc = devcontainer.readDevContainer(view);
  return !!(dc && (dc.dockerFile || dc.image));
}

/** Build (or pull+tag) the workspace devcontainer's `build`/`image` once as
 *  `paddock-proj-<name>:latest` (plan 41 item 10). Only runs for workspaces the
 *  webui can see (containerViewOf != null); host-only sources are skipped with a
 *  log — the Docker daemon could build them but the webui has no view to read
 *  the devcontainer from. Throws on build failure (create job aborts visibly). */
async function buildProjectImage(name, wsHost, { onLog = () => {} } = {}) {
  const view = containerViewOf(wsHost);
  if (!view || !fs.existsSync(view)) {
    onLog('system', 'Skipping project image: workspace is not visible to the webui');
    return null;
  }
  const dc = devcontainer.readDevContainer(view);
  if (!dc || (!dc.dockerFile && !dc.image)) {
    return null;
  }
  const tag = projectImageTag(name);
  if (dc.dockerFile) {
    // Build context = the devcontainer's `build.context` (defaults to the dir
    // containing the devcontainer.json); the Dockerfile is relative to it.
    const ctx = dc.buildContext || view;
    if (!fs.existsSync(ctx)) {
      onLog('system', `Skipping project image: build context not found (${ctx})`);
      return null;
    }
    const dockerfile = dc.dockerFile.startsWith('/')
      ? dc.dockerFile
      : path.join(ctx, dc.dockerFile);
    onLog('system', `Building project image ${tag} from ${dockerfile}…`);
    await runCmdStream('docker', ['build', '-t', tag, '-f', dockerfile, ctx], { onLog, timeout: 900000 });
    onLog('system', `Project image built: ${tag}`);
    return tag;
  }
  if (dc.image) {
    onLog('system', `Pulling project image ${dc.image} as ${tag}…`);
    await runCmdStream('docker', ['pull', dc.image], { onLog, timeout: 900000 });
    await runCmd('docker', ['tag', dc.image, tag], { timeout: 30000 });
    onLog('system', `Project image tagged: ${tag}`);
    return tag;
  }
  return null;
}

/** The sshd-listen-port block the start.sh templates now ship. start.sh reads
 *  the SSH_PORT env (set by the compose while SSH is exposed) and, when it's not
 *  22, rewrites sshd_config's Port before launching sshd — agents that share a
 *  network namespace can't ALL bind 22. */
const SSH_START_MARKER = 'SSH_PORT';
const SSH_START_BLOCK = `# SSH_PORT (set by the Paddock compose when SSH is exposed) picks a custom
# sshd listen port — multiple agents sharing a network namespace can't ALL bind
# 22, so each gets its own.
if [ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ]; then
    sed -i "s/^#\\?[[:space:]]*Port .*/Port $SSH_PORT/" /etc/ssh/sshd_config
fi
`;

/** Marker + block for the web start-hook, backfilled into an instance's OWN
 *  build/start.sh (PADs created before the template change don't have it). The
 *  block must sit BEFORE the driver's foreground process (the openclaw gateway
 *  line in particular — a published config patch must be in place before the
 *  gateway binds). The baked `/usr/local/bin/start.sh` only changes after a
 *  rebuild, so callers must rebuild the image when ensureWebStartBlock returns
 *  true. */
const WEB_START_MARKER = 'start-web.sh';

function webStartBlock(agent) {
  const hookPath = `${getDriver(agent).dataDir}/start-web.sh`;
  return `# Paddock web publishing: if the webui wrote a start-web.sh hook (bound via
# the data-dir bind mount), run it so the published web server survives
# recreates. The hook is idempotent and backgrounds itself.
if [ -f ${hookPath} ]; then
    bash ${hookPath} || true
fi
`;
}

/** Backfill the web start-hook block into an instance's OWN build/start.sh
 *  (PADs created before the template change don't have it). Inserted before the
 *  driver's gateway line (openclaw `openclaw gateway run`, picoclaw `picoclaw
 *  gateway -E`, hermes `hermes gateway run`). Returns whether the build/start.sh
 *  will produce an image that runs the hook (true when the marker is already
 *  present — e.g. freshly seeded from the updated template — OR after patching);
 *  false when un-patchable. Callers rebuild the image on true. */
function ensureWebStartBlock(name, agent) {
  const dir = buildDir(name);
  const p = path.join(dir, 'start.sh');
  if (!fs.existsSync(p)) return false;
  let content = fs.readFileSync(p, 'utf8');
  if (content.includes(WEB_START_MARKER)) return true;
  const re = new RegExp('^(\\s*' + agent + ' gateway.*)$', 'm');
  if (!re.test(content)) return false;
  content = content.replace(re, webStartBlock(agent) + '$1');
  fs.writeFileSync(p, content, { mode: 0o755 });
  ensureOwned(p);
  return true;
}

/** Backfill the SSH_PORT block into an instance's OWN build/start.sh (PADs
 *  created before the template change don't have it). The baked `/usr/local/
 *  bin/start.sh` only changes after a rebuild, so callers must rebuild the image
 *  when this returns true. Idempotent: already-patched (or un-patchable) return
 *  false. */
function ensureSshStartBlock(name) {
  const dir = buildDir(name);
  const p = path.join(dir, 'start.sh');
  if (!fs.existsSync(p)) return false;
  let content = fs.readFileSync(p, 'utf8');
  if (content.includes(SSH_START_MARKER)) return false;
  const re = /^(\s*\/usr\/sbin\/sshd &.*)$/m;
  if (!re.test(content)) return false;
  content = content.replace(re, SSH_START_BLOCK + '$1');
  fs.writeFileSync(p, content, { mode: 0o755 });
  ensureOwned(p);
  return true;
}

/** Post-start lifecycle hook marker (plan 41). The block is baked into the
 *  image at build time and runs `/build/post-start.sh` on EVERY container start
 *  (the build dir is bind-mounted at /build when the instance has lifecycle
 *  scripts). Absent from pads created before the template change; callers must
 *  rebuild the image when ensurePostStartBlock returns true. */
const POST_START_MARKER = '/build/post-start.sh';

const POST_START_BLOCK = `# Paddock post-start hook (plan 41): if the webui wrote a post-start.sh (bound
# via the build-dir /build mount), run it on EVERY container start.
if [ -f /build/post-start.sh ]; then
    bash /build/post-start.sh || true
fi
`;

/** Backfill the post-start hook into an instance's OWN build/start.sh (pads
 *  created before the template change don't have it). Returns true when it was
 *  injected (caller must rebuild the image); false when already present or
 *  un-patchable. Idempotent. */
function ensurePostStartBlock(name) {
  const dir = buildDir(name);
  const p = path.join(dir, 'start.sh');
  if (!fs.existsSync(p)) return false;
  let content = fs.readFileSync(p, 'utf8');
  if (content.includes(POST_START_MARKER)) return false;
  const re = /^(\s*\/usr\/sbin\/sshd &.*)$/m;
  if (!re.test(content)) return false;
  content = content.replace(re, '$1\n' + POST_START_BLOCK);
  fs.writeFileSync(p, content, { mode: 0o755 });
  ensureOwned(p);
  return true;
}

/** Whether the baked image's start.sh has the post-start hook baked
 *  into it. Used by applyAgentChanges to decide whether enabling a
 *  post-start command needs a rebuild. */
async function imageHasPostStartHook(name, image, wasRunning) {
  return imageProbe(name, image, wasRunning, `grep -q '${POST_START_MARKER}' /usr/local/bin/start.sh`);
}

// ─── User-mode (Container user) build-file support (plan 43 Phase 7) ────────
// The `pad` user + daemon-drop block live in the build templates now, so NEW
// pads get them at create time. Existing root-mode pads toggled to user mode
// need them injected into their OWN build files before a rebuild. `start.sh`
// is machine-managed (the webui already injects SSH/web blocks into it), so it
// is REGENERATED from the template when it lacks the marker; the Dockerfile is
// the user's editable surface (plan 41) so only the pad-user block is injected.

const PAD_USER_MARKER = '__PAD_USER_MODE__';

/** Universal pad-user block — works on both apt (debian) and apk (alpine)
 *  bases; idempotent. Creates a `pad` user at PUID:PGID (1000:1000), installs
 *  sudo when the base doesn't ship it (toggled pads keep their ORIGINAL package
 *  list, so the rule alone would be useless there), grants passwordless sudo,
 *  and gives the pad user the whole home (/root, plan 79) so tools that write
 *  under $HOME outside the one bind-mounted data dir can. */
const PAD_USER_DOCKERFILE_BLOCK = `# PAD USER (plan 43 Phase 7) — pad at PUID:PGID + passwordless sudo + chown of the home (plan 79). ${PAD_USER_MARKER}
RUN if command -v apk >/dev/null 2>&1; then \\
      addgroup -g 1000 pad 2>/dev/null; adduser -D -u 1000 -G pad -h /home/pad -s /bin/bash pad 2>/dev/null || true; \\
    else \\
      groupadd -g 1000 pad 2>/dev/null || true; \\
      (id pad >/dev/null 2>&1 || useradd -m -o -u 1000 -g 1000 -s /bin/bash pad 2>/dev/null) || useradd -m -o -u 1000 -s /bin/bash pad 2>/dev/null || true; \\
    fi; \\
    chmod 755 /root; \\
    chown -R 1000:1000 /root; \\
    if ! command -v sudo >/dev/null 2>&1; then \\
      if command -v apk >/dev/null 2>&1; then apk add --no-cache sudo; else DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo; fi; \\
    fi; \\
    echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pad && chmod 440 /etc/sudoers.d/pad
`;

/** Ensure a pad's OWN build files can build a user-mode image: regenerate
 *  start.sh from the template when it lacks the drop block, and inject the
 *  pad-user block into the Dockerfile when it lacks the marker (or replace a
 *  stale pre-existing block with the canonical one — the block is
 *  machine-managed, so upgrades propagate). Returns true when anything changed
 *  (caller must rebuild the image). */
function ensureUserModeBuildFiles(name, agent) {
  let changed = false;
  const dir = buildDir(name);
  if (!fs.existsSync(dir)) return false;

  const start = path.join(dir, 'start.sh');
  if (fs.existsSync(start)) {
    const content = fs.readFileSync(start, 'utf8');
    if (!content.includes(PAD_USER_MARKER)) {
      const tpl = path.join(buildTemplateDir(agent), 'start.sh');
      if (fs.existsSync(tpl)) {
        const fresh = fs.readFileSync(tpl, 'utf8');
        if (fresh.includes(PAD_USER_MARKER)) {
          fs.writeFileSync(start, fresh, { mode: 0o755 });
          ensureOwned(start);
          changed = true;
        }
      }
    }
  }

  const df = path.join(dir, 'Dockerfile');
  if (fs.existsSync(df)) {
    const content = fs.readFileSync(df, 'utf8');
    const markerIdx = content.indexOf(PAD_USER_MARKER);
    if (markerIdx === -1) {
      // Inject before the first COPY start.sh (or ENTRYPOINT), else append.
      const lines = content.split('\n');
      let idx = lines.findIndex((l) => /^COPY start\.sh/.test(l.trim()) || /^ENTRYPOINT/.test(l.trim()));
      if (idx < 0) idx = lines.length;
      lines.splice(idx, 0, PAD_USER_DOCKERFILE_BLOCK.trimEnd());
      fs.writeFileSync(df, lines.join('\n'));
      ensureOwned(df);
      changed = true;
    } else {
      // Replace an existing pad-user block with the canonical one so upgrades
      // to the block (rule shape, sudo self-install) propagate on next rebuild.
      const startIdx = content.lastIndexOf('# PAD USER', markerIdx);
      const chmodAt = content.indexOf('chmod 440 /etc/sudoers.d/pad', markerIdx);
      if (startIdx >= 0 && chmodAt >= 0) {
        let end = content.indexOf('\n', chmodAt);
        if (end < 0) end = content.length;
        const oldBlock = content.slice(startIdx, end);
        if (oldBlock.trim() !== PAD_USER_DOCKERFILE_BLOCK.trimEnd()) {
          const fresh = content.slice(0, startIdx) + PAD_USER_DOCKERFILE_BLOCK.trimEnd() + '\n' + content.slice(end + 1);
          fs.writeFileSync(df, fresh);
          ensureOwned(df);
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Whether the built image (or running container) has the `pad` user baked in
 *  (i.e. it can run a user-mode pad). Used by `applyAgentChanges` to decide
 *  whether toggling Container user needs a rebuild. */
async function imageHasPadUser(name, image, wasRunning) {
  return imageProbe(name, image, wasRunning, 'id -u pad');
}

// ─── User-mode home ownership (plan 79) ─────────────────────────────────────
// A user-mode pad drops the agent to uid 1000 with HOME=/root, but /root stays
// root-owned unless the image gives it away — so any tool that writes under
// $HOME outside its one bind-mounted data dir (opencode's XDG state at
// /root/.local/state, .cache, .config) hits PermissionDenied. The templates now
// chown the home twice: an early pass BEFORE the root-run hooks (so a session
// started while a slow post-start hook runs is already writable) and again in
// the USER_MODE=user branch after the hooks. `ensureHomeOwnership` backfills an
// EXISTING user-mode pad's own build/start.sh (inserting the early pass and
// upgrading the old narrow `chown -R 1000:1000 /root/.<agent>` line), and the
// image probe decides whether that backfill needs a rebuild.

// The DISTINCTIVE marker of the pre-hook pass. The image probe greps for this
// (not the generic marker) so a pad backfilled by the first plan-79 cut — which
// only had the late, in-branch chown — is seen as NOT yet baked and rebuilds
// once to pick the early pass up.
const HOME_EARLY_MARKER = 'PAD HOME OWNERSHIP (plan 79): early pass';

// Early pass: take ownership of the whole home BEFORE the root-run hooks
// (start-web, post-start) so a session started mid-boot is already writable.
const HOME_EARLY_BLOCK = `# PAD HOME OWNERSHIP (plan 79): early pass — give the pad user the whole
# home BEFORE the root-run hooks (start-web, post-start) below can find it
# root-owned, so a session started mid-boot is already writable. The USER_MODE
# branch re-runs it after the hooks in case one wrote into the home.
if [ "$USER_MODE" = "user" ]; then
    chown -R 1000:1000 /root 2>/dev/null || true
fi`;

const HOME_OWNERSHIP_BLOCK = `# PAD HOME OWNERSHIP (plan 79): the agent runs as uid 1000 with
    # HOME=/root, so give it the whole home — tools write under $HOME
    # (opencode's XDG state at /root/.local/state), not just the data dir.
    chown -R 1000:1000 /root 2>/dev/null || true`;

/** Backfill the home-ownership chown into an instance's OWN build/start.sh.
 *  Two edits, both idempotent: (1) insert the EARLY pass right after sshd
 *  starts, before the root-run hooks — only when this looks like a user-mode
 *  start.sh (it already has a home chown or the old narrow one); (2) upgrade an
 *  old narrow `chown -R 1000:1000 /root/.<agent>` line to the whole-home chown.
 *  Returns true when it patched (caller must rebuild the image); false when it
 *  is already current or un-patchable (a root-mode or custom start.sh). */
function ensureHomeOwnership(name) {
  const dir = buildDir(name);
  const p = path.join(dir, 'start.sh');
  if (!fs.existsSync(p)) return false;
  let content = fs.readFileSync(p, 'utf8');
  const branchRe = /^\s*chown -R 1000:1000 \/root 2>\/dev\/null.*$/m;
  const narrowRe = /^\s*chown -R 1000:1000 \/root\/\.\w+.*$/m;
  const isUserMode = branchRe.test(content) || narrowRe.test(content);
  let changed = false;
  if (isUserMode && !content.includes(HOME_EARLY_MARKER)) {
    const anchor = /^\/usr\/sbin\/sshd &\n/m;
    if (anchor.test(content)) {
      content = content.replace(anchor, `$&${HOME_EARLY_BLOCK}\n`);
      changed = true;
    }
  }
  if (narrowRe.test(content)) {
    content = content.replace(narrowRe, HOME_OWNERSHIP_BLOCK);
    changed = true;
  }
  if (!changed) return false;
  fs.writeFileSync(p, content, { mode: 0o755 });
  ensureOwned(p);
  return true;
}

/** Whether the baked /usr/local/bin/start.sh gives the pad user the home via
 *  the EARLY pass (i.e. the image was built from a start.sh containing the
 *  plan-79 pre-hook chown). Greps the distinctive early marker so a pad that
 *  only has the late in-branch chown still rebuilds once. Used by
 *  `applyAgentChanges` to decide whether an existing user-mode pad needs a
 *  rebuild to pick it up (backfilled via ensureHomeOwnership). */
async function imageHomeOwnershipBaked(name, image, wasRunning) {
  return imageProbe(name, image, wasRunning, `grep -q '${HOME_EARLY_MARKER}' /usr/local/bin/start.sh`);
}

// ─── User-mode web-hook drop (plan 89) ──────────────────────────────────────
// The web start hook is machine-managed but lives on disk (instances/<pad>/
// <agent>/start-web.sh) and is NOT baked into the image, so an already-published
// PAD keeps its old root-launching hook until something rewrites it. That is the
// file that created a root-owned `opencode` state dir at boot and again on every
// publish re-apply. `ensureWebHookUserDrop` regenerates it from the current
// `buildWebHook` template when it lacks the marker, and is called from both the
// webui boot sweep (so an existing PAD is fixed on restart, no apply needed) and
// `applyAgentChanges` (the publish path). Regeneration preserves the web
// password by reading it back through `readWebAuth`, which parses the very hook
// being replaced.

/** Rewrite an instance's `start-web.sh` to carry the plan-89 user-mode drop.
 *  Returns true when a rewrite happened. No-op when: no hook (never published),
 *  no web binding, the marker is already present, or the driver has no webApp —
 *  every one of those is "there is nothing here to fix", not a failure. The
 *  marker check is the cheap gate; `buildWebHook` output is the canonical form. */
function ensureWebHookUserDrop(name, agent) {
  let driver;
  try { driver = getDriverOr(agent); } catch { return false; }
  if (!driver || !driver.webApp || typeof driver.webApp.startCommand !== 'function') return false;
  const p = webHookPath(name, driver.type);
  if (!fs.existsSync(p)) return false;
  let content;
  try { content = fs.readFileSync(p, 'utf8'); } catch { return false; }
  if (content.includes(WEB_USER_DROP_MARKER)) return false;
  const web = readWebService(name);
  if (!web) return false;
  let password = '';
  try { password = readWebAuth(driver, name); } catch {}
  const fresh = buildWebHook(driver, agent, web, password);
  try {
    fs.writeFileSync(p, fresh, { mode: 0o755 });
    ensureOwned(p);
  } catch { return false; }
  return true;
}

/** Boot sweep (plan 89): rewrite every already-published PAD's `start-web.sh`
 *  that predates the user-mode drop, so an existing PAD is fixed on a webui
 *  restart without a settings apply. Skips hidden/quarantine dirs and any dir
 *  without an AGENT. Returns the pads that changed (empty is the normal case). */
function migrateWebHooks() {
  const changed = [];
  let names = [];
  try { names = fs.readdirSync(INSTANCES_DIR); } catch { return changed; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const dir = path.join(INSTANCES_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const meta = readMeta(dir) || {};
      if (!meta.AGENT) continue;
      if (ensureWebHookUserDrop(name, meta.AGENT)) changed.push(name);
    } catch {}
  }
  return changed;
}

/** One-time migration for PADs created before per-instance build files. Each
 *  instance missing a `build/` dir gets: build dir seeded from the shared
 *  template, the running image retagged into its per-instance tag (no rebuild),
 *  and its compose regenerated + recreated so the container now runs under its
 *  own tag. Idempotent: instances with a build dir are skipped, and the whole
 *  thing re-runs safely (a partially-migrated PAD just continues). */
async function ensureInstanceBuilds({ onLog = () => {} } = {}) {
  const results = { seeded: [], skipped: [], errors: [] };
  if (!fs.existsSync(INSTANCES_DIR)) return results;
  for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // Only real PAD dirs. A legacy `<pad>-door` dir is a forwarding sidecar,
    // not an agent — seeding it an image tag, a build dir and a compose (and
    // with it a subnet-pool reservation) is pure waste, and it races the
    // stale-door sweep that quarantines it. `STALE_DOOR_DIR` is the sweep's own
    // parking lot, which matches neither shape.
    if (!VM_NAME_RE.test(name) || isManagedDoorContainer(name)) {
      results.skipped.push(`${name} (not a pad)`);
      continue;
    }
    const instDir = path.join(INSTANCES_DIR, name);
    // A dir without `meta.env` is not a pad — discovery ignores it too. Seeding
    // it would invent an openclaw pad (`AGENT` absent → 'openclaw'), write a
    // compose + meta.env, and reserve a subnet for a container that never
    // existed. Seen on a fresh clone whose only `instances/` content was a
    // stray agent data dir.
    if (!fs.existsSync(path.join(instDir, 'meta.env'))) {
      results.skipped.push(`${name} (no meta.env)`);
      continue;
    }
    const meta = readMeta(instDir);
    const agent = meta.AGENT || 'openclaw';
    if (!fs.existsSync(buildTemplateDir(agent))) {
      results.skipped.push(`${name} (no template for '${agent}')`);
      continue;
    }
    if (fs.existsSync(buildDir(name))) {
      results.skipped.push(name);
      continue;
    }
    try {
      const allowDocker = meta.DOCKER === '1';
      seedBuildDir(name, agent, { installDocker: allowDocker });
      onLog('system', `[migrate] seeded build dir for ${name}`);

      // Retag, don't rebuild — the running image is preserved instantly.
      try {
        await runCmd('docker', ['tag', legacySharedImage(agent), imageFor(name)], { timeout: 30000 });
        onLog('system', `[migrate] retagged ${legacySharedImage(agent)} → ${imageFor(name)}`);
      } catch (e) {
        onLog('system', `[migrate] retag skipped for ${name} (${e.message})`);
      }

      // Regenerate the compose with the per-instance context + image + args,
      // preserving the network peer, web binding and SSH port.
      const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
      const port = meta.PORT || '';
      const network = meta.NETWORK || '';
      const webService = readWebService(name);
      let webPeerNetwork = '';
      if (webService && network) webPeerNetwork = await getPeerNetworkName(network);
      writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });

      // Recreate only when the container exists; leave stopped agents stopped.
      let running = false;
      try {
        const r = await runCmd('docker', ['inspect', name, '--format', '{{.State.Status}}'], { timeout: 15000 });
        running = (r.stdout || '').trim() === 'running';
      } catch {}
      if (running) {
        await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 180000 });
        onLog('system', `[migrate] recreated ${name} under ${imageFor(name)}`);
      }
      results.seeded.push(name);
    } catch (e) {
      results.errors.push({ name, error: e.message });
    }
  }
  return results;
}

Object.assign(exports, { POST_START_MARKER });
