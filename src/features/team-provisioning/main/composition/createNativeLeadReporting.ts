import { createNodeLeadReporting } from '@features/lead-reporting/main';

import { DeliverPersistedLeadRequest } from '../../core/application/commands/DeliverPersistedLeadRequest';
import { NodeLeadInputDeliveryStore } from '../adapters/output/NodeLeadInputDeliveryStore';
import { NodeLeadRequestHistory } from '../adapters/output/NodeLeadRequestHistory';

import type { LeadRequestDeliveryReceipt, TeamRunIdentity } from '../../contracts';
import type { NativeTeamLifecycle } from './createNativeTeamLifecycle';
import type { NodeLeadReporting } from '@features/lead-reporting/main';

interface Dependencies {
  lifecycle: Pick<
    NativeTeamLifecycle,
    | 'resolveLeadCredential'
    | 'snapshot'
    | 'queries'
    | 'taskChanges'
    | 'sendLeadMessage'
    | 'canReplayLeadInput'
  >;
  reporting: Omit<
    Parameters<typeof createNodeLeadReporting>[0],
    'resolveLead' | 'lifecycle' | 'taskChanges' | 'delivered'
  >;
  contextInvalidationSignal(run: Readonly<TeamRunIdentity>): AbortSignal;
}

export interface NativeLeadReporting {
  readonly reporting: Pick<NodeLeadReporting, 'reports' | 'reply'>;
  submitHumanRequest(
    run: Readonly<TeamRunIdentity>,
    requestMessageId: string,
    text: string
  ): Promise<LeadRequestDeliveryReceipt>;
  deliverPersistedHumanRequest(
    run: Readonly<TeamRunIdentity>,
    requestMessageId: string
  ): Promise<LeadRequestDeliveryReceipt>;
}

function sameRun(a: Readonly<TeamRunIdentity>, b: Readonly<TeamRunIdentity>): boolean {
  return (
    a.appInstanceId === b.appInstanceId &&
    a.dataRootFingerprint === b.dataRootFingerprint &&
    a.connectionGeneration === b.connectionGeneration &&
    a.teamName === b.teamName &&
    a.runId === b.runId
  );
}

/** Couples the existing reporting feature to persisted turn delivery, never to terminal acknowledgements. */
export function createNativeLeadReporting(deps: Dependencies): NativeLeadReporting {
  const assertCurrent = (run: Readonly<TeamRunIdentity>): void => {
    deps.contextInvalidationSignal(run).throwIfAborted();
    const current = deps.lifecycle.snapshot(run.teamName);
    if (!sameRun(current.identity, run) || current.desired !== 'running')
      throw new Error('Human request team run is no longer current');
  };
  const history = new NodeLeadRequestHistory({
    teamsRoot: deps.reporting.teamsRoot,
    assertCurrent,
    leadName: (run) => {
      const lead = Object.values(deps.lifecycle.snapshot(run.teamName).members).find(
        (member) => member.role === 'lead' && member.membership === 'configured'
      );
      if (!lead) throw new Error('Configured lead is unavailable');
      return lead.memberName;
    },
  });
  const requests = new DeliverPersistedLeadRequest({
    assertCurrent,
    read: (run, id) => history.read(run, id),
    readDelivered: (run, id) => history.readDelivered(run, id),
    input: new NodeLeadInputDeliveryStore({
      teamsRoot: deps.reporting.teamsRoot,
      assertCurrent,
      readDelivered: (run, id) => history.readDelivered(run, id),
    }),
    accept: (request) => reporting.acceptHumanRequest(request),
    canReplayUnconfirmed: (run) => deps.lifecycle.canReplayLeadInput(run),
    send: (run, text, operationId) =>
      deps.lifecycle.sendLeadMessage(run, text, undefined, operationId),
  });
  const reporting = createNodeLeadReporting({
    ...deps.reporting,
    resolveLead: (credential) => deps.lifecycle.resolveLeadCredential(credential),
    lifecycle: async (run) => {
      const snapshot = await deps.lifecycle.queries.snapshot({
        expectedContext: run,
        teamName: run.teamName,
      });
      return snapshot && sameRun(snapshot.identity, run) ? snapshot : null;
    },
    taskChanges: ({ run, task }) =>
      deps.lifecycle.taskChanges.read({
        expectedContext: run,
        teamName: run.teamName,
        taskId: task.id,
        projectPath: task.projectPath,
        includeDetails: true,
      }),
    delivered: (run, report) =>
      requests.confirmDelivered(run, report.requestMessageId, report.messageId),
  });
  return {
    reporting: Object.freeze({
      reports: reporting.reports,
      reply: (credential, requestMessageId, text) =>
        reporting.reply(credential, requestMessageId, text),
    }),
    submitHumanRequest: async (identity, requestMessageId, text) => {
      const run = Object.freeze({ ...identity });
      assertCurrent(run);
      await history.persist({
        run,
        requestMessageId,
        text,
        origin: { kind: 'human' },
        isMeta: false,
      });
      assertCurrent(run);
      return requests.execute(run, requestMessageId);
    },
    deliverPersistedHumanRequest: (run, requestMessageId) =>
      requests.execute(run, requestMessageId),
  };
}
