import { composerDraftReadwrite, requestValue } from './composerDraftIndexedDb';
import {
  composerRecoverySummary,
  isComposerRecoveryRecord,
  isComposerWorkingRecord,
  readComposerRecoveryIndex,
  upsertComposerRecoverySummary,
} from './composerDraftRecovery';
import {
  nextWorkingSummaries,
  readComposerWorkingIndex,
  workingIndexRecord,
} from './composerDraftWorkingSummary';

export interface ComposerMemorySnapshot {
  baseline: ReadonlyMap<string, unknown>;
  records: ReadonlyMap<string, unknown>;
  removed: readonly string[];
  workingIndexKey: string;
  recoveryIndexKey: string;
}

/** Compare every changed record before committing any. Never dispatches messages. */
export function persistComposerMemory(snapshot: ComposerMemorySnapshot): Promise<boolean> {
  return composerDraftReadwrite(async (store) => {
    const keys = [...new Set([...snapshot.records.keys(), ...snapshot.removed])];
    const rows = await Promise.all(
      keys.map(async (key) => [key, await requestValue<unknown>(store.get(key))] as const)
    );
    const [workingRaw, recoveryRaw] = await Promise.all([
      requestValue<unknown>(store.get(snapshot.workingIndexKey)),
      requestValue<unknown>(store.get(snapshot.recoveryIndexKey)),
    ]);
    for (const [key, durable] of rows) {
      const desired = snapshot.records.get(key);
      if (
        JSON.stringify(durable) !== JSON.stringify(snapshot.baseline.get(key)) &&
        JSON.stringify(durable) !== JSON.stringify(desired)
      )
        return false;
    }
    const recovery = readComposerRecoveryIndex(recoveryRaw);
    if (recovery.unsupported || readComposerWorkingIndex(workingRaw).unsupported) return false;
    let workingIndex: unknown = workingRaw;
    let summaries = recovery.summaries;
    for (const record of snapshot.records.values()) {
      if (isComposerWorkingRecord(record)) {
        const next = nextWorkingSummaries(workingIndex, record.address, record);
        if (!next) return false;
        workingIndex = workingIndexRecord(next);
      } else if (isComposerRecoveryRecord(record)) {
        summaries = upsertComposerRecoverySummary(summaries, composerRecoverySummary(record));
      } else return false;
    }
    for (const key of snapshot.removed) {
      const record = snapshot.baseline.get(key);
      if (isComposerRecoveryRecord(record)) {
        summaries = summaries.filter((item) => item.id !== record.id);
      } else if (isComposerWorkingRecord(record)) {
        const next = nextWorkingSummaries(workingIndex, record.address, null);
        if (!next) return false;
        workingIndex = workingIndexRecord(next);
      } else return false;
    }
    for (const [key, record] of snapshot.records) store.put(record, key);
    for (const key of snapshot.removed) store.delete(key);
    if (workingIndex !== undefined) store.put(workingIndex, snapshot.workingIndexKey);
    store.put({ version: 2, summaries }, snapshot.recoveryIndexKey);
    return true;
  });
}
