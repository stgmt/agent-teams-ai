import {
  isOpenCodePromptDeliveryCancelled,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { isOpenCodePromptDeliveryObserveOnlyPendingRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryStalePendingPolicy';
import { OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';

import type { TeamRunRegistryRead } from '../../../contracts';
import type { NativeOpenCodeMemberDeliveryPort } from '../input/NativeTeamMessagingApi';

type LaneFact = { readonly laneId: string; readonly runtimeAlive: boolean };

/**
 * One team's prompt ledger, opened at the same durable path the app already
 * writes. A sweep reads what an interrupted session left behind; the ledger is
 * the only owner of that state.
 */
export interface NativePromptLedgerAccess {
  open(
    teamName: string,
    laneId: string
  ): Pick<OpenCodePromptDeliveryLedgerStore, 'listDue' | 'markNextAttemptDeferred'>;
}

export interface NativeOpenCodePromptDeliverySupervisorDependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive' | 'aliveTeamNames'>;
  /** Durable ledger access; without it the supervisor only drives armed wakes. */
  ledgers?: NativePromptLedgerAccess;
  now?(): Date;
  /** The retained member prompt ledger; this supervisor drives it, never owns it. */
  delivery: Pick<NativeOpenCodeMemberDeliveryPort, 'relayOpenCodeMemberInboxMessages'>;
  /**
   * The runtime's own account of a message, when the ledger port can answer it.
   * Absent, the sweep decides from the ledger record alone.
   */
  observeDelivery?: NativeOpenCodeMemberDeliveryPort['getOpenCodeRuntimeDeliveryStatus'];
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

/** How many due rows one sweep takes, and how often a sweep runs. */
export const NATIVE_DELIVERY_SWEEP_LIMIT = 8;
export const NATIVE_DELIVERY_SWEEP_INTERVAL_MS = 15_000;

export interface NativeDeliveryVerificationSchedule {
  teamName: string;
  memberName: string;
  messageId: string;
  delayMs?: number;
  isCurrent?: () => boolean;
}

const RECORD_NOT_FOUND_PREFIX = 'OpenCode prompt delivery record not found:';

/**
 * Whether a due record may be delivered again.
 *
 * The ledger records what the runtime answered. A prompt it accepted but has not
 * finished, a corrected handoff awaiting its own reply, and an attempt whose
 * acceptance was never observed all mean "we do not know whether the member is
 * already working on this". A retry there is not a repair - it is a second copy
 * of the same request in front of an agent that has no memory of the first.
 * Those rows are left for the observation path.
 */
function isSafeToRearm(record: OpenCodePromptDeliveryLedgerRecord): boolean {
  if (record.acceptanceUnknown) return false;
  if (record.groupRepairHandoffPending) return false;
  if (isOpenCodePromptDeliveryObserveOnlyPendingRecord(record)) return false;
  return true;
}

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
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

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

  /**
   * Starts the periodic due-delivery sweep. A row whose retry was scheduled but
   * never fired - the app was closed, the process died, the relay was cancelled
   * mid-flight - stays due in the ledger forever otherwise, because every other
   * path only looks at rows as they are written.
   */
  start(intervalMs: number = NATIVE_DELIVERY_SWEEP_INTERVAL_MS): void {
    if (!this.deps.ledgers || this.sweepTimer || intervalMs < 1) return;
    this.sweepTimer = setInterval(() => void this.sweepDueDeliveries(), intervalMs);
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * One sweep pass: every due, non-cancelled, still-current record of a live
   * team is handed to the scheduler, which relays it through the same guarded
   * path as any other wake.
   */
  async sweepDueDeliveries(): Promise<number> {
    const ledgers = this.deps.ledgers;
    if (!ledgers || this.sweeping) return 0;
    this.sweeping = true;
    let armed = 0;
    try {
      const now = this.deps.now?.() ?? new Date();
      for (const teamName of this.liveTeamNames()) {
        const snapshot = this.deps.runs.find(teamName);
        if (!snapshot) continue;
        for (const [memberName, lane] of this.memberLanes(snapshot)) {
          const ledger = ledgers.open(teamName, lane.laneId);
          const due = await ledger.listDue({
            teamName,
            now,
            limit: NATIVE_DELIVERY_SWEEP_LIMIT,
          });
          for (const record of due) {
            // A record left by an earlier run of the same team is history: its
            // inbox row belongs to a rollout that no longer exists.
            if (record.runId && record.runId !== snapshot.identity.runId) continue;
            if (isOpenCodePromptDeliveryCancelled(record)) continue;
            // A row that already has a prompt the runtime accepted, or one whose
            // acceptance is unknown, needs an observation rather than a second
            // prompt: re-sending is how a member answers the same request twice.
            // Observe before deciding: the row may have been answered while the
            // app was not looking, or be waiting in a live turn right now. Only
            // an unproven, idle row is worth a second prompt.
            const verdict = await this.decideRearm(teamName, record);
            if (verdict === 'observe') {
              // A row left holding a deadline in the past is re-decided by the
              // next sweep, which turns an observation into a tight loop. Move
              // only its deadline: status, attempts and every observation field
              // are exactly what the settle path still has to read.
              await this.deferObservation(teamName, record, ledger);
              continue;
            }
            this.scheduleDeliveryVerification({
              teamName,
              memberName: record.memberName || memberName,
              messageId: record.inboxMessageId,
              delayMs: 500,
            });
            armed++;
          }
        }
      }
    } catch (error) {
      this.deps.warn(`OpenCode delivery sweep failed: ${this.deps.getErrorMessage(error)}`);
    } finally {
      this.sweeping = false;
    }
    return armed;
  }

  /**
   * Whether a due row may be delivered again, judged from the ledger record and
   * the runtime's own account of the message.
   *
   * `observe` keeps the row out of the retry path without settling it: a turn in
   * flight, a prompt the runtime accepted, or an acceptance nobody witnessed.
   * The next pass observes again - an observation is free, a second prompt is
   * not.
   */
  private async decideRearm(
    teamName: string,
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<'retry' | 'observe'> {
    if (!isSafeToRearm(record)) return 'observe';
    const observe = this.deps.observeDelivery;
    if (!observe) return 'retry';
    let status: Awaited<ReturnType<typeof observe>>;
    try {
      status = await observe(teamName, record.inboxMessageId);
    } catch (error) {
      this.deps.debug(
        `OpenCode delivery observation failed for ${teamName}/${record.inboxMessageId}: ${this.deps.getErrorMessage(error)}`
      );
      return 'observe';
    }
    if (!status) return 'retry';
    if (status.responsePending === true) return 'observe';
    if (status.responseState?.startsWith('responded_')) return 'observe';
    if (status.accepted === true) return 'observe';
    return 'retry';
  }

  /**
   * A deferred row is not silent: `getOpenCodeRuntimeDeliveryStatus` answers it
   * from the same record and returns `responsePending` plus the queue identity,
   * which is what the delivery view reads. Only the deadline moves here, so the
   * record keeps the state the caller asked about.
   */
  private async deferObservation(
    teamName: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    ledger: Pick<OpenCodePromptDeliveryLedgerStore, 'markNextAttemptDeferred'>
  ): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    try {
      await ledger.markNextAttemptDeferred({
        id: record.id,
        nextAttemptAt: new Date(
          now.getTime() + OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS
        ).toISOString(),
        deferredAt: now.toISOString(),
      });
    } catch (error) {
      // Losing the deadline write costs an extra observation pass; turning it
      // into a failed sweep would cost the rest of the teams in this pass.
      this.deps.debug(
        `OpenCode delivery deferral failed for ${teamName}/${record.inboxMessageId}: ${this.deps.getErrorMessage(error)}`
      );
    }
  }

  private liveTeamNames(): readonly string[] {
    const names: string[] = [];
    for (const teamName of this.deps.runs.aliveTeamNames()) {
      const snapshot = this.deps.runs.find(teamName);
      if (snapshot && this.deps.runs.isLive(snapshot.identity)) names.push(teamName);
    }
    return names;
  }

  private memberLanes(snapshot: {
    members: Readonly<Record<string, { lane: LaneFact | null }>>;
  }): readonly (readonly [string, LaneFact])[] {
    const lanes: (readonly [string, LaneFact])[] = [];
    for (const [memberName, member] of Object.entries(snapshot.members)) {
      if (member.lane) lanes.push([memberName, member.lane] as const);
    }
    return lanes;
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
