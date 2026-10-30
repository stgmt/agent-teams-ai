import type { TeamOperationGate } from './ports/MemberRuntimePorts';

export class TeamOperationQueue implements TeamOperationGate {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(teamName) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(teamName, tail);
    void tail.then(() => {
      if (this.tails.get(teamName) === tail) this.tails.delete(teamName);
    });
    return result;
  }
}
