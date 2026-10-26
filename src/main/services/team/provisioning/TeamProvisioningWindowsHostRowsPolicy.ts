import type { TeamAgentRuntimeBackendType } from '@shared/types';

/**
 * On win32 the process table the runtime snapshot reads by default is WSL's
 * `ps`, which never lists a native Windows process. Two kinds of member run
 * natively and so have to be verified against the Windows host table instead.
 *
 * OpenCode lanes, primary and secondary. With no provisioning run in flight
 * (owner 'none', for example right after an app restart) the recorded pid is
 * all that is left to verify, so the host table is read exactly when such a pid
 * exists: that keeps this an added evidence source and never turns a pid-less
 * registration into a fresh process-table verdict.
 *
 * Direct-process teammates with no runtime adapter (owner 'none'), such as a
 * Claude teammate spawned as `claude-multimodel.exe --team-name ... --agent-id ...`.
 * Their bootstrap heartbeat is refreshed only by activity, so once a teammate
 * idles past the stale window its process is the only liveness evidence left.
 * The host rows are matched by those two flags, not by the recorded pid, so a
 * reused pid is no evidence.
 *
 * `platform` is a parameter rather than a direct `process.platform` read so
 * both sides of the rule are reachable from a test on either platform.
 */
export function shouldReadWindowsHostRowsForMemberLane(params: {
  platform: NodeJS.Platform;
  isOpenCodeLaneMember: boolean;
  backendType: TeamAgentRuntimeBackendType | undefined;
  evidenceOwner: 'primary' | 'secondary' | 'none';
  recordedRuntimePid: number | undefined;
  adapterRuntimeAlive: boolean | undefined;
  adapterBootstrapConfirmed: boolean | undefined;
}): boolean {
  return (
    params.platform === 'win32' &&
    (params.isOpenCodeLaneMember || params.backendType !== 'tmux') &&
    (params.evidenceOwner === 'primary' ||
      (params.evidenceOwner === 'secondary' && params.isOpenCodeLaneMember) ||
      (params.evidenceOwner === 'none' &&
        params.isOpenCodeLaneMember &&
        params.recordedRuntimePid != null) ||
      (params.evidenceOwner === 'none' &&
        !params.isOpenCodeLaneMember &&
        params.backendType === 'process')) &&
    (params.evidenceOwner === 'secondary' ||
      (params.adapterRuntimeAlive !== true && params.adapterBootstrapConfirmed !== true))
  );
}
