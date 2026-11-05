import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteSync } from '../../../utils/atomicWrite';
import { withFileLock } from '../fileLock';

export interface TaskCreationJournalEntry {
  key: string;
  commandId: string;
  payloadHash: string;
  taskId: string;
  state: 'pending' | 'committed';
  /** Present for commands whose remote provenance can be reconciled. */
  creationToken?: string;
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
                !/^\d+$/.test(entry.taskId) ||
                (entry.creationToken !== undefined && typeof entry.creationToken !== 'string') ||
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
