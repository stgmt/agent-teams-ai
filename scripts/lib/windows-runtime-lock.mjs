const RELEASE_KIND = 'windows-x64-claude-only';
const CLI_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Validate the owner-fork release without relaxing the upstream lock contract. */
export function validateWindowsRuntimeLock(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) ||
      lock.releaseKind !== RELEASE_KIND) {
    throw new Error('Unsupported runtime release kind');
  }
  const version = lock.version;
  if (lock.schemaVersion !== 1 || typeof version !== 'string' ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      typeof lock.cliVersion !== 'string' || !CLI_VERSION.test(lock.cliVersion) ||
      lock.sourceRepository !== 'stgmt/agent_teams_orchestrator' ||
      lock.releaseRepository !== 'stgmt/agent_teams_orchestrator' ||
      lock.sourceRef !== `refs/tags/v${version}` ||
      lock.releaseTag !== `runtime-v${version}` || lock.targetReleaseTag !== lock.releaseTag ||
      typeof lock.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(lock.sourceCommit) ||
      lock.opencodeV2Delivery !== 'off' || Object.hasOwn(lock, 'opencodeV2')) {
    throw new Error('Invalid Windows Claude-only runtime release identity');
  }
  if (!lock.assets || typeof lock.assets !== 'object' || Array.isArray(lock.assets) ||
      JSON.stringify(Object.keys(lock.assets)) !== JSON.stringify(['win32-x64'])) {
    throw new Error('Windows Claude-only runtime supports exactly win32-x64');
  }
  const asset = lock.assets['win32-x64'];
  if (!asset || asset.file !== `agent-teams-runtime-win32-x64-v${version}.zip` ||
      asset.archiveKind !== 'zip' || asset.binaryName !== 'claude-multimodel.exe' ||
      typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('Invalid Windows Claude-only runtime asset');
  }
}
