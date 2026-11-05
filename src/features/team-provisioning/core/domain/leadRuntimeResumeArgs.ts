import type { EffortLevel } from '@shared/types';

const OWNED_VALUE_FLAGS: Record<string, true> = {
  '--team-bootstrap-spec': true,
  '--team-bootstrap-user-prompt-file': true,
  '--model': true,
  '--effort': true,
  '--resume': true,
  '--session-id': true,
};

export function stripOwnedValueFlags(args: readonly string[]): string[] {
  const next: string[] = [];
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    const flag = value.split('=', 1)[0];
    if (flag !== value && flag in OWNED_VALUE_FLAGS) {
      index += 1;
      continue;
    }
    if (value in OWNED_VALUE_FLAGS) {
      index += 2;
      continue;
    }
    next.push(value);
    index += 1;
  }
  return next;
}

export function buildLeadRuntimeResumeArgs(input: {
  previousArgs: readonly string[];
  sessionId: string;
  model: string | null;
  effort: EffortLevel | null;
}): string[] {
  return [
    ...stripOwnedValueFlags(input.previousArgs),
    '--resume',
    input.sessionId,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
  ];
}
