/**
 * Spec-registry task boundary for team tasks.
 *
 * Team tasks live in the registry (`omp-spec-kit`), not in a local store: the
 * client only reads through `spec_tasks` and writes through the structured
 * `spec_patch` task operations. Everything is fail-closed and typed.
 */
export {
  CreatedSpecBindingObserver,
  type CreatedSpecBindingObserverDependencies,
  type CreatedSpecBindingSubject,
} from './CreatedSpecBindingObserver';
export { RegistryTaskClient, type RegistryTaskClientOptions } from './RegistryTaskClient';
export type { ResolvedRegistryTaskClientConfig } from './RegistryTaskClientConfig';
export {
  DEFAULT_SPEC_REGISTRY_REQUEST_TIMEOUT_MS,
  DEFAULT_SPEC_REGISTRY_URL,
  resolveRegistryTaskClientConfig,
  SPEC_REGISTRY_TOKEN_ENV,
  SPEC_REGISTRY_URL_ENV,
} from './RegistryTaskClientConfig';
export type {
  RegistryTaskClientErrorCode,
  RegistryTaskClientErrorInit,
} from './RegistryTaskClientErrors';
export {
  RegistryStatusConflictError,
  RegistryTaskAbortedError,
  RegistryTaskAuthenticationError,
  RegistryTaskClientConfigError,
  RegistryTaskClientError,
  RegistryTaskHttpError,
  RegistryTaskProtocolError,
  RegistryTaskRequestFailedError,
  RegistryTaskRpcError,
  RegistryTaskTimeoutError,
  RegistryTaskTransportError,
  RegistryTaskWriteRefusedError,
} from './RegistryTaskClientErrors';
export {
  type ListRegistryTasksInput,
  REGISTRY_TASK_STATUSES,
  type RegistryTask,
  type RegistryTaskRefusal,
  type RegistryTaskStatus,
  type RegistryTaskStatusResult,
  type RegistryTaskTransition,
  type RegistryTaskWriteOutcome,
  type RegistryTaskWriteResult,
  type ReplaceRegistryTaskLinksInput,
  type ReplaceRegistryTaskOwnerInput,
  type ReplaceRegistryTaskStatusInput,
  type UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';
export type {
  RegistryBoardSnapshotReadOptions,
  RegistryBoardSnapshotReadPort,
} from './RegistryTaskProvider';
export {
  type RegistryTeamTaskClientPort,
  type RegistryTeamTaskCreateInput,
  RegistryTeamTaskWriteError,
  type RegistryTeamTaskWriteErrorCode,
  RegistryTeamTaskWriter,
  type RegistryTeamTaskWriterOptions,
} from './RegistryTeamTaskWriter';
export {
  createRegistryTeamTaskWriter,
  type RegistryTeamTaskWriterProvider,
  type RegistryTeamTaskWriterRequest,
} from './RegistryTeamTaskWriterFactory';
export {
  resolveTeamSpecBinding,
  type TeamSpecBinding,
  TeamSpecBindingError,
  type TeamSpecBindingErrorCode,
} from './TeamSpecBinding';
