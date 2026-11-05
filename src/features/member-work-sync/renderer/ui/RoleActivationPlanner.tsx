import { useEffect, useId, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible';
import { Input } from '@renderer/components/ui/input';

import { normalizeMemberName } from '../../core/domain/memberName';
import { planRoleActivation } from '../../core/domain/RoleActivationPlan';
import { useRolePlannerSnapshot } from '../hooks/useRolePlannerSnapshot';
import { isPlannerSnapshotTrusted, projectRuntimeForRolePlan } from '../rolePlannerRuntime';

import type {
  KanbanState,
  ResolvedTeamMember,
  TeamAgentRuntimeSnapshot,
  TeamTask,
} from '@shared/types';

interface RoleActivationPlannerProps {
  teamName: string;
  teamAlive: boolean;
  tasks: TeamTask[];
  members: ResolvedTeamMember[];
  kanbanState: KanbanState;
  currentRuntime?: TeamAgentRuntimeSnapshot;
}

function confirmationStamp(member: ResolvedTeamMember): string {
  return JSON.stringify([
    member.providerId,
    member.providerBackendId,
    member.model,
    member.status,
    member.currentTaskId,
    member.runtimeAdvisory,
    member.removedAt,
  ]);
}

export const RoleActivationPlanner = ({
  teamName,
  teamAlive,
  tasks,
  members,
  kanbanState,
  currentRuntime,
}: RoleActivationPlannerProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState('3');
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const { snapshot, loading, failed, now, refresh } = useRolePlannerSnapshot(teamName, open);

  const trusted = isPlannerSnapshotTrusted(snapshot, currentRuntime, teamName, now);
  useEffect(() => {
    if (!trusted) setConfirmations({});
  }, [trusted]);
  const runtime = useMemo(() => projectRuntimeForRolePlan(snapshot, trusted), [snapshot, trusted]);
  const activeMembers = useMemo(() => members.filter((member) => !member.removedAt), [members]);
  const validLimit =
    /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit)) && Number(limit) > 0;
  const plan = useMemo(() => {
    if (!validLimit) return null;
    const reviewers = Object.fromEntries(
      Object.entries(kanbanState.tasks).map(([taskId, state]) => [taskId, state.reviewer])
    );
    return planRoleActivation({
      teamName,
      teamAlive,
      runtimeSnapshotTrusted: trusted,
      runningRuntimeMembers: runtime.runningRuntimeMembers,
      leadRuntimeMembers: runtime.leadRuntimeMembers,
      runtimeOccupancyUncertain: runtime.runtimeOccupancyUncertain,
      maxConcurrentRoles: Number(limit),
      members: activeMembers.map((member) => ({
        name: member.name,
        agentType: member.agentType,
        providerId: member.providerId,
        model: member.model,
        role: member.role,
        runtime: runtime.stateFor(member.name),
        currentTaskId: member.currentTaskId,
        busy: member.status === 'active',
        workloadUnknown: member.status === 'unknown',
        availabilityConfirmed:
          trusted && confirmations[normalizeMemberName(member.name)] === confirmationStamp(member),
        availabilityBlocked: Boolean(member.runtimeAdvisory) || member.status === 'terminated',
      })),
      tasks: tasks.map((task) => ({ ...task, kanbanColumn: kanbanState.tasks[task.id]?.column })),
      kanbanReviewersByTaskId: reviewers,
    });
  }, [
    activeMembers,
    confirmations,
    kanbanState,
    limit,
    runtime,
    tasks,
    teamAlive,
    teamName,
    trusted,
    validLimit,
  ]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mb-3 rounded-md border border-[var(--color-border)]"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start"
          aria-label={t('rolePlanner.title')}
        >
          {t('rolePlanner.title')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t border-[var(--color-border)] p-3 text-sm">
        <p className="text-[var(--color-text-muted)]">{t('rolePlanner.description')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={`${id}-limit`} className="space-y-1">
            <span className="block">{t('rolePlanner.limit')}</span>
            <Input
              id={`${id}-limit`}
              type="number"
              min="1"
              step="1"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              className="w-28"
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setConfirmations({});
              void refresh();
            }}
            disabled={loading}
          >
            {t('rolePlanner.refresh')}
          </Button>
        </div>
        {!validLimit && <p role="alert">{t('rolePlanner.invalidLimit')}</p>}
        {loading && <p role="status">{t('rolePlanner.loading')}</p>}
        {failed && <p role="alert">{t('rolePlanner.refreshFailed')}</p>}
        {!loading && !trusted && !failed && <p role="status">{t('rolePlanner.stale')}</p>}
        {plan && (
          <p>
            {t('rolePlanner.capacity', {
              running: plan.runningRoles,
              projected: plan.projectedRoles,
              limit: plan.maxConcurrentRoles,
            })}
          </p>
        )}
        {plan?.capacityUncertain && (
          <p className="text-[var(--color-text-muted)]">{t('rolePlanner.capacityUncertain')}</p>
        )}
        <p className="text-[var(--color-text-muted)]">{t('rolePlanner.confirmationHelp')}</p>
        <ul className="space-y-2">
          {activeMembers.map((member, index) => {
            const key = normalizeMemberName(member.name);
            const state = runtime.stateFor(member.name);
            const blocked = Boolean(member.runtimeAdvisory) || member.status === 'terminated';
            const checkboxId = `${id}-member-${index}`;
            return (
              <li key={`${key}-${index}`} className="flex items-center gap-2">
                <Checkbox
                  id={checkboxId}
                  disabled={!trusted || state === 'unknown' || blocked}
                  checked={trusted && !blocked && confirmations[key] === confirmationStamp(member)}
                  onCheckedChange={(checked) =>
                    setConfirmations((previous) => ({
                      ...previous,
                      [key]: checked === true ? confirmationStamp(member) : '',
                    }))
                  }
                />
                <label htmlFor={checkboxId}>
                  {t('rolePlanner.confirmMember', { name: member.name })}
                </label>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {t(`rolePlanner.${state}`)}
                </span>
              </li>
            );
          })}
        </ul>
        {plan?.rows.length === 0 && <p>{t('rolePlanner.empty')}</p>}
        {plan && plan.rows.length > 0 && (
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {plan.rows.map((row) => (
              <li key={row.taskId} className="rounded border border-[var(--color-border)] p-2">
                <strong>
                  {row.displayId ?? row.taskId}: {row.subject}
                </strong>
                <span>
                  {' '}
                  · {t(`rolePlanner.${row.kind}`)} · {row.memberName ?? '—'}
                </span>
                <p className="text-[var(--color-text-muted)]">
                  {row.decision === 'recommend' ? (
                    <>
                      {t('rolePlanner.recommended')} ·{' '}
                      {t(row.usesExistingSlot ? 'rolePlanner.existingSlot' : 'rolePlanner.newSlot')}
                    </>
                  ) : (
                    <>
                      {t('rolePlanner.deferred')} ·{' '}
                      {row.reason && t(`rolePlanner.reasons.${row.reason}`)}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
};
