import { OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';

import type { TeamRunRegistryRead } from '../../../contracts';
import type { NativeOpenCodeMemberDeliveryPort } from '../input/NativeTeamMessagingApi';

type LaneFact = { readonly laneId: string; readonly runtimeAlive: boolean };

export interface NativeOpenCodePromptDeliverySupervisorDependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
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
 * - a team can be delivered to while its run is live; refusing a dead lane is
 *   the ledger's own decision, taken per wake with the lane identity it already
 *   resolves;
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
      // Ask the question the legacy gate asked: is this run still ours to
      // deliver to. A lane observation that is missing or briefly stale is not
      // an answer to it - the ledger resolves identity per wake and refuses a
      // dead lane on its own. A wake dropped here is dropped for good, because
      // the scheduler deletes its timer before this branch runs.
      canDeliverToTeamRuntime: (teamName) => {
        const snapshot = this.deps.runs.find(teamName);
        return snapshot ? this.deps.runs.isLive(snapshot.identity) : false;
      },
      recoverBeforeDelivery: async () => false,
      relay: async (input) => {
        const result = await this.deps.delivery.relayOpenCodeMemberInboxMessages(
          input.teamName,
          input.memberName,
          {
            onlyMessageId: input.messageId,
            source: 'watchdog',
            // The guard is the only thing that stops a walk outliving the
            // generation that armed it; the scheduler's own check runs before
            // this call, not during it.
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
          }
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
      // Lane ids are per team (`primary`, `secondary:opencode:<member>`), so the
      // answer must come from the named team only: another team's `primary` says
      // nothing about this one.
      isLaneActive: async (input) =>
        this.findTeamLanes(input.teamName).some(
          (lane) => lane.laneId === input.laneId && lane.runtimeAlive
        ),
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
