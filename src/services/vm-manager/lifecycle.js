/**
 * Create, update, recreate, start, stop, reset and remove a PAD, plus the image
 * and container probes those steps use.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  imageProbe, psStateMap, psNames, isContainerRunning, removeInstanceDir, imageHasDockerCli,
  imageHasSshPortSupport, imageHasWebStartSupport, updateAgent, createVm, removeVm, resetVm,
  recreateAgent, getComposePath, existingServices, startAgent, stopAgent, restartAgent,
  effectiveUserMode, validateAgentCreate, createAgent, workspaceSourceRemoval,
});

const fs = require('fs');
const path = require('path');
const { runCmdStream } = require('../cmd');
const { imageFor, buildDir, setBuildEnv, writeCustomBuild } = require('../instance-image');
const { ensureOwned, normalizeTree, isSelfManagedAgentData, USER_UID, USER_GID, mkdirOwned } = require('../ownership');
const devcontainer = require('../devcontainer');
const {
  readMeta, INSTANCES_DIR, PREFIX_RE, runCmd, DEFAULT_SSH_CPORT, WORKSPACE, PREFIX, getDriver,
  instanceComposePath, VM_NAME_RE, hasDriver, HOST_WORKSPACE,
  assertRootPassword, assertPort,
} = require('./internal');
const {
  validateExtraVolumes, validateWorkspaceMount, containerViewOf, workspaceMountInfo,
} = require('./workspace-mount');
const {
  seedBuildDir, buildProjectImage, writePostCreateScript, writePostStartScript,
  writePostAttachScript, postCreateScriptPath,
} = require('./build-files');
const { runCompose, writeInstanceCompose, autoSshPort, validateExtraPorts } = require('./compose');
const { getPeerNetworkName, startDoors, stopDoors } = require('./doors-network');
const { resolveDevContainerPlan, generateWorkspaceDevContainer, padsOnSameWorkspace } = require('./devcontainer');
const {
  readWebService, resolveWebRequest, webServicePath, writeWebStartHook, buildWebHook,
  applyWebAuth, webPortReachable, hostPortInUse,
} = require('./web');

/** Rebuild the image (--pull to redownload the base) and recreate the
 *  container. The recreate restarts it automatically when it's done.
 *  `buildArgs` are passed as `--build-arg K=V` (ad-hoc overrides; the instance
 *  build.env is the preferred place for ARG values). Set `pull: false` to skip
 *  redownloading the base image. */
async function updateAgent(name, { onLog = () => {}, onStep = () => {}, buildArgs = [], pull = true } = {}) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  const agent = meta.AGENT || 'openclaw';
  // Each PAD owns its build dir + image tag — no shared-image bookkeeping, so
  // nothing is force-appended to the build args anymore. The rebuild reads the
  // instance Dockerfile + build.env (via the compose env-file) directly.
  seedBuildDir(name, agent, { installDocker: meta.DOCKER === '1' });
  const args = ['build'];
  if (pull) args.push('--pull');
  for (const ba of buildArgs) args.push('--build-arg', ba);
  args.push(name);
  onStep('build', 'start');
  try {
    await runCompose(name, args, { stream: true, onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    throw e;
  }
  onStep('build', 'end');

  onStep('recreate', 'start', `docker compose -f instances/${name}/docker-compose.yml up -d --force-recreate`);
  try {
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 300000 });
  } catch (e) {
    onStep('recreate', 'error');
    throw e;
  }
  onStep('recreate', 'end');
  onStep('cleanup', 'start', 'docker image prune -f');
  await pruneDanglingImages(onLog);
  onStep('cleanup', 'end');
}

/** Recreate a container with optional extras (the Settings "Recreate Container"
 *  card). `pull` re-downloads the base image + rebuilds before recreating;
 *  `reset` wipes the ENTIRE user data dir (instances/<name>/<agent> — config,
 *  sessions, sqlite, workspace) so the container starts completely fresh.
 *  Bindings are preserved: docker socket, network peer, published web app +
 *  door, custom workspace, extra volumes/ports (all re-read from meta). */
async function recreateAgent(name, { pull = false, reset = false, onLog = () => {}, onStep = () => {} } = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';
  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  const allowDocker = meta.DOCKER === '1';
  const network = meta.NETWORK || '';

  if (pull) {
    seedBuildDir(name, agent, { installDocker: allowDocker });
    onStep('build', 'start');
    try {
      await runCompose(name, ['build', '--pull', name], { stream: true, onLog, timeout: 900000 });
    } catch (e) {
      onStep('build', 'error');
      throw e;
    }
    onStep('build', 'end');
  }

  if (reset) {
    onStep('reset', 'start', `docker rm -f ${name} && rm -rf instances/${name}/${agent}/*`);
    try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
    const agentDir = path.join(instDir, agent);
    await removeInstanceDir(name, agentDir);
    fs.mkdirSync(agentDir, { recursive: true });
    ensureOwned(agentDir);
    seedBuildDir(name, agent, { installDocker: allowDocker });
    // Preserve the COMPLETE persisted binding set (mirrors resetVm).
    const webService = readWebService(name);
    let webPeerNetwork = '';
    if (network) webPeerNetwork = await getPeerNetworkName(network);
    writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });
    onStep('reset', 'end');
  }

  onStep('recreate', 'start', `docker compose -f instances/${name}/docker-compose.yml up -d --force-recreate`);
  try {
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 300000 });
  } catch (e) {
    onStep('recreate', 'error');
    throw e;
  }
  onStep('recreate', 'end');
  onStep('cleanup', 'start', 'docker image prune -f');
  await pruneDanglingImages(onLog);
  onStep('cleanup', 'end');
}

