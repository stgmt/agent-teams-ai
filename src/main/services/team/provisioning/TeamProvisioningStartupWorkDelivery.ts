import { getErrorMessage } from '@shared/utils/errorHandling';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { isNativeAppManagedBootstrapProvider } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';

import type { TeamTask } from '@shared/types';

// Work hand-over after a confirmed launch. The native startup context carries no
// Actionable work (see deferredTaskQueue.js in the controller): work in that context
// keeps the runtime in the member's first turn, and the confirmation of the launch
// would not arrive inside the window. Once the app has confirmed the launch it asks
// the controller to put each task into the member's inbox.

export interface StartupWorkDeliveryRun {
  teamName: string;
  allEffectiveMembers: readonly { name: string; providerId?: string }[];
}

export interface StartupWorkDeliveryController {
  taskBoard: {
    deliverStartupWorkAsync(
      memberName: string,
      options: { launchId: string; isCurrent: () => boolean }
    ): Promise<{
      delivered: readonly unknown[];
      skipped: readonly unknown[];
      cancelled?: true;
    }>;
  };
}

export interface StartupWorkDeliveryPorts<TRun extends StartupWorkDeliveryRun> {
  createController(input: {
    teamName: string;
    claudeDir: string;
    readOnlyTaskSnapshot: TeamTask[];
  }): StartupWorkDeliveryController;
  readTasks(teamName: string): Promise<TeamTask[]>;
  getClaudeBasePath(): string;
  isCurrent(): boolean;
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, text: string): void;
  logger: { warn(message: string): void };
}

export async function deliverStartupWorkAfterConfirmation<TRun extends StartupWorkDeliveryRun>(
  run: TRun,
  memberName: string,
  launchAttemptId: string,
  ports: StartupWorkDeliveryPorts<TRun>
): Promise<number> {
  const member = run.allEffectiveMembers.find((candidate) => candidate.name === memberName);
  // Only members whose startup context was built without the task queue get the
  // hand-over; OpenCode members keep their queue in the context.
  if (
    member &&
    !isNativeAppManagedBootstrapProvider(normalizeOptionalTeamProviderId(member.providerId))
  ) {
    return 0;
  }
  try {
    if (!ports.isCurrent()) return 0;
    const taskSnapshot = await ports.readTasks(run.teamName);
    if (!ports.isCurrent()) return 0;
    const controller = ports.createController({
      teamName: run.teamName,
      claudeDir: ports.getClaudeBasePath(),
      readOnlyTaskSnapshot: taskSnapshot,
    });
    if (!ports.isCurrent()) return 0;
    const result = await controller.taskBoard.deliverStartupWorkAsync(memberName, {
      launchId: launchAttemptId,
      isCurrent: ports.isCurrent,
    });
    return result.delivered.length;
  } catch (error) {
    const reason = getErrorMessage(error);
    ports.logger.warn(
      `[${run.teamName}] Startup work delivery failed for "${memberName}" (${launchAttemptId}): ${reason}`
    );
    ports.appendMemberBootstrapDiagnostic(
      run,
      memberName,
      `startup work delivery failed after launch confirmation for ${launchAttemptId}: ${reason}`
    );
    throw error;
  }
}
