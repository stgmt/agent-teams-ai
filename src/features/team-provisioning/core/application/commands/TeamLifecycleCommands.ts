import { awaitWithAbort } from '../awaitWithAbort';
import { TeamRunMismatchError } from '../TeamRunMismatchError';

import type { ConfiguredMemberIdentity, TeamRunIdentity } from '../../../contracts';
import type { MemberLifecycleRegistry } from '../../domain/MemberLifecycleRegistry';
import type { LeadMemberStartAuthority } from '../LeadMemberStartAuthority';
import type { TeamOperationGate, TeamRunResourcesPort } from '../ports/MemberRuntimePorts';
import type { MemberLifecycleCommands } from './MemberLifecycleCommands';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

interface Dependencies {
  registry: MemberLifecycleRegistry;
  members: MemberLifecycleCommands;
  authority: LeadMemberStartAuthority;
  gate: TeamOperationGate;
  resources?: TeamRunResourcesPort;
  nextOperationId(): string;
  nextRunId(): string;
  nextCredential(): string;
}

export interface TeamLaunchAdmission {
  run: Readonly<TeamRunIdentity>;
  leadCredential: string;
}

interface PendingLaunch {
  run: Readonly<TeamRunIdentity>;
  abort: AbortController;
  preparing: boolean;
  result: Promise<Readonly<TeamLaunchAdmission>>;
}

type LoadRoster = (signal: AbortSignal) => Promise<readonly ConfiguredMemberIdentity[]>;

function rosterKey(members: readonly ConfiguredMemberIdentity[]): string {
  return JSON.stringify(
    [...members]
      .sort((left, right) => left.memberName.localeCompare(right.memberName))
      .map(({ memberName, role }) => [memberName, role])
  );
}

export class TeamLifecycleCommands {
  private readonly admissions = new Map<
    string,
    { receipt: Readonly<TeamLaunchAdmission>; roster: string }
  >();
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly releasing = new Map<string, Promise<void>>();
  private shutdownPending: Promise<void> | null = null;

  constructor(private readonly ports: Dependencies) {}

  launch(
    run: TeamRunIdentity,
    members: readonly ConfiguredMemberIdentity[]
  ): Promise<Readonly<TeamLaunchAdmission>> {
    return this.launchConfigured(run, async () => members);
  }

  async launchCurrent(
    owner: AppConnectionContext,
    teamName: string,
    load: (
      run: Readonly<TeamRunIdentity>,
      signal: AbortSignal
    ) => Promise<readonly ConfiguredMemberIdentity[]>,
    signal?: AbortSignal
  ): Promise<Readonly<TeamLaunchAdmission>> {
    signal?.throwIfAborted();
    const context = Object.freeze({ ...owner });
    const selected = await this.ports.gate.run(teamName, async () => {
      signal?.throwIfAborted();
      this.ports.registry.assertStartsOpen();
      const candidate = Object.freeze({ ...context, teamName, runId: this.ports.nextRunId() });
      this.ports.registry.assertOwner(candidate);
      if (this.releasing.has(teamName)) throw new Error('Team run resources are releasing');
      const current = this.ports.registry.findSnapshot(teamName);
      if (current?.resources === 'release-failed')
        throw new Error('Team run resources were not released');
      const pending = this.pending.get(teamName);
      if (pending) {
        if (pending.abort.signal.aborted) throw new Error('Team run is intentionally stopped');
        return { result: pending.result };
      }
      const previous = this.admissions.get(teamName);
      if (
        previous &&
        current?.desired === 'running' &&
        current.identity.runId === previous.receipt.run.runId
      ) {
        this.ports.registry.assertRun(previous.receipt.run);
        return { result: Promise.resolve(previous.receipt) };
      }
      return this.selectLaunch(candidate, (launchSignal) => load(candidate, launchSignal), signal);
    });
    return selected.result;
  }

