import { createHash, randomUUID } from 'node:crypto';

import { LeadReporting } from '../../core/application/LeadReporting';
import { sameRun } from '../../core/domain/reportFacts';
import { NodeLeadReportDelivery } from '../adapters/output/NodeLeadReportDelivery';
import { NodeLeadReportSources } from '../adapters/output/NodeLeadReportSources';
import { LeadRequestReporting } from '../application/LeadRequestReporting';

import type { DeliveredLeadReport, LeadReportRunIdentity } from '../../contracts';
import type { TeamLifecycleSnapshot } from '@features/team-provisioning/contracts';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TaskChangeSetV2, TeamTask } from '@shared/types';

interface Dependencies {
  teamsRoot: string;
  members: Pick<TeamMembersMetaStore, 'getMeta'>;
  resolveLead(credential: string): LeadReportRunIdentity;
  lifecycle(run: LeadReportRunIdentity): Promise<Readonly<TeamLifecycleSnapshot> | null>;
  /** Canonical team tasks read by the app; the controller projects this snapshot. */
  tasks(run: LeadReportRunIdentity): Promise<readonly TeamTask[]>;
  taskChanges(input: {
    run: LeadReportRunIdentity;
    task: TeamTask;
  }): Promise<TaskChangeSetV2 | null>;
  leadName(run: LeadReportRunIdentity): Promise<string>;
  delivered(run: LeadReportRunIdentity, report: DeliveredLeadReport): void;
  changed(teamName: string): void;
}

export interface NodeLeadReporting {
  readonly reports: LeadReporting;
  acceptHumanRequest(input: Parameters<LeadRequestReporting['accept']>[0]): Promise<string>;
  reply(
    credential: string,
    requestMessageId: string,
    text: string
  ): Promise<{
    messageId: string;
    requestMessageId: string;
  }>;
}

/** Receives the lifecycle's existing authority and queries, not a second process registry. */
export function createNodeLeadReporting(deps: Dependencies): NodeLeadReporting {
  const now = (): string => new Date().toISOString();
  // One source budget stays below the controller's HTTP timeout (30s) with headroom.
  const maxSourceWaitMs = 10_000;
  const sources = new NodeLeadReportSources({
    teamsRoot: deps.teamsRoot,
    members: deps.members,
    lifecycle: (run) => deps.lifecycle(run),
    tasks: (run) => deps.tasks(run),
    taskChanges: (input) => deps.taskChanges(input),
    now,
  });
  const delivery = new NodeLeadReportDelivery({
    teamsRoot: deps.teamsRoot,
    leadName: (run) => deps.leadName(run),
    tasks: (run) => deps.tasks(run),
    assertCurrentRun: async (run) => {
      const snapshot = await deps.lifecycle(run);
      if (!snapshot || !sameRun(snapshot.identity, run))
        throw new Error('Lead run changed before inbox append');
    },
    delivered: (run, report) => {
      deps.delivered(run, report);
      requests.completed(run, report.requestMessageId, report.messageId);
    },
    changed: (teamName) => deps.changed(teamName),
  });
  const reports = new LeadReporting({
    resolveLead: (credential) => deps.resolveLead(credential),
    sources,
    delivery,
    newId: randomUUID,
    fingerprint: (value) => createHash('sha256').update(value).digest('hex').slice(0, 32),
    now,
    maxInspectionAgeMs: 120_000,
    maxSourceWaitMs,
  });
  const requests = new LeadRequestReporting({
    reports,
    sources,
    delivery,
  });
  return {
    reports,
    acceptHumanRequest: (input) => requests.accept(input),
    reply: (credential, requestMessageId, text) =>
      requests.reply(deps.resolveLead(credential), requestMessageId, text),
  };
}
