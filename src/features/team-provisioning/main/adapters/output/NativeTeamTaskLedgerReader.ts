import { nativeTeamTaskLedgerProjectDirectory } from '../../infrastructure/nativeTeamTaskLedger';

import type { LifecycleQueries } from '../../../core/application/ports/LifecycleQueries';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TaskChangeSetV2 } from '@shared/types/review';

/** Resolves reads from the same explicit team directory as native launches, never transcript discovery. */
export class NativeTeamTaskLedgerReader {
  constructor(
    private readonly input: {
      teamsRoot: string;
      queries: Pick<LifecycleQueries, 'snapshot'>;
      reader: {
        readTaskChanges(input: {
          teamName: string;
          taskId: string;
          projectDir: string;
          projectPath?: string;
          includeDetails: boolean;
        }): Promise<TaskChangeSetV2 | null>;
      };
    }
  ) {}

  async read(input: {
    expectedContext: AppConnectionContext;
    teamName: string;
    taskId: string;
    projectPath?: string;
    includeDetails: boolean;
  }): Promise<TaskChangeSetV2 | null> {
    const request = Object.freeze({
      ...input,
      expectedContext: Object.freeze({ ...input.expectedContext }),
    });
    const projectDir = nativeTeamTaskLedgerProjectDirectory(this.input.teamsRoot, request.teamName);
    const query = { expectedContext: request.expectedContext, teamName: request.teamName };
    const before = await this.input.queries.snapshot(query);
    if (!before) throw new Error('Native task ledger run is unavailable');
    const result = await this.input.reader.readTaskChanges({
      teamName: request.teamName,
      taskId: request.taskId,
      projectDir,
      projectPath: request.projectPath,
      includeDetails: request.includeDetails,
    });
    const after = await this.input.queries.snapshot(query);
    if (after?.identity.runId !== before.identity.runId)
      throw new Error('Native task ledger run changed during read');
    return result;
  }
}
