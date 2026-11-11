/**
 * The staged settings change: prepare (validate and plan), apply (rebuild or
 * recreate as needed) and roll back.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  prepareAgentChanges, applyAgentChanges,
});

const fs = require('fs');
const path = require('path');
const { runCmdStream } = require('../cmd');
const { imageFor, buildDir, readCustomBuild, writeCustomBuild } = require('../instance-image');
const { ensureOwned, USER_UID, USER_GID } = require('../ownership');
const {
  INSTANCES_DIR, readMeta, getDriverOr, setMetaFlag, runCmd, getDriver,
} = require('./internal');
const {
  readExtraVolumes, readWorkspaceMount, validateWorkspaceMount, validateExtraVolumes,
} = require('./workspace-mount');
const {
  readPostCreate, readPostStart, readPostAttach, ensurePostStartBlock, POST_START_MARKER,
  imageHasPostStartHook, writePostCreateScript, writePostStartScript, writePostAttachScript,
  ensureSshStartBlock, seedBuildDir, ensureWebStartBlock, imageHasPadUser,
  ensureUserModeBuildFiles, imageHomeOwnershipBaked, ensureHomeOwnership, ensureWebHookUserDrop,
  postCreateScriptPath,
} = require('./build-files');
const {
  readSshCport, readExtraPorts, autoSshPort, validateExtraPorts, validateInstanceCompose,
  runCompose,
} = require('./compose');
const { removeDoors, syncDoors } = require('./doors-network');
const { syncDevContainer } = require('./devcontainer');
const { applySettings } = require('./settings');
const {
  readWebService, readWebAuth, hostPortInUse, webServicePath, applyWebAuth, writeWebStartHook,
  buildWebHook, removeWebAuth, removeWebStartHook, webPortReachable,
} = require('./web');
const {
  isContainerRunning, psStateMap, removeInstanceDir, imageHasDockerCli, imageHasSshPortSupport,
  imageHasWebStartSupport, updateAgent,
} = require('./lifecycle');

/** Pure validation + effective-value computation for a consolidated change set
 *  (plan 30). Reads meta, validates every provided option (port bounds,
 *  host-port conflicts, network targets, workspace/volume rules) and returns a
 *  context describing exactly which persisted bindings change. Throws on
 *  invalid input. NO side effects. Shared by the REST routes (synchronous 400
 *  responses) and the MCP `recreate` tool.
 *
 *  Rule: `undefined` for an option MUST preserve the current stored value —
 *  never default it. `[]` / `''` / `false` / `{active:false}` still count as
 *  explicit "clear this". */
