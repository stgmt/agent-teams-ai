import { getErrorMessage } from '@shared/utils/errorHandling';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { isNativeAppManagedBootstrapProvider } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';

import type { TeamCreateRequest } from '@shared/types';

// Work hand-over after a confirmed launch. The native startup context carries no
// Actionable work (see deferredTaskQueue.js in the controller): work in that context
// keeps the runtime in the member's first turn, and the confirmation of the launch
// would not arrive inside the window. Once the app has confirmed the launch it asks
// the controller to put each task into the member's inbox.

export interface StartupWorkDeliveryRun {
  teamName: string;
  allEffectiveMembers: TeamCreateRequest['members'];
}

export interface StartupWorkDeliveryController {
  taskBoard: {
    deliverStartupWork(
      memberName: string,
      options: { launchId: string }
    ): { delivered: readonly unknown[]; skipped: readonly unknown[] };
  };
}

export interface StartupWorkDeliveryPorts<TRun extends StartupWorkDeliveryRun> {
  createController(input: { teamName: string; claudeDir: string }): StartupWorkDeliveryController;
  getClaudeBasePath(): string;
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, text: string): void;
  logger: { warn(message: string): void };
}

export function deliverStartupWorkAfterConfirmation<TRun extends StartupWorkDeliveryRun>(
  run: TRun,
  memberName: string,
  launchAttemptId: string,
  ports: StartupWorkDeliveryPorts<TRun>
): void {
  const member = run.allEffectiveMembers.find((candidate) => candidate.name === memberName);
  // Only members whose startup context was built without the task queue get the
  // hand-over; OpenCode members keep their queue in the context.
  if (
    member &&
    !isNativeAppManagedBootstrapProvider(normalizeOptionalTeamProviderId(member.providerId))
  ) {
    return;
  }
  try {
    const controller = ports.createController({
      teamName: run.teamName,
      claudeDir: ports.getClaudeBasePath(),
    });
    const result = controller.taskBoard.deliverStartupWork(memberName, {
      launchId: launchAttemptId,
    });
    if (result.delivered.length > 0) {
      ports.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        `startup work delivered after launch confirmation: ${result.delivered.length} task message(s)`
      );
    }
  } catch (error) {
    const reason = getErrorMessage(error);
    ports.logger.warn(
      `[${run.teamName}] Startup work delivery failed for "${memberName}": ${reason}`
    );
    ports.appendMemberBootstrapDiagnostic(
      run,
      memberName,
      `startup work delivery failed after launch confirmation: ${reason}`
    );
  }
}
