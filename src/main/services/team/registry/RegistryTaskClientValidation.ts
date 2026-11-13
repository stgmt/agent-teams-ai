import {
  digestTaskCreationToken,
  type TaskIdentity,
} from '@main/services/identity/TaskAttestation';
import { type RegistryRegistrationIdentity } from '@shared/types';

import { isRecord } from './RegistryJson';
import { RegistryTaskClientError, RegistryTaskProtocolError } from './RegistryTaskClientErrors';
import { REGISTRY_TASK_STATUSES, type RegistryTaskStatus } from './RegistryTaskClientTypes';

/** Shared wire primitives: strict records, identities and task scope admission. */
export const REGISTRY_SCHEMA_VERSION = 'spec-kernel@2';
export const TASK_DOCUMENT = 'TASKS.md';
export const MAX_TASK_PAGES = 100;

export function readAllowedRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  operation: string
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidArgument(operation, 'persisted request object is invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' || (!requiredKeys.includes(key) && !optionalKeys.includes(key))
    ) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidArgument(operation, 'persisted request contains missing or unexpected fields');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidArgument(operation, 'persisted request contains an unsafe field');
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function freezeJsonRecord(
  value: Record<string, unknown>,
  operation: string
): Record<string, unknown> {
  const clone = (current: unknown, depth: number): unknown => {
    if (depth > 64) throw invalidArgument(operation, 'request arguments are too deeply nested');
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      return current;
    }
    if (Array.isArray(current)) {
      if (
        Object.getPrototypeOf(current) !== Array.prototype ||
        Reflect.ownKeys(current).length !== current.length + 1
      ) {
        throw invalidArgument(operation, 'request arguments contain an unsafe array');
      }
      return Object.freeze(current.map((entry) => clone(entry, depth + 1)));
    }
    if (
      typeof current !== 'object' ||
      (Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null)
    ) {
      throw invalidArgument(operation, 'request arguments contain an unsafe value');
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') {
        throw invalidArgument(operation, 'request arguments contain a symbol key');
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalidArgument(operation, 'request arguments contain an unsafe property');
      }
      Object.defineProperty(output, key, {
        value: clone(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(output);
  };
  const cloned = clone(value, 0);
  if (!isRecord(cloned)) {
    throw invalidArgument(operation, 'request arguments must be an object');
  }
  return cloned;
}

export function assertUuid(value: unknown, operation: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw invalidArgument(operation, `${field} must be a lowercase UUID`);
  }
  return value;
}

export function assertOpaqueToken(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidArgument(operation, `${field} must be a non-empty opaque string`);
  }
  return value;
}

export function digestCreationTokenSafely(value: string, operation: string): string {
  try {
    return digestTaskCreationToken(value);
  } catch {
    throw invalidArgument(operation, 'creationToken is not a valid UTF-8 scalar string');
  }
}

export function readExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  operation: string
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new RegistryTaskProtocolError(operation, 'registry returned an invalid payload object');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== requiredKeys.length ||
    keys.some((key) => typeof key !== 'string' || !requiredKeys.includes(key))
  ) {
    throw new RegistryTaskProtocolError(operation, 'registry returned unexpected payload fields');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of requiredKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new RegistryTaskProtocolError(operation, 'registry returned an invalid payload field');
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function assertRegistrationIdentity(
  value: RegistryRegistrationIdentity,
  operation: string
): RegistryRegistrationIdentity {
  const record = readExactRecord(value, ['securityStoreId', 'idp', 'userId'], operation);
  if (
    typeof record.securityStoreId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      record.securityStoreId
    ) ||
    typeof record.idp !== 'string' ||
    !record.idp.trim() ||
    record.idp !== record.idp.trim() ||
    typeof record.userId !== 'string' ||
    !record.userId.trim() ||
    record.userId !== record.userId.trim()
  ) {
    throw invalidArgument(operation, 'expected registration identity is invalid');
  }
  return Object.freeze({
    securityStoreId: record.securityStoreId,
    idp: record.idp,
    userId: record.userId,
  });
}

export function assertCanonicalTaskId(value: unknown, operation: string): string {
  const taskId = assertNonEmptyString(value, operation, 'taskId');
  if (!/^TASK-[1-9][0-9]*$/u.test(taskId)) {
    throw invalidArgument(operation, 'taskId must be a canonical TASK-N identifier');
  }
  return taskId;
}