  async launchConfigured(
    identity: TeamRunIdentity,
    load: LoadRoster
  ): Promise<Readonly<TeamLaunchAdmission>> {
    const run = Object.freeze({ ...identity });
    // Return a holder: the operation queue must not await settings I/O or the pending launch itself.
    const selected = await this.ports.gate.run(run.teamName, async () =>
      this.selectLaunch(run, load)
    );
    return selected.result;
  }

  private selectLaunch(
    run: Readonly<TeamRunIdentity>,
    load: LoadRoster,
    signal?: AbortSignal
  ): { result: Promise<Readonly<TeamLaunchAdmission>> } {
    this.ports.registry.assertStartsOpen();
    this.ports.registry.assertOwner(run);
    if (this.releasing.has(run.teamName)) throw new Error('Team run resources are releasing');
    const pending = this.pending.get(run.teamName);
    if (pending) {
      if (pending.run.runId !== run.runId) throw new Error('Cannot replace a pending team run');
      return { result: pending.result };
    }
    const previous = this.admissions.get(run.teamName);
    const current = this.ports.registry.findSnapshot(run.teamName);
    if (current?.resources === 'release-failed')
      throw new Error('Team run resources were not released');
    if (previous?.receipt.run.runId === run.runId) {
      this.ports.registry.assertRun(run);
      if (this.ports.registry.snapshot(run.teamName).desired !== 'running')
        throw new Error('Team run is intentionally stopped');
    } else {
      if (previous && this.ports.members.hasUnreleased(previous.receipt.run))
        throw new Error('Cannot replace a team run while resources are releasing');
      this.ports.registry.beginPreparation(run);
    }
    const request: PendingLaunch = {
      run: Object.freeze({ ...run }),
      abort: new AbortController(),
      preparing: previous?.receipt.run.runId !== run.runId,
      result: Promise.resolve().then(async () => {
        const revoke = (): void => request.abort.abort(signal?.reason);
        signal?.addEventListener('abort', revoke, { once: true });
        if (signal?.aborted) revoke();
        try {
          return await this.prepare(request, load);
        } finally {
          signal?.removeEventListener('abort', revoke);
        }
      }),
    };
    this.pending.set(run.teamName, request);
    return { result: request.result };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPending) return this.shutdownPending;
    const runs = this.ports.registry.closeStarts();
    for (const run of runs) {
      this.pending.get(run.teamName)?.abort.abort();
      this.ports.authority.revokeRun(run);
    }
    const operation = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(runs.map((run) => this.stop(run)));
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      );
      if (failures.length)
        throw new AggregateError(failures, 'Application lifecycle shutdown failed');
    });
    this.shutdownPending = operation.finally(() => {
      this.shutdownPending = null;
    });
    return this.shutdownPending;
  }

  async stop(run: TeamRunIdentity): Promise<void> {
    const stops = await this.ports.gate.run(run.teamName, async () => {
      this.ports.registry.assertOwner(run);
      const current = this.ports.registry.findSnapshot(run.teamName);
      if (current?.identity.runId !== run.runId) throw new TeamRunMismatchError();
      const pending = this.pending.get(run.teamName);
      if (pending && pending.run.runId !== run.runId) throw new TeamRunMismatchError();
      pending?.abort.abort();
      this.ports.registry.requestTeamStop(run);
      this.ports.authority.revokeRun(run);
      const preparationSettled = (): void => {
        const snapshot = this.ports.registry.snapshot(run.teamName);
        if (snapshot.resources === 'release-failed')
          throw new Error(snapshot.error ?? 'Team run resources were not released');
      };
      const waits: Promise<void>[] = pending
        ? [pending.result.then(preparationSettled, preparationSettled)]
        : [];
      if (pending && this.admissions.get(run.teamName)?.receipt.run.runId !== run.runId) {
        if (this.ports.registry.snapshot(run.teamName).resources === 'preparing')
          this.ports.registry.beginRelease(run);
        return waits;
      }
      const existing = this.releasing.get(run.teamName);
      if (existing) return [existing];
      if (this.ports.registry.snapshot(run.teamName).resources === 'released') {
        this.ports.registry.observeReleased(run);
        return waits;
      }
      this.ports.registry.beginRelease(run);
      const names = Object.keys(this.ports.registry.snapshot(run.teamName).members);
      const members = this.ports.members.cancelAdmitted(run, names);
      const release = Promise.resolve().then(async () => {
        try {
          await this.ports.members.awaitStops([...waits, ...members]);
          await this.ports.resources?.release(run);
          await this.ports.gate.run(run.teamName, async () => {
            this.ports.registry.observeReleased(run);
          });
        } catch (error) {
          await this.ports.gate.run(run.teamName, async () => {
            this.ports.registry.observeReleaseFailed(
              run,
              error instanceof Error ? error.message : String(error)
            );
          });
          throw error;
        } finally {
          await this.ports.gate.run(run.teamName, async () => {
            this.releasing.delete(run.teamName);
          });
        }
      });
      this.releasing.set(run.teamName, release);
      return [release];
    });
    // Termination and settings cancellation never hold the operation gate.
    await this.ports.members.awaitStops(stops);
  }

  private async prepare(
    request: PendingLaunch,
    load: LoadRoster
  ): Promise<Readonly<TeamLaunchAdmission>> {
    let resourcesStarted = false;
    try {
      request.abort.signal.throwIfAborted();
      const members = await awaitWithAbort(load(request.abort.signal), request.abort.signal);
      request.abort.signal.throwIfAborted();
      const existing = await this.ports.gate.run(request.run.teamName, async () => {
        request.abort.signal.throwIfAborted();
        return this.admissions.get(request.run.teamName)?.receipt.run.runId === request.run.runId
          ? this.admit(request.run, members)
          : null;
      });
      if (existing) return existing;
      // Mutating preparation must settle before cancellation releases its run claim.
      resourcesStarted = true;
      await this.ports.resources?.prepare(request.run, request.abort.signal);
      request.abort.signal.throwIfAborted();
      return await this.ports.gate.run(request.run.teamName, async () => {
        request.abort.signal.throwIfAborted();
        return this.admit(request.run, members);
      });
    } catch (error) {
      if (resourcesStarted) {
        try {
          await this.ports.resources?.release(request.run);
        } catch (releaseError) {
          await this.ports.gate.run(request.run.teamName, async () => {
            this.ports.registry.observeReleaseFailed(
              request.run,
              releaseError instanceof Error ? releaseError.message : String(releaseError)
            );
          });
          throw new AggregateError(
            [error, releaseError],
            'Team launch resources were not released'
          );
        }
      }
      if (request.preparing)
        await this.ports.gate.run(request.run.teamName, async () => {
          this.ports.registry.observePreparationFailed(
            request.run,
            error instanceof Error ? error.message : String(error)
          );
        });
      throw error;
    } finally {
      await this.ports.gate.run(request.run.teamName, async () => {
        if (this.pending.get(request.run.teamName) === request)
          this.pending.delete(request.run.teamName);
      });
    }
  }

  private admit(
    run: TeamRunIdentity,
    members: readonly ConfiguredMemberIdentity[]
  ): Readonly<TeamLaunchAdmission> {
    const roster = rosterKey(members);
    const previous = this.admissions.get(run.teamName);
    if (previous?.receipt.run.runId === run.runId) {
      this.ports.registry.assertRun(run);
      if (this.ports.registry.snapshot(run.teamName).desired !== 'running')
        throw new Error('Team run is intentionally stopped');
      if (previous.roster !== roster)
        throw new Error('Configured run roster cannot be changed by launch');
      return previous.receipt;
    }
    if (members.filter((member) => member.role === 'lead').length !== 1)
      throw new Error('A configured team must have exactly one lead');
    this.ports.registry.configureTeam(run, members);
    const credential = this.ports.nextCredential();
    this.ports.authority.bind(credential, run);
    const receipt = Object.freeze({ run: Object.freeze({ ...run }), leadCredential: credential });
    this.admissions.set(run.teamName, { receipt, roster });
    const tokens = this.ports.registry.beginTeamStart(run, () => this.ports.nextOperationId());
    this.ports.members.launchAdmitted(tokens);
    return receipt;
  }
}
