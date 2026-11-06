import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { TeamAgentRuntimeSnapshot } from '@shared/types';

interface RolePlannerSnapshotState {
  snapshot: TeamAgentRuntimeSnapshot | null;
  loading: boolean;
  failed: boolean;
  now: number;
  refresh: () => Promise<void>;
}

export function useRolePlannerSnapshot(teamName: string, open: boolean): RolePlannerSnapshotState {
  const [snapshot, setSnapshot] = useState<TeamAgentRuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setSnapshot(null);
    setFailed(false);
    setLoading(true);
    try {
      const next = await api.teams.getTeamAgentRuntime(teamName);
      if (request === requestId.current) {
        setSnapshot(next);
        setNow(Date.now());
      }
    } catch {
      if (request === requestId.current) setFailed(true);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [teamName]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const sequence = requestId;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      sequence.current++;
      window.clearInterval(timer);
    };
  }, [open, refresh]);
  return { snapshot, loading, failed, now, refresh };
}
