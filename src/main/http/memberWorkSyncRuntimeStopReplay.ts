const RUNTIME_STOP_REPLAY_LIMIT = 64;
const runtimeStopReplay = new Map<
  string,
  { ok: true; status: unknown; runtimeAdmission: { state: string } }
>();

export function rememberMemberWorkSyncRuntimeStop(
  localStopId: string,
  value?: { ok: true; status: unknown; runtimeAdmission: { state: string } }
) {
  if (value) {
    if (runtimeStopReplay.size >= RUNTIME_STOP_REPLAY_LIMIT) {
      const oldest = runtimeStopReplay.keys().next().value;
      if (oldest) {
        runtimeStopReplay.delete(oldest);
      }
    }
    runtimeStopReplay.set(localStopId, value);
    return value;
  }
  return runtimeStopReplay.get(localStopId);
}