async function prepareAgentChanges(name, opts = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  if (!meta.AGENT && !meta.ROOT_PASSWORD) throw new Error(`Agent not found: ${name}`);
  const agentType = meta.AGENT || 'openclaw';
  // Lenient ONLY for a pad with no AGENT line (no type to look up); a line
  // naming an unknown type throws rather than answering openclaw's fields.
  const driver = getDriverOr(meta.AGENT);
  const wasRunning = await isContainerRunning(name);
  const containers = await psStateMap();

  const oldAllow = meta.DOCKER === '1';
  const oldNetwork = meta.NETWORK || '';
  const oldSshPort = meta.PORT || '';
  const oldSshCport = readSshCport(name);
  const oldRootPw = meta.ROOT_PASSWORD || '';
  const oldWeb = readWebService(name);
  const oldVols = readExtraVolumes(name);
  const oldPorts = readExtraPorts(name);
  const oldMount = readWorkspaceMount(name, agentType);
  const oldUserMode = meta.USER_MODE === 'user' ? 'user' : '';
  const oldBuildCommands = readCustomBuild(name);
  const oldPostCreate = readPostCreate(name);
  const oldPostStart = readPostStart(name);
  const oldPostAttach = readPostAttach(name);
  // The existing secret even when NOT yet published: openclaw's token lives in
  // openclaw.json and outlives unpublishes, so a fresh publish can reuse it
  // instead of demanding the user retype it. Env-target drivers have no hook
  // yet when unpublished and return '' — same as before.
  const oldWebPassword = readWebAuth(driver, name);

  if (opts.reset && opts.confirm === false) {
    throw new Error('Refusing to reset without confirm: true (wipes the data dir).');
  }

  // Build commands / lifecycle scripts sanity (plan 41) — same guard as the
  // create path, so the settings route can't write NUL bytes into the build
  // files.
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

  // ── container user (root | user) ──
  let newUserMode = oldUserMode;
  let userModeChanged = false;
  if (opts.userMode !== undefined) {
    newUserMode = opts.userMode === 'user' ? 'user' : '';
    if (newUserMode === 'user' && agentType === 'hermes') {
      throw new Error('Hermes already runs its daemon as its own user (/opt/data, uid 10000) — the Container user option does not apply');
    }
    userModeChanged = newUserMode !== oldUserMode;
  }

  // ── docker socket ──
  const newAllow = opts.allowDocker !== undefined ? !!opts.allowDocker : oldAllow;
  const dockerChanged = newAllow !== oldAllow;

  // ── network peer ──
  let newNetwork = opts.network !== undefined ? (opts.network || '') : oldNetwork;
  if (opts.network !== undefined && newNetwork) {
    if (newNetwork === name) throw new Error('Cannot route an agent through itself');
    const st = containers[newNetwork];
    if (!st) throw new Error(`Container '${newNetwork}' not found`);
    if (st !== 'running') throw new Error(`Container '${newNetwork}' is not running`);
  }
  const networkChanged = newNetwork !== oldNetwork;

  // ── SSH host port (sshEnabled toggles; sshPort alone also sets it) ──
  let newSshPort = oldSshPort;
  let sshChanged = false;
  if (opts.sshEnabled !== undefined || opts.sshPort !== undefined) {
    if (opts.sshEnabled === false) {
      newSshPort = '';
    } else {
      const raw = opts.sshPort !== undefined ? String(opts.sshPort).trim() : '';
      if (raw) {
        if (!/^\d+$/.test(raw) || +raw < 1 || +raw > 65535) {
          throw new Error('SSH host port must be an integer between 1 and 65535');
        }
        newSshPort = raw;
      } else if (!oldSshPort) {
        newSshPort = autoSshPort();
      }
    }
    sshChanged = newSshPort !== oldSshPort;
  }
  if (newSshPort && sshChanged) {
    if (await hostPortInUse(newSshPort, name)) {
      throw new Error(`Host port ${newSshPort} is already in use by another agent`);
    }
    for (const p of oldPorts) {
      if (String(p.host) === String(newSshPort)) {
        throw new Error(`Host port ${newSshPort} is already used by an additional port of this agent`);
      }
    }
    const webH = (opts.web !== undefined ? (opts.web.active ? String(opts.web.hostPort || '') : '') : (oldWeb ? String(oldWeb.hostPort) : ''));
    if (webH && String(webH) === String(newSshPort)) {
      throw new Error(`Host port ${newSshPort} is already the web app host port of this agent`);
    }
  }

  // ── SSH container port (daemon's port inside the container, default 22) ──
  let newSshCport = oldSshCport;
  let sshCportChanged = false;
  if (opts.sshContainerPort !== undefined) {
    const raw = String(opts.sshContainerPort || '').trim();
    if (!/^\d+$/.test(raw) || +raw < 1 || +raw > 65535) {
      throw new Error('SSH container port must be an integer between 1 and 65535');
    }
    newSshCport = raw;
    sshCportChanged = newSshCport !== oldSshCport;
  }

  // ── SSH/root password (empty/absent = keep current) ──
  let newRootPw = '';
  let passwordChanged = false;
  if (typeof opts.sshPassword === 'string' && opts.sshPassword.replace(/[\r\n]/g, '').trim()) {
    newRootPw = opts.sshPassword.replace(/[\r\n]/g, '');
    passwordChanged = newRootPw !== oldRootPw;
  }

  // ── custom workspace (both-or-neither; omitted side falls back to stored) ──
  const reqHost = opts.workspaceHost !== undefined ? opts.workspaceHost : (oldMount ? oldMount.host : '');
  const reqDir = opts.workspaceDir !== undefined ? opts.workspaceDir : (oldMount ? oldMount.container : '');
  let wsMount = null;
  if (reqHost || reqDir) wsMount = validateWorkspaceMount(name, agentType, reqHost, reqDir);
  const oldWsKey = oldMount ? `${oldMount.host}\u0000${oldMount.container}` : '';
  const newWsKey = wsMount ? `${wsMount.host}\u0000${wsMount.container}` : '';
  const workspaceChanged = oldWsKey !== newWsKey;

  // ── extra volumes (full-replace list) ──
  const newVols = opts.extraVolumes !== undefined
    ? validateExtraVolumes(name, agentType, opts.extraVolumes)
    : oldVols;
  const volumesChanged = JSON.stringify(newVols) !== JSON.stringify(oldVols);

  // ── web publish (single binding; omitted fields keep the current ones) ──
  let newWeb = oldWeb;
  let webChanged = false;
  let newWebPassword = oldWebPassword;
  if (opts.web !== undefined) {
    if (!driver.webApp) throw new Error('This agent type has no web app to publish');
    if (opts.web.active) {
      const oldBinding = oldWeb;
      const hPort = opts.web.hostPort !== undefined ? String(opts.web.hostPort).trim() : (oldBinding ? String(oldBinding.hostPort) : '');
      // Fixed-port drivers (openclaw gateway 18789) always publish the driver's
      // declared container port — the UI renders it read-only.
      const cPort = opts.web.containerPort !== undefined && driver.webApp.containerPortEditable !== false
        ? Number(opts.web.containerPort)
        : (oldBinding ? oldBinding.containerPort : (driver.webApp.containerPort || 8080));
      if (!/^\d+$/.test(hPort) || +hPort < 1 || +hPort > 65535) {
        throw new Error('Host port must be a number between 1 and 65535');
      }
      if (!Number.isInteger(cPort) || cPort < 1 || cPort > 65535) {
        throw new Error('Container port must be a number between 1 and 65535');
      }
      const newSshCheck = newSshPort || oldSshPort;
      if (newSshCheck && String(newSshCheck) === hPort) {
        throw new Error(`Host port ${hPort} is already the SSH port of this agent`);
      }
      if (await hostPortInUse(hPort, name)) {
        throw new Error(`Host port ${hPort} is already in use by another agent`);
      }
      newWeb = { containerPort: cPort, hostPort: hPort };
      // Effective auth: a provided password wins. Required-auth drivers
      // (openclaw — fails closed on non-loopback binds) keep their existing
      // token when none is given, and refuse to publish without one.
      if (driver.webApp.auth && driver.webApp.auth.required) {
        const given = opts.web.password !== undefined ? String(opts.web.password) : '';
        if (given) {
          newWebPassword = given;
        } else if (!newWebPassword) {
          throw new Error('A gateway token is required to publish this web app (openclaw refuses to listen outside loopback without auth)');
        }
      } else {
        newWebPassword = opts.web.password !== undefined ? String(opts.web.password) : newWebPassword;
      }
    } else {
      newWeb = null;
    }
    webChanged = (oldWeb ? `${oldWeb.hostPort}:${oldWeb.containerPort}` : '')
      !== (newWeb ? `${newWeb.hostPort}:${newWeb.containerPort}` : '')
      || newWebPassword !== oldWebPassword;
  }

  // ── extra ports (full-replace list; conflict-checked vs ssh + web) ──
  const webHostPort = (opts.web !== undefined
    ? (newWeb ? String(newWeb.hostPort) : '')
    : (oldWeb ? String(oldWeb.hostPort) : ''));
  const newPorts = opts.extraPorts !== undefined
    ? validateExtraPorts(opts.extraPorts, { sshPort: newSshPort, webHostPort })
    : oldPorts;
  const portsChanged = JSON.stringify(newPorts) !== JSON.stringify(oldPorts);
  if (opts.extraPorts !== undefined) {
    for (const p of newPorts) {
      if (await hostPortInUse(p.host, name)) {
        throw new Error(`Host port ${p.host} is already in use by another agent`);
      }
    }
  }

  // ── build commands / post-create / post-start / post-attach (plan 41) ──
  const newBuildCommands = opts.buildCommands !== undefined
    ? String(opts.buildCommands)
    : oldBuildCommands;
  const buildCommandsChanged = newBuildCommands !== oldBuildCommands;
  const newPostCreate = opts.postCreate !== undefined
    ? String(opts.postCreate)
    : oldPostCreate;
  const postCreateChanged = newPostCreate !== oldPostCreate;
  const newPostStart = opts.postStart !== undefined
    ? String(opts.postStart)
    : oldPostStart;
  const postStartChanged = newPostStart !== oldPostStart;
  const newPostAttach = opts.postAttach !== undefined
    ? String(opts.postAttach)
    : oldPostAttach;
  const postAttachChanged = newPostAttach !== oldPostAttach;

  // Enabling post-start on an OLD image (baked start.sh lacks the /build hook)
  // needs a rebuild; post-attach needs no image change (runs via docker exec).
  // `ensurePostStartBlock` returns true only when it INJECTED the block; the
  // instance start.sh may already carry it (newer template) while the built
  // image is stale — that still needs a rebuild, so treat the file already
  // having the marker as a backfill-too.
  let needPostStartBackfill = false;
  if (postStartChanged && newPostStart) {
    needPostStartBackfill = ensurePostStartBlock(name);
    if (!needPostStartBackfill) {
      const sh = path.join(buildDir(name), 'start.sh');
      const alreadyInStartSh = fs.existsSync(sh) && fs.readFileSync(sh, 'utf8').includes(POST_START_MARKER);
      if (alreadyInStartSh) {
        needPostStartBackfill = !(await imageHasPostStartHook(name, imageFor(name), wasRunning));
      } else if (!(await imageHasPostStartHook(name, imageFor(name), wasRunning))) {
        throw new Error('This agent image lacks the post-start hook and start.sh is not patchable — please rebuild via a build-commands change or recreate the agent');
      }
    }
  }

  const changed = dockerChanged || networkChanged || workspaceChanged || volumesChanged
    || sshChanged || sshCportChanged || passwordChanged || portsChanged || webChanged
    || userModeChanged || buildCommandsChanged || postCreateChanged
    || postStartChanged || postAttachChanged;

  const summary = [];
  if (dockerChanged) summary.push(`allowDocker=${newAllow}`);
  if (networkChanged) summary.push(`network=${newNetwork || 'default'}`);
  if (workspaceChanged) summary.push(wsMount ? `workspace=${wsMount.host} → ${wsMount.container}` : 'workspace=default');
  if (volumesChanged) summary.push(`extraVolumes=${newVols.length} mount(s)`);
  if (sshChanged) summary.push(newSshPort ? `ssh=${newSshPort}` : 'ssh=off');
  if (sshCportChanged) summary.push(`ssh container port=${newSshCport}`);
  if (passwordChanged) summary.push('ssh password set');
  if (portsChanged) summary.push(newPorts.length ? `extraPorts=${newPorts.map((p) => `${p.host}→${p.container}`).join(', ')}` : 'extraPorts=none');
  if (webChanged) summary.push(newWeb ? `web=${newWeb.hostPort}→${newWeb.containerPort}` : 'web=off');
  if (userModeChanged) summary.push(`containerUser=${newUserMode || 'root'}`);
  if (buildCommandsChanged) summary.push(newBuildCommands ? 'build commands updated' : 'build commands cleared');
  if (postCreateChanged) summary.push(newPostCreate ? 'post-create updated' : 'post-create cleared');
  if (postStartChanged) summary.push(newPostStart ? 'post-start updated' : 'post-start cleared');
  if (postAttachChanged) summary.push(newPostAttach ? 'post-attach updated' : 'post-attach cleared');

  let reason = 'recreate';
  if (webChanged) reason = 'web';
  else if (portsChanged) reason = 'ports';
  else if (dockerChanged) reason = 'docker';
  else if (networkChanged) reason = 'network';
  else if (sshChanged || sshCportChanged || passwordChanged) reason = 'ssh';
  else if (workspaceChanged) reason = 'workspace';
  else if (volumesChanged) reason = 'volumes';
  else if (userModeChanged) reason = 'user';
  else if (buildCommandsChanged) reason = 'build';
  else if (postCreateChanged) reason = 'post-create';
  else if (postStartChanged) reason = 'post-start';
  else if (postAttachChanged) reason = 'post-attach';

  return {
    instDir, meta, agentType, driver, wasRunning,
    oldAllow, oldNetwork, oldSshPort, oldSshCport, oldRootPw, oldWeb, oldVols, oldPorts, oldMount,
    oldWebPassword, oldUserMode, oldBuildCommands, oldPostCreate, oldPostStart, oldPostAttach,
    newAllow, newNetwork, newSshPort, newSshCport, newRootPw, wsMount, newVols, newPorts, newWeb,
    newWebPassword, newUserMode, newBuildCommands, newPostCreate, newPostStart, newPostAttach,
    dockerChanged, networkChanged, sshChanged, sshCportChanged, passwordChanged,
    workspaceChanged, volumesChanged, portsChanged, webChanged, userModeChanged,
    buildCommandsChanged, postCreateChanged, postStartChanged, postAttachChanged,
    needPostStartBackfill,
    changed, summary, reason,
    effectiveWeb: webChanged ? newWeb : oldWeb,
  };
}

