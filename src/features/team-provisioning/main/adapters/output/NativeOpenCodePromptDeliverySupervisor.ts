import { OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';

import type { TeamRunRegistryRead } from '../../../contracts';
import type { NativeOpenCodeMemberDeliveryPort } from '../input/NativeTeamMessagingApi';

type LaneFact = { readonly laneId: string; readonly runtimeAlive: boolean };

export interface NativeOpenCodePromptDeliverySupervisorDependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'aliveTeamNames'>;
  /** The retained member prompt ledger; this supervisor drives it, never owns it. */
  delivery: Pick<NativeOpenCodeMemberDeliveryPort, 'relayOpenCodeMemberInboxMessages'>;
  readInboxMessages(input: {
    teamName: string;
    memberName: string;
  }): Promise<readonly { messageId?: string; read?: boolean }[]>;
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
  diagnostic(message: string): void;
  getErrorMessage(error: unknown): string;
}

export interface NativeDeliveryVerificationSchedule {
  teamName: string;
  memberName: string;
  messageId: string;
  delayMs?: number;
  isCurrent?: () => boolean;
}

const RECORD_NOT_FOUND_PREFIX = 'OpenCode prompt delivery record not found:';

/**
 * Native driver for the retained OpenCode member prompt ledger.
 *
 * The ledger, its watchdog and its retry ladder stay where they are: they own
 * delivery state, never runs, processes or lanes. What they lacked once the
 * native owner existed was a caller - `TeamProvisioningService` armed every wake
 * and relayed every retry. This supervisor is that caller, and it answers the
 * scheduler from native facts alone:
 *
 * - a team can be delivered to when its run is live and some member still has a
 *   lane whose runtime answered, so a retry is never aimed at a dead host;
 * - a member's identity is the lane the registry observed for it, which is what
 *   the legacy resolution read from its own lane index;
 * - lane activity asks the same observation, by lane id.
 *
 * Recovery before delivery is deliberately absent: the legacy ladder that
 * relaunched an unbootstrapped lane ships disabled by default
 * (`OpenCodePrimaryLaneBootstrapSelfHeal`), so answering "not recovered" leaves
 * the wake queued for a later pass instead of restarting a lead nobody asked to
 * restart.
 */
export class NativeOpenCodePromptDeliverySupervisor {
  private readonly scheduler: OpenCodePromptDeliveryWatchdogScheduler;

  constructor(private readonly deps: NativeOpenCodePromptDeliverySupervisorDependencies) {
    this.scheduler = new OpenCodePromptDeliveryWatchdogScheduler({
      canDeliverToTeamRuntime: (teamName) => this.findTeamLanes(teamName).some((lane) => lane.runtimeAlive),
      recoverBeforeDelivery: async () => false,
      relay: async (input) => {
        const result = await this.deps.delivery.relayOpenCodeMemberInboxMessages(
          input.teamName,
          input.memberName,
          { onlyMessageId: input.messageId, source: 'watchdog' }
        );
        return result.diagnostics ? { diagnostics: result.diagnostics } : {};
      },
      getInboxMessages: (input) =>
        this.deps.readInboxMessages({
          teamName: input.teamName,
          memberName: input.memberName,
        }),
      resolveIdentity: async (input) => {
        const lane = this.findMemberLane(input.teamName, input.memberName);
        return lane ? { ok: true, laneId: lane.laneId } : { ok: false };
      },
      isLaneActive: async (input) => {
        for (const teamName of this.deps.runs.aliveTeamNames()) {
          const lanes = this.findTeamLanes(teamName);
          if (lanes.some((lane) => lane.laneId === input.laneId)) {
            return lanes.some((lane) => lane.laneId === input.laneId && lane.runtimeAlive);
          }
        }
        return false;
      },
      isRecordNotFoundError: (error) =>
        this.deps.getErrorMessage(error).startsWith(RECORD_NOT_FOUND_PREFIX),
      info: (message) => this.deps.info(message),
      warn: (message) => this.deps.warn(message),
      debug: (message) => this.deps.debug(message),
      diagnostic: (message) => this.deps.diagnostic(message),
      getErrorMessage: (error) => this.deps.getErrorMessage(error),
    });
  }

  isEnabled(): boolean {
    return this.scheduler.isEnabled();
  }

  /** Arms one verification pass for a prompt that was just written to a lane. */
  scheduleDeliveryVerification(input: NativeDeliveryVerificationSchedule): void {
    this.scheduler.schedule({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId: input.messageId,
      delayMs: input.delayMs ?? OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
      ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    });
  }

  cancelTeam(teamName: string): void {
    this.scheduler.cancelTeam(teamName);
  }

  private findTeamLanes(teamName: string): LaneFact[] {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) return [];
    const lanes: LaneFact[] = [];
    for (const member of Object.values(snapshot.members)) {
      if (member.lane) lanes.push(member.lane);
    }
    return lanes;
  }

  private findMemberLane(teamName: string, memberName: string): LaneFact | null {
    const snapshot = this.deps.runs.find(teamName);
    return snapshot?.members[memberName]?.lane ?? null;
  }
}
