import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteSync } from '../../../utils/atomicWrite';
import { withFileLock } from '../fileLock';
import { isRecord } from '../registry/RegistryJson';

import type { RegistryTaskGenesisReplayRecord } from '../registry/RegistryTaskClientTypes';

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key));
}

function isGenesisReplayRecord(value: unknown): value is RegistryTaskGenesisReplayRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['challenge', 'attestation', 'requestArguments']) ||
    !isRecord(value.challenge) ||
    !hasOnlyKeys(value.challenge, ['batchId', 'requestId', 'payloadDigest', 'challenges']) ||
    typeof value.challenge.batchId !== 'string' ||
    typeof value.challenge.requestId !== 'string' ||
    typeof value.challenge.payloadDigest !== 'string' ||
    !Array.isArray(value.challenge.challenges) ||
    value.challenge.challenges.length !== 1 ||
    !isRecord(value.challenge.challenges[0]) ||
    !hasOnlyKeys(value.challenge.challenges[0], ['operationId', 'nonce', 'keyId', 'payload']) ||
    typeof value.challenge.challenges[0].operationId !== 'string' ||
    typeof value.challenge.challenges[0].nonce !== 'string' ||
    typeof value.challenge.challenges[0].keyId !== 'string' ||
    !Array.isArray(value.challenge.challenges[0].payload) ||
    value.challenge.challenges[0].payload.length !== 25 ||
    !isRecord(value.attestation) ||
    !hasOnlyKeys(value.attestation, ['operationId', 'nonce', 'keyId', 'payload', 'signature']) ||
    typeof value.attestation.operationId !== 'string' ||
    typeof value.attestation.nonce !== 'string' ||
    typeof value.attestation.keyId !== 'string' ||
    !Array.isArray(value.attestation.payload) ||
    value.attestation.payload.length !== 25 ||
    typeof value.attestation.signature !== 'string' ||
    !isRecord(value.requestArguments) ||
    !hasOnlyKeys(value.requestArguments, [
      'schemaVersion',
      'intent',
      'project',
      'spec',
      'requestId',
      'reason',
      'dryRun',
      'operations',
      'force',
      'genesisAttestations',
    ]) ||
    !Array.isArray(value.requestArguments.operations) ||
    value.requestArguments.operations.length !== 1 ||
    !isRecord(value.requestArguments.operations[0]) ||
    !hasOnlyKeys(value.requestArguments.operations[0], [
      'kind',
      'document',
      'teamId',
      'localId',
      'title',
      'requirements',
      'body',
      'description',
      'creationToken',
      'policy',
      'status',
      'owner',
      'tracking',
      'dependsOn',
      'expectedSha',
      'refs',
    ]) ||
    !Array.isArray(value.requestArguments.genesisAttestations) ||
    value.requestArguments.genesisAttestations.length !== 1 ||
    !isRecord(value.requestArguments.genesisAttestations[0])
  ) {
    return false;
  }
  const [challenge] = value.challenge.challenges;
  const [wireAttestation] = value.requestArguments.genesisAttestations;
  return (
    challenge !== undefined &&
    wireAttestation !== undefined &&
    challenge.operationId === value.attestation.operationId &&
    challenge.nonce === value.attestation.nonce &&
    challenge.keyId === value.attestation.keyId &&
    JSON.stringify(challenge.payload) === JSON.stringify(value.attestation.payload) &&
    wireAttestation.operationId === value.attestation.operationId &&
    wireAttestation.nonce === value.attestation.nonce &&
    wireAttestation.keyId === value.attestation.keyId &&
    wireAttestation.signature === value.attestation.signature &&
    JSON.stringify(wireAttestation.payload) === JSON.stringify(value.attestation.payload) &&
    value.challenge.requestId === value.requestArguments.requestId &&
    value.challenge.requestId === value.attestation.payload[17] &&
    value.challenge.batchId === value.attestation.payload[14] &&
    value.challenge.payloadDigest === value.attestation.payload[18]
  );
}

function genesisReplayMatchesEntry(entry: Record<string, unknown>): boolean {
  const replay = entry.genesisReplay;
  if (!isGenesisReplayRecord(replay)) return false;
  const operations = replay.requestArguments.operations;
  if (!Array.isArray(operations) || !isRecord(operations[0])) return false;
  const operation = operations[0];
  return (
    typeof entry.requestId === 'string' &&
    typeof entry.creationToken === 'string' &&
    typeof entry.expectedSha === 'string' &&
    replay.challenge.requestId === entry.requestId &&
    operation.localId === entry.taskId &&
    operation.creationToken === entry.creationToken &&
    operation.expectedSha === entry.expectedSha
  );
}

export interface TaskCreationJournalEntry {
  key: string;
  commandId: string;
  payloadHash: string;
  taskId: string;
  state: 'pending' | 'committed';
  /** Identifies reservations created by the unsigned local-artifact protocol. */
  creationProtocol?: 'unsigned-local-artifact-v1';
  /** Stable id reused by both phases of a signed initial-policy write. */
  requestId?: string;
  /** Present for commands whose remote provenance can be reconciled. */
  creationToken?: string;
  /** Exact pre-send revision used to reconstruct the unsigned challenge request. */
  expectedSha?: string;
  /** Exact signed request; required to replay a possibly-sent GENESIS commit after restart. */
  genesisReplay?: RegistryTaskGenesisReplayRecord;
  createdAt?: string;
  eventId?: string;
  projectPath?: string;
}

/** Serializes app-side numeric ID reservations and retains unknown outcomes across restarts. */
export class TaskCreationJournal {
  constructor(private readonly teamPath: string) {}

  async run<T>(
    operation: (entries: TaskCreationJournalEntry[], save: () => void) => Promise<T>
  ): Promise<T> {
    const directory = path.join(this.teamPath, '.creation-commands');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'journal.json');
    return withFileLock(
      file,
      async () => {
        let entries: TaskCreationJournalEntry[] = [];
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (
            !Array.isArray(parsed) ||
            parsed.some(
              (entry) =>
                !entry ||
                typeof entry !== 'object' ||
                typeof entry.key !== 'string' ||
                typeof entry.commandId !== 'string' ||
                typeof entry.payloadHash !== 'string' ||
                (entry.creationProtocol !== undefined &&
                  entry.creationProtocol !== 'unsigned-local-artifact-v1') ||
                !/^\d+$/.test(entry.taskId) ||
                (entry.requestId !== undefined &&
                  (typeof entry.requestId !== 'string' ||
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
                      entry.requestId
                    ))) ||
                (entry.creationToken !== undefined && typeof entry.creationToken !== 'string') ||
                (entry.expectedSha !== undefined &&
                  (typeof entry.expectedSha !== 'string' ||
                    !/^[a-f0-9]{64}$/u.test(entry.expectedSha))) ||
                (entry.genesisReplay !== undefined && !genesisReplayMatchesEntry(entry)) ||
                (entry.createdAt !== undefined && typeof entry.createdAt !== 'string') ||
                (entry.eventId !== undefined && typeof entry.eventId !== 'string') ||
                (entry.projectPath !== undefined && typeof entry.projectPath !== 'string') ||
                (entry.state !== 'pending' && entry.state !== 'committed')
            )
          )
            throw new Error('Invalid task creation journal');
          entries = parsed as TaskCreationJournalEntry[];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return operation(entries, () => atomicWriteSync(file, JSON.stringify(entries)));
      },
      { preventLiveOwnerTakeover: true }
    );
  }
}