/** Apply a consolidated change set (plan 30) — the FULL flow shared by the REST
 *  settings/web/ports/recreate/update routes AND the MCP `recreate` tool:
 *  validate → persist web hook/binding → `applySettings` (regenerates the
 *  compose with ONLY the specified options) → validateInstanceCompose → stop if
 *  running → wipe data dir (reset) / rebuild (pull, docker-CLI, custom SSH
 *  cport) → force-recreate → reconcile the socat door → re-exec the start-web
 *  hook + verify (web publish) → restore the stopped state. Rolls everything
 *  back on failure. Throws with the failure message. */
async function applyAgentChanges(name, opts = {}, { onLog = () => {}, onStep = () => {} } = {}) {
  const ctx = await prepareAgentChanges(name, opts);

  const {
    instDir, agentType, driver, wasRunning,
    oldAllow, oldNetwork, oldSshPort, oldSshCport, oldRootPw,
    oldWeb, oldVols, oldPorts, oldMount,
    newAllow, newNetwork, newSshPort, newSshCport, newRootPw,
    wsMount, newVols, newPorts, newWeb, newUserMode,
    networkChanged, sshChanged, sshCportChanged, passwordChanged, webChanged,
    userModeChanged, buildCommandsChanged, postCreateChanged, postStartChanged, postAttachChanged,
    newBuildCommands, newPostCreate, newPostStart, newPostAttach,
    needPostStartBackfill,
  } = ctx;
  // User-mode pads run post-create as the pad user so files it writes are born
  // user-owned (same rule as the create-time setup steps).
  const userArgs = newUserMode === 'user' ? ['-u', `${USER_UID}:${USER_GID}`] : [];

  const purePull = !!opts.pull && !ctx.changed && !opts.reset;
  const keepUpThroughBuild = purePull; // pure update keeps the old container up
  // A bare `force` recreate (no option changes) must still stop + force-recreate
  // the container (and its forwarding door) so a missing/stale door comes back.
  const forceRecreate = !!opts.force && !ctx.changed && !opts.pull && !opts.reset;
  let touched = false;
  let runningNow = wasRunning;

  if (!ctx.changed && !opts.pull && !opts.reset && !opts.force) {
    return { ok: true, name, action: 'noop', changed: false, summary: [] };
  }

  // ── draft persistence (plan 39): remember the last-used ports so a toggle
  // off→on re-shows the form pre-filled. Captured *as* a binding is removed
  // (newWeb/newSshPort empty) so the value survives unpublish/unexpose. Only
  // set when non-empty — setMetaFlag clears the line on ''.
  if (webChanged) {
    const lastHost = newWeb ? String(newWeb.hostPort) : (oldWeb ? String(oldWeb.hostPort) : '');
    if (lastHost) setMetaFlag(name, 'WEB_HOST_PORT_LAST', lastHost);
    const lastCport = newWeb ? String(newWeb.containerPort) : (oldWeb ? String(oldWeb.containerPort) : '');
    if (lastCport) setMetaFlag(name, 'WEB_CONTAINER_PORT_LAST', lastCport);
  }
  if (sshChanged) {
    const lastSsh = newSshPort ? String(newSshPort) : (oldSshPort ? String(oldSshPort) : '');
    if (lastSsh) setMetaFlag(name, 'SSH_HOST_PORT_LAST', lastSsh);
  }

  try {
    if (ctx.changed) onLog('system', `Applying changes: ${ctx.summary.join(', ')}`);
    else if (opts.reset) onLog('system', 'Resetting the data dir');
    else if (opts.pull) onLog('system', 'Updating to the latest image');
    else if (forceRecreate) onLog('system', 'Recreating the container');
    else onLog('system', 'Updating to the latest image');

    // ── 1. persist the web binding + start hook (+ config auth for openclaw) ──
    if (webChanged) {
      const p = webServicePath(name);
      if (newWeb) {
        // Persist the auth token too (webui-owned) — stable across recreates
        // even when the agent rewrites its config.
        fs.writeFileSync(p, JSON.stringify({
          containerPort: newWeb.containerPort,
          hostPort: String(newWeb.hostPort),
          authToken: driver.webApp.auth && driver.webApp.auth.urlToken ? String(ctx.newWebPassword || '') : '',
        }, null, 2));
        ensureOwned(p);
        // Patch the config before the recreate (openclaw gateway reads
        // gateway.bind/auth on startup); env-target drivers need nothing here.
        applyWebAuth(name, driver, ctx.newWebPassword);
        onStep('web-hook', 'start', `Write web start hook for ${name}`);
        await writeWebStartHook(name, agentType, buildWebHook(driver, agentType, newWeb, ctx.newWebPassword));
        onStep('web-hook', 'end');
      } else {
        // Unpublish: restore the pre-publish gateway config, drop the hook.
        removeWebAuth(name, driver);
        await removeWebStartHook(name, agentType);
        if (fs.existsSync(p)) fs.rmSync(p);
      }
    }

    // ── 2. regenerate the compose (only the specified options) + validate ──
    if (ctx.changed) {
      // Build commands (plan 41): write the Dockerfile block FIRST so the
      // compose regen picks up any custom `ARG` lines (argsFromDockerfile).
      if (buildCommandsChanged) writeCustomBuild(name, newBuildCommands);
      if (postCreateChanged) writePostCreateScript(name, newPostCreate);
      if (postStartChanged) writePostStartScript(name, newPostStart);
      if (postAttachChanged) writePostAttachScript(name, newPostAttach);
      await applySettings(name, {
        ...(opts.allowDocker !== undefined ? { allowDocker: newAllow } : {}),
        ...(opts.network !== undefined ? { network: newNetwork } : {}),
        ...(opts.workspaceHost !== undefined || opts.workspaceDir !== undefined || ctx.workspaceChanged
          ? { workspaceHost: wsMount ? wsMount.host : '', workspaceDir: wsMount ? wsMount.container : '' }
          : {}),
        ...(opts.extraVolumes !== undefined ? { extraVolumes: newVols } : {}),
        ...(opts.extraPorts !== undefined ? { extraPorts: newPorts } : {}),
        ...(sshChanged ? { sshPort: newSshPort } : {}),
        ...(sshCportChanged ? { sshCport: newSshCport } : {}),
        ...(passwordChanged ? { sshPassword: newRootPw } : {}),
        ...(userModeChanged ? { userMode: newUserMode } : {}),
      });
    }
    await validateInstanceCompose(name);

    // Devcontainer write-back (plan 41 item 19): mirror pad Settings changes
    // (workspace, volumes, ports, lifecycle commands) into the workspace's
    // devcontainer.json in place — generated files regenerate wholesale,
    // project-authored files keep their non-mapped fields. Only when something
    // actually changed; a sync failure never blocks the apply itself.
    if (ctx.changed && wsMount) {
      // syncDevContainer is async (plan 70: the pad-write path). The apply must
      // not await it, but a bare sync call leaves an unhandled rejection
      // parked — route it back into the log stream.
      Promise.resolve(syncDevContainer(name, agentType, wsMount, { onLog }))
        .catch((e) => onLog('system', `Devcontainer sync skipped: ${e.message}`));
    }

    // ── 3. reset: wipe the data dir (kills the container first) ──
    if (opts.reset) {
      onStep('reset', 'start', `docker rm -f ${name} && rm -rf instances/${name}/${agentType}/*`);
      try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
      const agentDir = path.join(instDir, agentType);
      await removeInstanceDir(name, agentDir);
      fs.mkdirSync(agentDir, { recursive: true });
      ensureOwned(agentDir);
      onStep('reset', 'end');
      runningNow = false;
    }

    // ── 4. stop if running (pure pull/reset keep the old container as-is) ──
    if (runningNow && !keepUpThroughBuild && !opts.reset) {
      touched = true;
      onStep('stop', 'start', `docker stop ${name}`);
      await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 });
      onStep('stop', 'end');
    }

    // ── 5. leaving peer mode: the door must go BEFORE the agent recreate ──
    if (oldNetwork && !newNetwork) {
      onLog('system', 'Network is default — removing the forwarding door');
      await removeDoors(name, onLog);
    }

    // ── 6. rebuild (pull / docker-CLI / custom SSH cport) or plain recreate ──
    const image = imageFor(name);
    let needRebuild = false;
    if (newAllow && !oldAllow && !(await imageHasDockerCli(name, image, runningNow))) {
      needRebuild = true;
    }
    let sshRebuild = false;
    if (sshCportChanged && newSshCport !== '22' && newSshPort) {
      if (!(await imageHasSshPortSupport(name, image, runningNow))) {
        sshRebuild = ensureSshStartBlock(name);
      }
    }
    let webRebuild = false;
    if (webChanged && newWeb) {
      if (!(await imageHasWebStartSupport(name, image, runningNow))) {
        seedBuildDir(name, agentType, { installDocker: newAllow });
        webRebuild = ensureWebStartBlock(name, agentType);
      }
    }
    let userRebuild = false;
    if (userModeChanged && newUserMode === 'user') {
      if (!(await imageHasPadUser(name, image, runningNow))) {
        userRebuild = ensureUserModeBuildFiles(name, agentType);
      }
    }
    // An EXISTING user-mode pad's image may predate plan 79 (narrow data-dir
    // chown only): its build/start.sh already carries the pad-user marker, so
    // ensureUserModeBuildFiles above does not regenerate it. Backfill the home
    // chown and rebuild if the baked start.sh lacks the marker. (A root→user
    // toggle is handled by ensureUserModeBuildFiles regenerating from the
    // current template, which already has the chown — its marker makes the
    // backfill below a no-op.)
    let homeRebuild = false;
    if (newUserMode === 'user' && !(await imageHomeOwnershipBaked(name, image, runningNow))) {
      homeRebuild = ensureHomeOwnership(name);
    }
    // Plan 89: the web hook is on disk, not in the image, so an already-published
    // PAD keeps its old root-launching hook until it is rewritten. Not a rebuild
    // trigger — the boot `start.sh` and the publish re-exec read the file fresh.
    ensureWebHookUserDrop(name, agentType);
    let buildRebuild = false;
    if (buildCommandsChanged) {
      // Custom build commands are baked into the image (Dockerfile block) — a
      // change is meaningless until the next build. The block was written above.
      buildRebuild = true;
    }
    // Enabling post-start on an image whose baked start.sh lacks the /build
    // hook requires a rebuild (the hook was backfilled into build/start.sh in
    // prepare if the template was patchable; that only takes effect on build).
    const needRebuildFinal = !!opts.pull || needRebuild || sshRebuild || webRebuild || userRebuild || homeRebuild || buildRebuild || needPostStartBackfill;
    if (needRebuildFinal) {
      const why = opts.pull
        ? 'Updating to the latest base image'
        : needRebuild
          ? 'Image has no docker CLI'
          : sshRebuild
            ? 'start.sh must learn the custom SSH container port'
            : webRebuild
              ? 'start.sh must learn the web start hook'
              : userRebuild
                ? 'Image needs the user-mode (pad user + drop) support'
                : homeRebuild
                  ? 'Image must give the pad user its home (/root)'
                  : needPostStartBackfill
                    ? 'Image needs the post-start hook baked into start.sh'
                    : 'Build commands changed — rebuilding the image';
      onLog('system', `${why} — rebuilding the image, then recreating…`);
      await updateAgent(name, { pull: !!opts.pull, onLog, onStep });
    } else {
      onStep('recreate', 'start', `docker compose -f instances/${name}/docker-compose.yml up -d --force-recreate`);
      await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 300000 });
      onStep('recreate', 'end');
    }

    // ── 6b. post-create re-run (plan 41) — every mutation above recreates the
    // container, so run the persisted hook after every recreation. It lives in
    // the build dir (bind-mounted at /build), so this is a plain docker exec.
    if (fs.existsSync(postCreateScriptPath(name))) {
      const pcCmd = `docker exec ${userArgs.length ? userArgs.join(' ') + ' ' : ''}${name} /build/post-create.sh`;
      onStep('post-create', 'start', pcCmd);
      let ran = false;
      for (let i = 0; i < 15; i++) {
        try {
          await runCmdStream('docker', ['exec', ...userArgs, name, path.join('/build', 'post-create.sh')], { onLog, timeout: 600000 });
          ran = true;
          break;
        } catch {
          if (i === 14) break;
          onLog('system', `Post-create: container not ready yet (attempt ${i + 1}/15), waiting…`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!ran) throw new Error(`Post-create script did not run on container '${name}'`);
      onStep('post-create', 'end');
    }

    // ── 7. door reconcile (peer mode) ──
    if (newNetwork) {
      await syncDoors(name, {
        forceRecreate: networkChanged || webChanged || ctx.portsChanged || sshChanged,
        log: onLog,
      });
    }

    // ── 8. re-exec the start-web hook + verify a published web app ──
    if (ctx.effectiveWeb && runningNow) {
      onStep('web-verify', 'start', `docker exec ${name} ${driver.dataDir}/start-web.sh`);
      const hookPath = `${driver.dataDir}/start-web.sh`;
      await runCmd('docker', ['exec', name, 'bash', hookPath], { timeout: 20000 }).catch(() => {});
      let up = false;
      for (let i = 0; i < 20 && !up; i++) {
        if (await webPortReachable(name, ctx.effectiveWeb.containerPort)) up = true;
        else await new Promise((r) => setTimeout(r, 1000));
      }
      if (up) {
        onLog('system', `Web app re-verified live at http://${process.env.HOST_NAME || 'localhost'}:${ctx.effectiveWeb.hostPort}`);
      } else if (webChanged && newWeb) {
        throw new Error(`Web server did not come up on port ${newWeb.containerPort} (see container web.log)`);
      } else {
        onLog('system', `WARNING: web app not up on port ${ctx.effectiveWeb.containerPort} after the change — re-publish from the Web tab if needed`);
      }
      onStep('web-verify', 'end');
    }

    // ── 9. restore the stopped state (settings changes; pull/reset stay up) ──
    if (!wasRunning && !opts.reset && !opts.pull) {
      try { await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 }); } catch {}
    }

    return {
      ok: true,
      name,
      action: opts.reset ? 'reset' : purePull ? 'updated' : ctx.changed ? 'changed' : 'recreated',
      changed: ctx.changed,
      summary: ctx.summary,
      allowDocker: newAllow,
      network: newNetwork,
      sshPort: newSshPort,
      sshContainerPort: newSshCport,
      workspace: wsMount,
      extraVolumes: newVols,
      extraPorts: newPorts,
      webService: webChanged ? newWeb : oldWeb,
    };
  } catch (e) {
    console.error(`applyAgentChanges failed for ${name}:`, e.message);
    try {
      await rollbackAgentChanges(name, ctx, touched, onLog);
    } catch (rbErr) {
      console.error(`rollback failed for ${name}:`, rbErr.message);
    }
    throw e;
  }
}