function existingServices() {
  const names = new Set();
  if (!fs.existsSync(INSTANCES_DIR)) return names;
  for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const composeFile = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
      if (fs.existsSync(composeFile)) names.add(entry.name);
    }
  }
  return names;
}

/** Resolve the effective Container user for a pad (plan 43 Phase 7 + plan 41
 *  item 17). An explicit caller value wins; when omitted, seed from the
 *  devcontainer plan's userMode preference (non-root → 'user'). hermes is
 *  always root-mode (its daemon already runs as its own user). */
function effectiveUserMode(userMode, dcPlan, agent) {
  if (userMode !== undefined) return userMode === 'user' ? 'user' : '';
  if (agent === 'hermes') return '';
  return dcPlan && dcPlan.userMode === 'user' ? 'user' : '';
}

async function createVm(name, options = {}) {
  const {
    agent = 'openclaw', mode = 'fresh', cloneSource = '',
    sshEnabled = false, port = '', password = '', sshCport = '',
    onLog = () => {}, onStep = () => {}, skipSetup = false,
    workspaceHost = '', workspaceDir = '',
    allowDocker = false, network = '',
    extraVolumes = null, extraPorts = null,
    userMode,
    buildCommands = '', postCreate = '', postStart = '', postAttach = '',
    generateDevContainer = true,
    web = null,
  } = options;

  if (existingServices().has(name)) {
    throw new Error(`Agent '${name}' already exists`);
  }
  const instDir = path.join(INSTANCES_DIR, name);
  if (fs.existsSync(path.join(instDir, 'meta.env'))) {
    throw new Error(`Agent '${name}' already exists`);
  }

  assertRootPassword(password);
  assertPort(port, 'SSH port');
  const pw = password || name.replace(PREFIX_RE, '');
  let finalPort = '';
  if (sshEnabled) {
    finalPort = port || autoSshPort();
  }
  const sshCportRaw = String(sshCport || '').trim();
  const finalCport = /^\d+$/.test(sshCportRaw) && +sshCportRaw >= 1 && +sshCportRaw <= 65535
    ? sshCportRaw
    : DEFAULT_SSH_CPORT;

  // Validate EVERYTHING up front (plan 28) so a bad request aborts with a
  // clear error and leaves nothing behind: network peer must exist and run,
  // extra volumes/ports must pass the guards, and the custom workspace mount
  // must be valid. The route already checked host-port availability against
  // other agents before returning 202; here we re-check the pure constraints.
  if (network) {
    if (network === name) throw new Error('Cannot route an agent through itself');
    let running = false;
    try {
      const r = await runCmd('docker', ['inspect', network, '--format', '{{.State.Status}}'], { timeout: 15000 });
      running = (r.stdout || '').trim() === 'running';
    } catch {}
    if (!running) throw new Error(`Container '${network}' is not running`);
  }
  const extraVols = validateExtraVolumes(name, agent, extraVolumes);
  const extraPs = validateExtraPorts(extraPorts, { sshPort: finalPort });

  // Web publish at create time (no second recreate, no rebuild): validated up
  // front so a bad request aborts before anything is written to disk.
  const webService = await resolveWebRequest(name, agent, web, {
    sshHostPort: finalPort,
    extraPorts: extraPs,
  });

  // Custom workspace bind (plan 24): validate BEFORE writing meta/compose so a
  // bad request aborts with a clear error and leaves nothing behind. `wsMount`
  // is `{ host, container, webuiVisible, hostBrowsable }` or null.
  const wsMount = workspaceHost || workspaceDir
    ? validateWorkspaceMount(name, agent, workspaceHost, workspaceDir)
    : null;

  // Devcontainer plan (plan 41 items 12–16): resolve the workspace's
  // devcontainer.json into the effective compose plan (workspaceFolder, env,
  // mounts, runArgs, forwardPorts) and persist it — this also surfaces invalid
  // mounts/runArgs as clear create-time errors. Persisted so a later settings
  // apply or compose regen reads the same stable mapping (forwardPorts keep
  // their allocated host ports).
  const dcPlan = wsMount
    ? resolveDevContainerPlan(name, agent, wsMount, { allocatePorts: true, excludeHostPorts: [finalPort] })
    : null;

  // Container user (plan 43 Phase 7): an explicit caller value (web form toggle
  // or MCP arg) wins; when the caller does NOT pass one, seed the default from
  // the devcontainer's declared user (plan 41 item 17) — a non-root
  // remoteUser/containerUser means the pad should run as the pad user.
  const effUserMode = effectiveUserMode(userMode, dcPlan, agent);

  const agentDataDir = path.join(instDir, agent);
  fs.mkdirSync(agentDataDir, { recursive: true });
  ensureOwned(instDir);
  ensureOwned(agentDataDir);
  onLog('system', `Created instance directory: ${instDir}`);

  // Create the host workspace source up front so a fresh mount has somewhere to
  // land. Only when the source is under the project root — the webui is the
  // only thing that can create dirs there (host sources outside HOST_WORKSPACE
  // are expected to already exist, e.g. a shared data drive).
  let workspaceCreatedHere = false;
  if (wsMount && wsMount.webuiVisible) {
    const view = containerViewOf(wsMount.host);
    if (view && !fs.existsSync(view)) {
      mkdirOwned(view, { boundary: WORKSPACE });
      workspaceCreatedHere = true;
      onLog('system', `Created workspace source: ${wsMount.host}`);
    }
  }

  // Project image (plan 41 item 10): build the workspace devcontainer's
  // `build`/`image` as `paddock-proj-<name>:latest` BEFORE the compose build so
  // the build-commands box can `COPY --from=paddock-proj-<name>:latest ...` by
  // tag (an `AS` alias does not work — lesson O39). Best-effort: a workspace without a devcontainer build
  // silently skips; a failed build aborts the create job visibly.
  if (wsMount && devcontainer.hasDevContainer(containerViewOf(wsMount.host) || '')) {
    onStep('project-image', 'start', `Build project image for ${name}`);
    try {
      await buildProjectImage(name, wsMount.host, { onLog });
    } catch (e) {
      onStep('project-image', 'error');
      await pruneDanglingImages(onLog);
      throw e;
    }
    onStep('project-image', 'end');
  }

  if (mode === 'clone') {
    // Clone is type-locked: a clone inherits the source's build files + data
    // dir, so it must be the SAME agent type. When no source is given, pick the
    // most recent same-type instance instead of blindly taking the latest.
    const candidates = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => n.startsWith(PREFIX + '-'))
      .sort().reverse();
    let src = cloneSource || '';
    if (!src) {
      src = candidates.find((n) => (readMeta(path.join(INSTANCES_DIR, n)).AGENT || 'openclaw') === agent) || '';
    }
    if (!src) throw new Error(`No '${agent}' source VM available to clone`);
    const srcMeta = readMeta(path.join(INSTANCES_DIR, src));
    const srcAgent = srcMeta.AGENT || 'openclaw';
    if (srcAgent !== agent) {
      throw new Error(`Cannot clone '${src}' (type=${srcAgent}) into '${name}' (type=${agent}) — clones must share the same agent type`);
    }
    const srcDir = path.join(INSTANCES_DIR, src, srcAgent);
    if (fs.existsSync(srcDir)) {
      onLog('system', `Cloning workspace from ${src}…`);
      for (const entry of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, entry);
        const dstPath = path.join(agentDataDir, entry);
        if (fs.statSync(srcPath).isDirectory()) {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
      onLog('system', `Cloned workspace from ${src}`);
      normalizeTree(agentDataDir, (dir) => isSelfManagedAgentData(dir, INSTANCES_DIR));
    } else {
      throw new Error(`Source workspace for '${src}' not found`);
    }
    // Same-type clones inherit the source's build files (customizations too) —
    // they still get their OWN image tag via imageFor(name).
    const srcBuildDir = buildDir(src);
    if (fs.existsSync(srcBuildDir)) {
      fs.cpSync(srcBuildDir, buildDir(name), { recursive: true });
      normalizeTree(buildDir(name));
      onLog('system', `Cloned build files from ${src}`);
    }
    // The clone inherits the source's build.env; the docker toggle still needs
    // to reflect the requested state for THIS clone.
    setBuildEnv(name, { INSTALL_DOCKER: allowDocker ? '1' : '0' });
  } else {
    seedBuildDir(name, agent, { installDocker: allowDocker });
  }

  // Build commands (plan 41): inject the web-managed Dockerfile block AFTER
  // seeding so a custom `ARG` line is picked up by argsFromDockerfile on the
  // compose regen below; write the post-create script for the running-container
  // setup step later in this job.
  if (String(buildCommands).trim()) writeCustomBuild(name, String(buildCommands));
  if (String(postCreate).trim()) writePostCreateScript(name, String(postCreate));
  if (String(postStart).trim()) writePostStartScript(name, String(postStart));
  if (String(postAttach).trim()) writePostAttachScript(name, String(postAttach));

  // Devcontainer generation (plan 41 item 18): when the workspace has no
  // devcontainer.json, generate one mirroring the pad's effective config
  // (workspaceFolder, lifecycle commands, mounts, forwardPorts, remoteUser),
  // marked `x-paddock.generated` so later Settings changes write back into it.
  // Default on; opt out via `generateDevContainer: false` (the create form
  // toggle, plan 41 item 20).
  const generatedDc = generateWorkspaceDevContainer(name, agent, wsMount, {
    postCreate, postStart, postAttach,
    extraVols, extraPs,
    userMode: effUserMode,
    enabled: generateDevContainer !== false,
  });
  if (generatedDc) onLog('system', 'Generated .devcontainer/devcontainer.json for the workspace');

  let metaTxt = `ROOT_PASSWORD=${pw}\nAGENT=${agent}\n`;
  if (finalPort) metaTxt += `PORT=${finalPort}\n`;
  if (finalCport !== DEFAULT_SSH_CPORT) metaTxt += `SSH_CPORT=${finalCport}\n`;
  metaTxt += `DOCKER=${allowDocker ? '1' : '0'}\n`;
  if (network) metaTxt += `NETWORK=${network}\n`;
  // Container user (plan 43 Phase 7): USER_MODE=user makes the daemon run as
  // the `pad` user (PUID:PGID) so agent-written files are user-owned by
  // construction. Written BEFORE the compose regen below (it reads the flag).
  if (effUserMode === 'user') metaTxt += `USER_MODE=user\n`;
  // Workspace mount flags MUST be written before writeInstanceCompose — the
  // compose generator reads them from meta to emit the extra bind.
  if (wsMount) metaTxt += `WORKSPACE_HOST=${wsMount.host}\nWORKSPACE_DIR=${wsMount.container}\n`;
  // Recorded so a later delete removes ONLY a folder this create made. A
  // folder that already existed (the repo, docs/, another PAD's source) is the
  // user's and is never deleted with the PAD.
  if (wsMount && workspaceCreatedHere) metaTxt += 'WORKSPACE_CREATED=1\n';
  if (dcPlan) metaTxt += `DC_PLAN=${JSON.stringify(dcPlan)}\n`;
  // Extra volumes / ports (plan 28): single-line JSON, read back by the
  // compose generator (readExtraVolumes/readExtraPorts) on every regen path.
  if (extraVols.length) metaTxt += `EXTRA_VOLUMES=${JSON.stringify(extraVols)}\n`;
  if (extraPs.length) metaTxt += `EXTRA_PORTS=${JSON.stringify(extraPs)}\n`;
  fs.writeFileSync(path.join(instDir, 'meta.env'), metaTxt);
  ensureOwned(path.join(instDir, 'meta.env'));

  // Peer mode: resolve the peer's bridge network so the socat door (SSH + extra
  // ports) is emitted on the right network — the host-mode door fallback would
  // forward to 127.0.0.1 and reach nothing for a bridge-networked peer.
  let webPeerNetwork = '';
  if (network) {
    webPeerNetwork = await getPeerNetworkName(network);
  }

  // Web publish (part of the create): persist the binding + write the start-web
  // hook BEFORE the compose regen so the published port (and the peer-mode door
  // that carries it) is part of the very first `up`. The hook sits in the
  // bind-mounted agent data dir, so no image rebuild is involved.
  if (webService) {
    const wp = webServicePath(name);
    fs.writeFileSync(wp, JSON.stringify({
      containerPort: webService.containerPort,
      hostPort: webService.hostPort,
      authToken: webService.authToken || '',
    }, null, 2));
    ensureOwned(wp);
    const wDriver = getDriver(agent);
    await writeWebStartHook(name, agent, buildWebHook(wDriver, agent, webService, webService.password));
    onLog('system', `Web app will be published on host port ${webService.hostPort} (no extra recreate needed)`);
  }

  writeInstanceCompose(name, agent, pw, finalPort, { allowDocker, network, webService, webPeerNetwork });

  const composePath = instanceComposePath(name);

  onStep('build', 'start');
  try {
    await runCompose(name, ['build'], { stream: true, onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    await pruneDanglingImages(onLog);
    throw e;
  }
  onStep('build', 'end');

  onStep('up', 'start');
  try {
    await runCompose(name, ['up', '-d'], { stream: true, onLog, timeout: 300000 });
  } catch (e) {
    onStep('up', 'error');
    await pruneDanglingImages(onLog);
    throw e;
  }
  onStep('up', 'end');
  await pruneDanglingImages(onLog);

  const driver = getDriver(agent);
  const setupSteps = driver.setupSteps || [];
  // User-mode pads run their setup steps as the pad user (PUID:PGID) so the
  // config files they write are born user-owned — a root-run setup would leave
  // root-owned files the user-level daemon then can't overwrite.
  const userArgs = effUserMode === 'user' ? ['-u', `${USER_UID}:${USER_GID}`] : [];
  if (setupSteps.length && !skipSetup) {
    onStep('setup', 'start');
    let allReady = true;
    for (const step of setupSteps) {
      let ready = false;
      for (let i = 0; i < 15; i++) {
        try {
          await runCmdStream('docker', ['exec', ...userArgs, name, step.cmd, ...(step.args || [])], { onLog, timeout: 60000 });
          ready = true;
          break;
        } catch {
          if (i === 14) break;
          onLog('system', `Container not ready yet (attempt ${i + 1}/15), waiting…`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!ready) { allReady = false; break; }
    }
    if (!allReady) {
      onStep('setup', 'error');
      throw new Error(`Container '${name}' did not become ready for setup`);
    }
    onStep('setup', 'end');
  }

  // Post-create commands (plan 41): run the per-instance post-create.sh ONCE,
  // streamed into the create log, right after the driver setup steps (same
  // readiness-retry loop — the container may still be finishing boot). Runs as
  // the pad user in user-mode pads so files it writes are born user-owned.
  const postCreatePath = postCreateScriptPath(name);
  if (fs.existsSync(postCreatePath)) {
    const pcCmd = `docker exec ${userArgs.length ? userArgs.join(' ') + ' ' : ''}${name} /build/post-create.sh`;
    onStep('post-create', 'start', pcCmd);
    let ran = false;
    for (let i = 0; i < 15; i++) {
      try {
        const script = path.join('/build', 'post-create.sh');
        await runCmdStream('docker', ['exec', ...userArgs, name, script], { onLog, timeout: 600000 });
        ran = true;
        break;
      } catch {
        if (i === 14) break;
        onLog('system', `Post-create: container not ready yet (attempt ${i + 1}/15), waiting…`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!ran) {
      onStep('post-create', 'error');
      throw new Error(`Post-create script did not run on container '${name}'`);
    }
    onStep('post-create', 'end');
  }

  if (setupSteps.length && !skipSetup) {
    await runCmdStream('docker', ['restart', name], { onLog, timeout: 30000 });
  }

  // Web publish, finalized (create path): the driver's config now exists, so the
  // gateway auth patch can land, then re-exec the start-web hook and confirm the
  // app is actually serving. Same order as `applyAgentChanges`' publish: patch
  // config → exec hook → verify.
  if (webService) {
    const wDriver = getDriver(agent);
    await applyWebAuth(name, wDriver, webService.password);
    onStep('web-verify', 'start', `docker exec ${name} ${wDriver.dataDir}/start-web.sh`);
    await runCmd('docker', ['exec', name, 'bash', `${wDriver.dataDir}/start-web.sh`], { timeout: 20000 }).catch(() => {});
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      if (await webPortReachable(name, webService.containerPort)) up = true;
      else await new Promise((r) => setTimeout(r, 1000));
    }
    onStep('web-verify', 'end');
    if (up) {
      onLog('system', `Web app is live at http://${process.env.HOST_NAME || 'localhost'}:${webService.hostPort}`);
    } else {
      throw new Error(`Web server did not come up on port ${webService.containerPort} (see container web.log)`);
    }
  }

  return name;
}

/** Pre-flight validation for a create request — the shared gate behind both
 *  `POST /api/agents/create` and the MCP `create_agent` tool (plan 30 rule #1:
 *  business logic lives here, REST + MCP are thin adapters). Runs the same
 *  checks the route used to do inline so both callers abort with identical
 *  errors BEFORE any 202/job is emitted. `createVm` re-checks everything
 *  internally too (it must — clone uses it), so this is a clean early abort,
 *  not the only line of defense. Throws with a user-facing message.
 *  Returns the normalized `{ sshHostPort, sshCport, wsMount }` that `createVm`
 *  expects (auto-allocated SSH host port, validated container port, validated
 *  workspace mount). */
async function validateAgentCreate(name, opts = {}) {
  const {
    agent = 'openclaw', sshEnabled = false, port = '', sshContainerPort = '',
    workspaceHost = '', workspaceDir = '', network = '',
    extraVolumes = null, extraPorts = null,
    userMode = '',
  } = opts;

  if (!VM_NAME_RE.test(name)) throw new Error('Invalid agent name');
  if (!hasDriver(agent)) throw new Error(`Unknown agent type '${agent}'`);
  if (userMode === 'user' && agent === 'hermes') {
    throw new Error('Hermes already runs its daemon as its own user (/opt/data, uid 10000) — the Container user option does not apply');
  }

  // Build commands / lifecycle scripts sanity (plan 41): reject NUL bytes
  // (would corrupt the Dockerfile/script) and cap length so a runaway payload
  // can't bloat the per-instance build files. Runs on create AND on every
  // settings apply via prepareAgentChanges' shared guard below.
  for (const [label, text] of [
    ['Build commands', opts.buildCommands],
    ['Post-create commands', opts.postCreate],
    ['Post-start commands', opts.postStart],
    ['Post-attach commands', opts.postAttach],
  ]) {
    if (text === undefined || text === null) continue;
    if (/\0/.test(String(text))) throw new Error(`${label} cannot contain NUL bytes`);
    if (String(text).length > 100000) throw new Error(`${label} are too long (max 100000 characters)`);
  }

  if (network) {
    if (network === name) throw new Error('Cannot route an agent through itself');
    let running = false;
    try {
      const r = await runCmd('docker', ['inspect', network, '--format', '{{.State.Status}}'], { timeout: 15000 });
      running = (r.stdout || '').trim() === 'running';
    } catch {}
    if (!running) throw new Error(`Container '${network}' is not running`);
  }

  let sshHostPort = '';
  if (sshEnabled) sshHostPort = port || autoSshPort();
  const sshCportRaw = String(sshContainerPort || '').trim();
  const sshCportValid = /^\d+$/.test(sshCportRaw) && +sshCportRaw >= 1 && +sshCportRaw <= 65535;
  if (sshEnabled && sshCportRaw && !sshCportValid) {
    throw new Error('SSH container port must be an integer between 1 and 65535');
  }

  // Pure constraints first (these throw synchronously inside createVm too).
  validateExtraVolumes(name, agent, extraVolumes);
  const extraPs = validateExtraPorts(extraPorts, { sshPort: sshHostPort });
  const wsMount = workspaceHost || workspaceDir
    ? validateWorkspaceMount(name, agent, workspaceHost, workspaceDir)
    : null;
  // Devcontainer plan (plan 41 items 12–16): surface invalid mounts/runArgs
  // here (pre-202) instead of inside the create job. No port allocation — that
  // happens once in createVm so the persisted mapping is stable.
  if (wsMount) {
    resolveDevContainerPlan(name, agent, wsMount, { allocatePorts: false, excludeHostPorts: [sshHostPort] });
  }

  // Async cross-agent host-port availability across the whole request: the
  // optional SSH port, every extra port and the optional web port together,
  // before anything is made.
  for (const hp of [...extraPs.map((p) => p.host), sshHostPort].filter(Boolean)) {
    if (await hostPortInUse(hp, name)) {
      throw new Error(`Host port ${hp} is already in use by another agent`);
    }
  }

  // Web publish on create — same validator createVm uses, so both abort with an
  // identical message before any 202/job is emitted.
  const webService = await resolveWebRequest(name, agent, opts.web, {
    sshHostPort,
    extraPorts: extraPs,
  });

  return { sshHostPort, sshCport: sshCportValid ? sshCportRaw : '', wsMount, webService };
}

/** Create a PAD — validate, then `createVm` (seed build dir → write meta +
 *  compose → build per-instance image → compose up → run driver setup steps →
 *  restart). The shared path behind both the REST create route and the MCP
 *  `create_agent` tool. Accepts the same `createVm` options plus the raw
 *  request fields (sshEnabled/port/sshContainerPort/workspaceHost/
 *  workspaceDir); normalizes them exactly like the route used to before
 *  delegating. Returns the created PAD name. */
/** Remove what a failed create left: its container, doors, network, instance
 *  folder and image. Never the workspace source. Best-effort, and it reports
 *  what it could not remove instead of hiding the original error. */
async function removeFailedCreate(name, instDir, log) {
  const quiet = async (args) => { try { await runCmd('docker', args, { timeout: 30000 }); } catch { /* nothing there */ } };
  await quiet(['rm', '-f', name]);
  await quiet(['rm', '-f', `${name}-door`]);
  await quiet(['rm', '-f', `${name}-web`]);
  await quiet(['network', 'rm', `${name}_default`]);
  try {
    if (fs.existsSync(instDir)) await removeInstanceDir(name, instDir);
    log('system', `Create failed; removed the partial ${name} so the name can be used again`);
  } catch (cleanupErr) {
    log('system', `Create failed, and its leftovers could not be removed: ${cleanupErr.message}`);
  }
  await quiet(['rmi', imageFor(name)]);
}

async function createAgent(name, opts = {}) {
  const v = await validateAgentCreate(name, opts);
  const instDir = path.join(INSTANCES_DIR, name);
  const existedBefore = fs.existsSync(instDir);
  try {
    return await createVm(name, {
      ...opts,
      mode: 'fresh',
      sshEnabled: !!opts.sshEnabled,
      port: v.sshHostPort,
      sshCport: v.sshCport,
      workspaceHost: v.wsMount ? v.wsMount.host : '',
      workspaceDir: v.wsMount ? v.wsMount.container : '',
    });
  } catch (err) {
    // A create that failed part-way (a build error, a port taken at the last
    // moment) used to leave instances/<name>/ behind: the PAD then "existed",
    // could not be created again under that name, and had to be deleted by
    // hand. Remove what this attempt made. The workspace source is left alone:
    // only a successful PAD's delete may ever remove one.
    if (!existedBefore) await removeFailedCreate(name, instDir, typeof opts.onLog === 'function' ? opts.onLog : () => {});
    throw err;
  }
}
/** Remove an instance directory (or an agent data dir inside it). The webui
 *  container runs as root (plan 43), so a plain `fs.rmSync` can always delete
 *  the data — the old root-helper-container wipe and EACCES/EPERM handling are
 *  gone. */
async function removeInstanceDir(name, instDir) {
  if (!fs.existsSync(instDir)) return;
  fs.rmSync(instDir, { recursive: true, force: true });
}

/**
 * May deleting a PAD also delete its workspace source folder? Pure, so the
 * rule can be tested without touching a disk.
 *
 * It used to be "any source under the project root and outside the PAD's data
 * dir", which deleted the whole repository when a PAD had mounted it, deleted
 * docs/ or .git when a PAD pointed there, and wiped a folder a second PAD was
 * still using. Now: only a folder the create itself made, that nobody else
 * mounts, and that is strictly inside the project root without containing
 * instances/.
 */
function workspaceSourceRemoval({ createdByPaddock, view, workspaceRoot, instancesDir, sharedWith = [] }) {
  if (!view) return { remove: false, why: 'it is not visible to the control plane' };
  if (!createdByPaddock) return { remove: false, why: 'it existed before this PAD was created' };
  if (sharedWith.length) return { remove: false, why: `${sharedWith.join(', ')} still use${sharedWith.length === 1 ? 's' : ''} it` };
  const v = path.resolve(view);
  const root = path.resolve(workspaceRoot);
  const inst = path.resolve(instancesDir);
  const contains = (outer, inner) => inner === outer || inner.startsWith(outer + path.sep);
  if (!contains(root, v) || v === root) return { remove: false, why: 'it is not a folder inside the project root' };
  if (contains(v, inst)) return { remove: false, why: 'it contains the instances folder' };
  return { remove: true, why: '' };
}

async function removeVm(name) {
  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
  // The socat door container (<name>-door, or the legacy <name>-web) survives
  // `docker rm` of the agent and would keep holding its host ports forever —
  // drop both forms.
  for (const suffix of ['-door', '-web']) {
    try { await runCmd('docker', ['rm', '-f', name + suffix], { timeout: 30000 }); } catch {}
  }
  try { await runCmd('docker', ['network', 'rm', `${name}_default`], { timeout: 30000 }); } catch {}
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir) || {};
  const agent = meta.AGENT || 'openclaw';
  // Custom workspace source (plan 24): when the mount lives OUTSIDE the agent's
  // data dir but still under the project root, remove it so the delete leaves
  // no orphan folder. Sources inside the data dir are deleted with it; sources
  // outside HOST_WORKSPACE are never touched.
  if (meta.WORKSPACE_HOST) {
    try {
      const info = workspaceMountInfo(name, agent, meta.WORKSPACE_HOST, meta.WORKSPACE_DIR || '');
      const dataHost = path.join(HOST_WORKSPACE, 'instances', name, agent);
      if (info.webuiVisible && info.host !== dataHost && !info.host.startsWith(dataHost + path.sep)) {
        const view = containerViewOf(info.host);
        const verdict = workspaceSourceRemoval({
          createdByPaddock: meta.WORKSPACE_CREATED === '1',
          view,
          workspaceRoot: WORKSPACE,
          instancesDir: INSTANCES_DIR,
          sharedWith: padsOnSameWorkspace(name, meta.WORKSPACE_HOST),
        });
        if (verdict.remove && fs.existsSync(view)) fs.rmSync(view, { recursive: true, force: true });
        else if (!verdict.remove) console.log(`[delete ${name}] workspace source ${info.host} kept: ${verdict.why}`);
      }
    } catch {}
  }
  await removeInstanceDir(name, instDir);
  // The per-instance image is this PAD's own tag — drop it too, otherwise every
  // create/delete cycle leaks a paddock-vm-<name>:latest image.
  try { await runCmd('docker', ['rmi', imageFor(name)], { timeout: 30000 }); } catch {}
  // ...and sweep any dangling layers the tag shared or left behind.
  await pruneDanglingImages();
}

/** Reclaim disk from orphaned image layers. `docker compose build` retags the
 *  per-PAD image, orphaning every previous build as a dangling `<none>` image;
 *  failed creates and interrupted jobs leak whole images. A dangling prune is
 *  safe (only touches `<none>` layers no container references) and a cheap
 *  no-op when there's nothing to reclaim. Never throws; reports freed space. */
async function pruneDanglingImages(onLog = () => {}) {
  try {
    const r = await runCmd('docker', ['image', 'prune', '-f'], { timeout: 120000 });
    const m = /Total reclaimed space:\s*([0-9.]+[kMGT]?B)/i.exec(r.stderr || r.stdout || '');
    if (m) onLog('system', `Reclaimed ${m[1]} from dangling image layers`);
  } catch (e) {
    onLog('system', `Image prune skipped: ${e.message || e}`);
  }
}

async function resetVm(name) {
  const instDir = path.join(INSTANCES_DIR, name);
  const metaPath = path.join(instDir, 'meta.env');
  if (!fs.existsSync(metaPath)) throw new Error(`VM '${name}' does not exist`);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';

  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
  const agentDir = path.join(instDir, agent);
  await removeInstanceDir(name, agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  ensureOwned(agentDir);

  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  const allowDocker = meta.DOCKER === '1';
  const network = meta.NETWORK || '';
  seedBuildDir(name, agent, { installDocker: allowDocker });
  // Preserve the COMPLETE persisted binding set (plan 28 fix): docker, network
  // peer, published web app (+ its door), custom workspace, and the extra
  // volumes/ports in meta — the compose generator reads them all from meta, so
  // resetting the data dir must never silently drop a bind.
  const webService = readWebService(name);
  let webPeerNetwork = '';
  if (network) webPeerNetwork = await getPeerNetworkName(network);
  writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });

  const composePath = instanceComposePath(name);
  await runCompose(name, ['up', '-d'], { timeout: 120000 });
}

function getComposePath(name) {
  return instanceComposePath(name);
}

async function startAgent(name) {
  try {
    await runCmd('docker', ['start', name], { timeout: 30000 });
  } catch {
    // Stale network peer (e.g. gluetun was rebuilt) — `docker start` can't
    // rejoin the old `container:<id>` namespace. Recreate via compose so the
    // peer re-resolves by name to the current container.
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { timeout: 180000 });
  }
  await startDoors(name);
}

/** Stop the agent container and its socat door(s) together. The door only
 *  forwards to the agent's ports inside the peer namespace, so it is useless
 *  while the agent is down — stop it so it isn't a stray open listener. No-op
 *  for already-stopped containers (errors swallowed). */
async function stopAgent(name) {
  // A container that is already gone has nothing left to stop. Any other
  // failure (daemon unreachable, timeout) is reported: swallowing it made the
  // route answer ok for a PAD that was still running.
  let failure = null;
  try {
    await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 });
  } catch (e) {
    if (!/No such container/i.test(String(e.stderr || e.message || ''))) failure = e;
  }
  await stopDoors(name);
  if (failure) throw new Error(`Could not stop ${name}: ${String(failure.stderr || failure.message).trim().split('\n').pop()}`);
}

