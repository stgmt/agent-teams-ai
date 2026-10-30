import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { NativeTeamLifecycle } from '@features/team-provisioning/main';

export interface DesktopTeamLifecycleHostDependencies {
  /** Resolved lazily: the connection context exists after the early app bootstrap. */
  owner(): Readonly<AppConnectionContext>;
  build(owner: Readonly<AppConnectionContext>): NativeTeamLifecycle;
}

function sameOwner(a: Readonly<AppConnectionContext>, b: Readonly<AppConnectionContext>): boolean {
  return (
    a.appInstanceId === b.appInstanceId &&
    a.dataRootFingerprint === b.dataRootFingerprint &&
    a.connectionGeneration === b.connectionGeneration
  );
}

/**
 * Owns the single native lifecycle instance and recomposes it when the app connection
 * generation changes. The old instance is shut down before the new one can launch.
 */
export class DesktopTeamLifecycleHost {
  private lifecycle: NativeTeamLifecycle;
  private owner: Readonly<AppConnectionContext>;

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

  async replaceOwner(owner: Readonly<AppConnectionContext>): Promise<boolean> {
    if (sameOwner(this.owner, owner)) return false;
    await this.lifecycle.shutdown();
    this.owner = Object.freeze({ ...owner });
    this.lifecycle = this.deps.build(this.owner);
    return true;
  }

  async shutdown(): Promise<void> {
    await this.lifecycle.shutdown();
  }
}