/** Undo a failed applyAgentChanges: restore the pre-change compose + web
 *  binding, bring the container back to its original running state, and
 *  reconcile the door (same ordering rule as the happy path — the door must
 *  be gone before an agent recreate when returning to the default network). */
async function rollbackAgentChanges(name, ctx, touched, onLog) {
  const {
    agentType, wasRunning, oldAllow, oldNetwork, oldSshPort, oldSshCport, oldRootPw,
    oldWeb, oldVols, oldPorts, oldMount,
  } = ctx;
  // Restore web.json + hook + gateway config FIRST so the applySettings compose
  // regen (which reads web.json) picks the old binding back up.
  const p = webServicePath(name);
  const driver = getDriver(agentType);
  if (oldWeb) {
    fs.writeFileSync(p, JSON.stringify({ containerPort: oldWeb.containerPort, hostPort: String(oldWeb.hostPort) }, null, 2));
    ensureOwned(p);
    // The old password is the pre-change one (ctx.oldWebPassword), not the
    // current config value — a failed apply may already have patched it. Keep
    // the saved pre-publish state so a later unpublish still restores the
    // original bind/auth.
    const oldPw = ctx.oldWebPassword || readWebAuth(driver, name);
    applyWebAuth(name, driver, oldPw, { preserveState: true });
    await writeWebStartHook(name, agentType, buildWebHook(driver, agentType, oldWeb, oldPw));
  } else {
    removeWebAuth(name, driver);
    await removeWebStartHook(name, agentType);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  await applySettings(name, {
    allowDocker: oldAllow,
    network: oldNetwork,
    workspaceHost: oldMount ? oldMount.host : '',
    workspaceDir: oldMount ? oldMount.container : '',
    extraVolumes: oldVols,
    extraPorts: oldPorts,
    sshPort: oldSshPort,
    sshCport: oldSshCport,
    sshPassword: oldRootPw,
  });
  if (!oldNetwork) await removeDoors(name, onLog);
  if (wasRunning && touched) {
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 180000 });
  }
  if (oldNetwork) await syncDoors(name, { forceRecreate: true, log: onLog });
}