/** Restart the agent and bring its socat door(s) back up. */
async function restartAgent(name) {
  try {
    await runCmd('docker', ['restart', '-t', '30', name], { timeout: 60000 });
  } catch {
    // Same recovery as startAgent: a stale network peer cannot be rejoined by
    // id, so recreate through compose. If that fails too, the error is the
    // caller's to see (it used to be swallowed and reported as a restart).
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { timeout: 180000 });
  }
  await startDoors(name);
}

// ─── Shared orchestrator + reads (plan 30) ────────────────────────────────
// Business logic lives here so the Express routes (app.js) AND the MCP tools
// (mcp.js) are thin adapters over the SAME functions. Never duplicate a flow
// between REST and MCP.

async function psNames() {
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30000 });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

async function psStateMap() {
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}'], { timeout: 15000 });
  const map = {};
  for (const line of (r.stdout || '').trim().split('\n')) {
    if (!line) continue;
    const [n, s] = line.split('\t');
    if (n) map[n] = s;
  }
  return map;
}

/** Whether the agent container is currently `running`. */
async function isContainerRunning(name) {
  try {
    const r = await runCmd('docker', ['inspect', name, '--format', '{{.State.Status}}'], { timeout: 15000 });
    return (r.stdout || '').trim() === 'running';
  } catch {
    return false;
  }
}

