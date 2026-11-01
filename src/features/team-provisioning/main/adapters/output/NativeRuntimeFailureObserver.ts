import type { TeamLifecycleSnapshot } from '../../../contracts';
import type {
  LeadRuntimeFailureObservation,
  RuntimeFailureObservationInput,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeFailureObservationBoundary';
import type { TeamProviderId } from '@shared/types';

export interface NativeRuntimeFailureObserverDependencies {
  /**
   * Where a runtime failure becomes visible to the app. Required: a silently
   * dropped failure looks like a quiet app while a lead is dead.
   */
  emit(failure: LeadRuntimeFailureObservation): void;
  nowIso(): string;
}

export interface NativeRuntimeFailureReport extends Omit<RuntimeFailureObservationInput, 'observedAt'> {
  snapshot: Readonly<TeamLifecycleSnapshot>;
  memberName: string;
  runtimeSessionId?: string;
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
}

/**
 * One boundary for runtime failures: the caller knows the failure and the provider
 * details it observed, the snapshot knows which team and run is affected, and this
 * class stamps when it was seen. Identity that a caller could get wrong is read
 * from the snapshot instead of being passed in.
 */
export class NativeRuntimeFailureObserver {
  constructor(private readonly deps: NativeRuntimeFailureObserverDependencies) {}

  report(report: NativeRuntimeFailureReport): void {
    const { snapshot, memberName, runtimeSessionId, providerId, providerBackendId, model, ...failure } =
      report;
    this.deps.emit({
      teamName: snapshot.identity.teamName,
      runId: snapshot.identity.runId,
      memberName,
      observedAt: this.deps.nowIso(),
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
      ...(providerId ? { providerId } : {}),
      ...(providerBackendId ? { providerBackendId } : {}),
      ...(model ? { model } : {}),
      ...failure,
    });
  }
}
