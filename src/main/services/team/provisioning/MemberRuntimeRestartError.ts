/**
 * State of the teammate's process when a restart failed:
 * - `running`: some process of the teammate is still alive (the old one was not stopped);
 * - `stopped`: no process of the teammate is alive (the old one is gone, the new one did not start).
 */
export type MemberRuntimeProcessState = 'running' | 'stopped';

/** A teammate restart failed; carries the real cause and what is left of the teammate's process. */
export class MemberRuntimeRestartError extends Error {
  constructor(
    message: string,
    readonly memberProcess: MemberRuntimeProcessState,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MemberRuntimeRestartError';
  }
}
