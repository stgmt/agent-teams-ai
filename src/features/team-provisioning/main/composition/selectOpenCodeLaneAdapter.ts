import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeAdapterRegistry,
} from '@main/services/team/runtime';

export type OpenCodeLaneAdapter = Pick<
  TeamLaunchRuntimeAdapter,
  'launch' | 'reconcile' | 'stop' | 'answerRuntimePermission' | 'listRuntimePermissions'
>;

/**
 * The production registry is created at startup; the native lifecycle accepts
 * the OpenCode entry only when the adapter is actually registered.
 */
export function selectOpenCodeLaneAdapter(
  source: Pick<TeamRuntimeAdapterRegistry, 'has' | 'get'> | null | undefined
): OpenCodeLaneAdapter | undefined {
  if (!source?.has('opencode')) return undefined;
  return source.get('opencode');
}