export function assertDigest(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidArgument(operation, `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertArtifactSize(value: unknown, operation: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 20 * 1024 * 1024
  ) {
    throw invalidArgument(operation, 'artifactSize is outside the 20 MiB limit');
  }
  return value as number;
}

export function isScalarString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
}

export function readTaskIdentityFields(
  record: Record<string, unknown>,
  operation: string
): TaskIdentity {
  const values = [
    record.registry,
    record.idp,
    record.userId,
    record.teamId,
    record.project,
    record.spec,
    record.taskId,
    record.generation,
    record.revision,
  ];
  if (
    !values.every(isScalarString) ||
    !/^TASK-[1-9][0-9]*$/u.test(record.taskId as string) ||
    !/^[a-f0-9]{64}$/u.test(record.revision as string)
  ) {
    throw new RegistryTaskProtocolError(operation, 'persisted task identity is invalid');
  }
  return Object.freeze({
    registry: record.registry as string,
    idp: record.idp as string,
    userId: record.userId as string,
    teamId: record.teamId as string,
    project: record.project as string,
    spec: record.spec as string,
    taskId: record.taskId as string,
    generation: record.generation as string,
    revision: record.revision as string,
  });
}

export function readTaskIdentityRecord(value: unknown, operation: string): TaskIdentity {
  return readTaskIdentityFields(
    readExactRecord(
      value,
      [
        'registry',
        'idp',
        'userId',
        'teamId',
        'project',
        'spec',
        'taskId',
        'generation',
        'revision',
      ],
      operation
    ),
    operation
  );
}

export function sameTaskIdentity(left: TaskIdentity, right: TaskIdentity): boolean {
  return (
    left.registry === right.registry &&
    left.idp === right.idp &&
    left.userId === right.userId &&
    left.teamId === right.teamId &&
    left.project === right.project &&
    left.spec === right.spec &&
    left.taskId === right.taskId &&
    left.generation === right.generation &&
    left.revision === right.revision
  );
}

export function assertScope(
  input: { project: string; spec: string },
  operation: string
): { project: string; spec: string } {
  return {
    project: assertNonEmptyString(input.project, operation, 'project'),
    spec: assertNonEmptyString(input.spec, operation, 'spec'),
  };
}

export function assertNonEmptyString(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidArgument(operation, `${operation} requires a non-empty ${field}`);
  }
  return value.trim();
}

export function assertStringArray(value: unknown, operation: string, field: string): string[] {
  if (!Array.isArray(value)) {
    throw invalidArgument(operation, `${operation}.${field} must be an array of ids`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw invalidArgument(operation, `${operation}.${field}[${index}] must be a non-empty id`);
    }
    return entry.trim();
  });
}

export function assertStatuses(
  value: readonly RegistryTaskStatus[] | undefined,
  operation: string
): string[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw invalidArgument(operation, `${operation}.statuses must be an array`);
  }
  return value.map((status) => assertTaskStatus(status, operation));
}

export function assertTaskStatus(value: unknown, operation: string): RegistryTaskStatus {
  const normalized = normalizeStatus(typeof value === 'string' ? value : null);
  if (value !== normalized) {
    throw invalidArgument(
      operation,
      `${operation} status must be one of ${REGISTRY_TASK_STATUSES.join(', ')}, got ${String(value)}`
    );
  }
  return normalized;
}

export function normalizeStatus(value: string | null): RegistryTaskStatus {
  const match = REGISTRY_TASK_STATUSES.find((status) => status === value);
  return match ?? 'unknown';
}

/**
 * Structured operations address tasks by local id. A canonical id is accepted
 * only when it belongs to the same spec: silently stripping a foreign prefix
 * would write the wrong task.
 */
export function assertEntity(value: unknown, scope: { spec: string }, operation: string): string {
  const entity = assertNonEmptyString(value, operation, 'entity');
  const separator = entity.lastIndexOf(':');
  if (separator < 0) {
    return entity;
  }
  const specPrefix = entity.slice(0, separator);
  const localId = entity.slice(separator + 1);
  if (specPrefix !== scope.spec) {
    throw invalidArgument(
      operation,
      `${operation}.entity ${entity} belongs to spec ${specPrefix}, not ${scope.spec}`
    );
  }
  return assertNonEmptyString(localId, operation, 'entity');
}

export function invalidArgument(operation: string, message: string): RegistryTaskClientError {
  return new RegistryTaskClientError({ code: 'INVALID_ARGUMENT', message, operation });
}
