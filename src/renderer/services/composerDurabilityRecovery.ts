import { composerDatabase } from './composerDatabase';
import { isComposerWorkingRecord } from './composerDraftRecovery';
import { persistComposerMemory } from './persistComposerMemory';

import type { ComposerMemorySnapshot } from './persistComposerMemory';

interface RecoveryPorts {
  capture(
    contextId: string,
    teamName: string
  ): Omit<ComposerMemorySnapshot, 'baseline' | 'removed'>;
  recovered(contextId: string, teamName: string): void;
}

export class ComposerDurabilityRecovery {
  private readonly baselines = new Map<string, ReadonlyMap<string, unknown>>();

  constructor(private readonly ports: RecoveryPorts) {}

  capture(contextId: string, teamName: string): void {
    const key = JSON.stringify([contextId, teamName]);
    if (this.baselines.has(key)) return;
    const records = this.ports.capture(contextId, teamName).records;
    this.baselines.set(
      key,
      new Map(
        [...records].map(([recordKey, value]) => [
          recordKey,
          isComposerWorkingRecord(value) && value.workingRevision === '0'
            ? undefined
            : structuredClone(value),
        ])
      )
    );
  }

  clear(contextId: string, teamName: string): void {
    this.baselines.delete(JSON.stringify([contextId, teamName]));
  }

  async retry(contextId: string, teamName: string): Promise<boolean> {
    await composerDatabase.reopen();
    const key = JSON.stringify([contextId, teamName]);
    const baseline = this.baselines.get(key);
    if (baseline) {
      const snapshot = this.ports.capture(contextId, teamName);
      // Cached, unchanged records are not writes: another window may have updated them.
      const records = new Map(
        [...snapshot.records].filter(
          ([recordKey, record]) =>
            JSON.stringify(record) !== JSON.stringify(baseline.get(recordKey))
        )
      );
      const removed = [...baseline.keys()].filter(
        (recordKey) => baseline.get(recordKey) !== undefined && !snapshot.records.has(recordKey)
      );
      if (!(await persistComposerMemory({ ...snapshot, records, baseline, removed }))) return false;
    }
    this.baselines.delete(key);
    this.ports.recovered(contextId, teamName);
    return true;
  }
}
