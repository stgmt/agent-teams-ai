import { LeadReportSourceFailure } from './ports';

import type { SourceError } from '../../contracts';

type ReadSource = SourceError['source'] | 'roster';

/** One wall-clock budget shared by every source read of a single inspection. */
export class SourceDeadline {
  private readonly endsAt: number;

  constructor(budgetMs: number) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1)
      throw new Error('A positive source wait limit is required');
    this.endsAt = Date.now() + budgetMs;
  }

  remaining(): number {
    return Math.max(0, this.endsAt - Date.now());
  }
}

function timeout(source: ReadSource): Error {
  if (source === 'roster')
    return new Error(
      'The saved roster source did not answer within the report inspection deadline'
    );
  return new LeadReportSourceFailure({
    source,
    code: 'source-timeout',
    detail: 'The source did not answer within the report inspection deadline',
  });
}

/**
 * Bounds one read by the remaining inspection budget. A late answer is ignored:
 * it can neither renew the inspection age nor complete an abandoned operation.
 */
export function readSourceWithin<T>(
  deadline: SourceDeadline,
  source: ReadSource,
  read: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(timeout(source));
    }, deadline.remaining());
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Calling the reader inside a continuation routes a synchronous throw through
    // the same rejection handler as a late failure.
    void Promise.resolve().then(read).then(succeed, fail);
  });
}
