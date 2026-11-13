import { randomUUID } from 'node:crypto';

import type {
  MemberProcessToken,
  TeamLifecycleSnapshot,
  TeamRunIdentity,
} from '../../../contracts';
import type { AttachmentPayload } from '@shared/types';

interface Dependencies {
  snapshot(teamName: string): Readonly<TeamLifecycleSnapshot>;
  encode(
    text: string,
    run: Readonly<TeamRunIdentity>,
    attachments: readonly Readonly<AttachmentPayload>[]
  ): Promise<string>;
  write(token: MemberProcessToken, line: string, operationId: string): Promise<void>;
}

/** Selects the current configured lead before encoding, then fences the write by that exact attempt. */
export class SendLeadMessage {
  constructor(private readonly ports: Dependencies) {}

  async execute(
    identity: TeamRunIdentity,
    text: string,
    attachments: readonly Readonly<AttachmentPayload>[] = [],
    operationId?: string
  ): Promise<void> {
    if (!text.trim() && attachments.length === 0) throw new Error('Lead message must not be empty');
    const capturedAttachments = Object.freeze(
      attachments.map((attachment) => Object.freeze({ ...attachment }))
    );
    const run = Object.freeze({ ...identity });
    const snapshot = this.ports.snapshot(run.teamName);
    const current = snapshot.identity;
    if (
      current.appInstanceId !== run.appInstanceId ||
      current.dataRootFingerprint !== run.dataRootFingerprint ||
      current.connectionGeneration !== run.connectionGeneration ||
      current.runId !== run.runId
    ) {
      throw new Error('Team run is no longer current');
    }
    const lead = Object.values(snapshot.members).find((member) => member.role === 'lead');
    if (
      snapshot.desired !== 'running' ||
      lead?.membership !== 'configured' ||
      lead.desired !== 'running' ||
      !lead.process ||
      !lead.operationId
    )
      throw new Error('Configured lead is not running');
    if (operationId !== undefined && !operationId.trim())
      throw new Error('Lead command identity must be nonempty');
    const commandId = operationId ?? randomUUID();
    const token = Object.freeze({
      ...run,
      memberName: lead.memberName,
      generation: lead.generation,
      operationId: lead.operationId,
    });
    const line = await this.ports.encode(text, run, capturedAttachments);
    await this.ports.write(token, line, commandId);
  }
}
