/**
 * Options that reach past a PAD into the host, and so belong to an admin.
 *
 *  - allowDocker      mounts the host's docker socket: host root.
 *  - workspace mount  binds a host directory of the caller's choosing.
 *  - extra volumes    the same, several times.
 *  - network peer     joins another container's network namespace.
 *  - build commands   run as root while the image is built, on the host's daemon.
 *
 * A regular user owns their PADs (lifecycle, terminal, files, config, Mission)
 * but may not turn any of these on. The check lives here, once, and is called
 * by every way in: the REST create and settings routes and the MCP create and
 * recreate tools.
 */
class HostPowerError extends Error {
  constructor(names) {
    super(`Only an admin can set: ${names.join(', ')}. Ask an admin, or leave ${names.length > 1 ? 'them' : 'it'} off.`);
    this.name = 'HostPowerError';
    this.code = 'admin_required';
    this.status = 403;
    this.options = names;
  }
}

const filled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : !!v);

/** Host-level options a CREATE request turns on. Accepts both spellings the
 *  REST body (`workspace_host`) and the MCP tool (`workspaceHost`) use. */
function requestedAtCreate(input = {}) {
  const names = [];
  if (input.allowDocker === true || input.allowDocker === 'true' || input.allowDocker === 1 || input.allowDocker === '1') names.push('docker access');
  if (filled(input.workspace_host) || filled(input.workspaceHost)) names.push('a host workspace folder');
  if (filled(input.extraVolumes)) names.push('extra volumes');
  if (filled(input.network)) names.push('a network peer');
  if (filled(input.buildCommands)) names.push('build commands');
  return names;
}

/** Host-level options a SETTINGS change turns on or alters, from the change
 *  set `prepareAgentChanges` computed. Turning one OFF is always allowed, and
 *  so is re-sending the current value (the settings form posts every field). */
function changedInSettings(ctx = {}) {
  const names = [];
  if (ctx.dockerChanged && ctx.newAllow) names.push('docker access');
  if (ctx.workspaceChanged && ctx.wsMount) names.push('a host workspace folder');
  if (ctx.volumesChanged && filled(ctx.newVols)) names.push('extra volumes');
  if (ctx.networkChanged && filled(ctx.newNetwork)) names.push('a network peer');
  if (ctx.buildCommandsChanged && filled(ctx.newBuildCommands)) names.push('build commands');
  return names;
}

function assertAllowed(role, names) {
  if (role !== 'admin' && names.length) throw new HostPowerError(names);
}

module.exports = { HostPowerError, requestedAtCreate, changedInSettings, assertAllowed };