/** Run a probe script inside the agent's image and report whether it exits 0.
 *  Uses `docker exec` when the container is genuinely UP, else spins a
 *  throwaway container from `image`.
 *
 *  The live-state check is a correctness fix, not an optimization:
 *  `applyAgentChanges` STOPPES the container (step 4) BEFORE it probes (step 6)
 *  while the caller's `wasRunning` flag still reads true — so a flag-driven
 *  `docker exec` would target a stopped container, always fail, and make every
 *  toggle look like "the image needs a rebuild". `runCmd` rejects on a non-zero
 *  exit, so success is the resolve, never `r.code`. */
async function imageProbe(name, image, wasRunning, script) {
  try {
    const up = !!wasRunning && await isContainerRunning(name);
    await (up
      ? runCmd('docker', ['exec', name, 'sh', '-lc', script], { timeout: 15000 })
      : runCmd('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-lc', script], { timeout: 60000 }));
    return true;
  } catch {
    return false;
  }
}

/** Whether the baked image's start.sh ships the docker CLI (settings toggle:
 *  enabling docker on an image without it triggers a rebuild). Shared by the
 *  app.js settings route and `applyAgentChanges`. */
async function imageHasDockerCli(name, image, wasRunning) {
  return imageProbe(name, image, wasRunning, 'command -v docker');
}

/** Whether the baked /usr/local/bin/start.sh knows to honor the SSH_PORT env
 *  (i.e. the image was built from a start.sh containing the SSH_PORT block).
 *  Shared by the app.js settings route and `applyAgentChanges`. */
async function imageHasSshPortSupport(name, image, wasRunning) {
  return imageProbe(name, image, wasRunning, 'grep -q SSH_PORT /usr/local/bin/start.sh');
}

/** Whether the baked /usr/local/bin/start.sh runs the web start-hook (i.e. the
 *  image was built from a start.sh containing the web start block). Used by
 *  `applyAgentChanges` to decide whether publishing web on a pre-hook PAD needs
 *  a rebuild (backfilled via ensureWebStartBlock). */
async function imageHasWebStartSupport(name, image, wasRunning) {
  return imageProbe(name, image, wasRunning, 'grep -q start-web.sh /usr/local/bin/start.sh');
}
