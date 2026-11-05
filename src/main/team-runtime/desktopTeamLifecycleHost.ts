import { sameExternalAgentRunContext } from '@features/external-agent-connection/main';

import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { NativeTeamLifecycle } from '@features/team-provisioning/main';

export interface DesktopTeamLifecycleHostDependencies {
  /** Snapshot at construction; later generations are supplied to replaceOwner. */
  owner(): Readonly<AppConnectionContext>;
  /** Must be side-effect free until the old lifecycle is shut down. */
  build(owner: Readonly<AppConnectionContext>): NativeTeamLifecycle;
}

export class DesktopTeamLifecycleRecompositionError extends Error {
  constructor(readonly cause: unknown) {
    super('Desktop team lifecycle recomposition failed');
    this.name = 'DesktopTeamLifecycleRecompositionError';
  }
}

/**
 * Owns the single native lifecycle instance and recomposes it when the app connection
 * generation changes. Shutdown is terminal; a failed recomposition keeps the current
 * lifecycle and never leaks the unadopted replacement.
 */
export class DesktopTeamLifecycleHost {
  private lifecycle: NativeTeamLifecycle;
  private owner: Readonly<AppConnectionContext>;
  private stopped = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DesktopTeamLifecycleHostDependencies) {
    this.owner = Object.freeze({ ...deps.owner() });
    this.lifecycle = deps.build(this.owner);
  }

  get current(): NativeTeamLifecycle {
    return this.lifecycle;
  }

  get currentOwner(): Readonly<AppConnectionContext> {
    return this.owner;
  }

  replaceOwner(owner: Readonly<AppConnectionContext>): Promise<boolean> {
    return this.exclusive(() => this.replaceOwnerNow(owner));
  }

  shutdown(): Promise<void> {
    return this.exclusive(() => this.shutdownNow());
  }

  private async replaceOwnerNow(owner: Readonly<AppConnectionContext>): Promise<boolean> {
    if (this.stopped) throw new Error('Desktop team lifecycle host is stopped');
    if (sameExternalAgentRunContext(this.owner, owner)) return false;
    if (
      this.owner.appInstanceId === owner.appInstanceId &&
      this.owner.dataRootFingerprint === owner.dataRootFingerprint &&
      owner.connectionGeneration < this.owner.connectionGeneration
    )
      throw new Error('Desktop team lifecycle owner generation is stale');
    const nextOwner = Object.freeze({ ...owner });
    // Build before shutdown: a failed composition must not leave the app without a lifecycle.
    const next = this.deps.build(nextOwner);
    try {
      await this.lifecycle.shutdown();
    } catch (error) {
      await next.shutdown().catch(() => undefined);
      throw new DesktopTeamLifecycleRecompositionError(error);
    }
    this.owner = nextOwner;
    this.lifecycle = next;
    return true;
  }

  private async shutdownNow(): Promise<void> {
    if (this.stopped) return;
    await this.lifecycle.shutdown();
    this.stopped = true;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
