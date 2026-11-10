import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { buildNativeAppManagedBootstrapCheckText } from '@shared/utils/teamInternalControlMessages';

import { NativeTeamConfigStore } from '../../infrastructure/NativeTeamConfigStore';
import { isNativeTeamRunOwner } from '../../infrastructure/nativeTeamRunOwnership';

import type { MemberProcessToken, OwnedProcessIdentity } from '../../../contracts';
import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeTeamConfig } from '../../infrastructure/NativeTeamConfigStore';
import type { NativeRuntimeConnectionExpected } from './NativeRuntimeConnection';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';

interface Dependencies {
  teamsRoot: string;
  inbox: Pick<TeamInboxWriter, 'sendMessage'>;
  invalidate(teamName: string): void;
}

export interface NativeMemberRegistrationProof extends Pick<
  NativeRuntimeConnectionExpected,
  'proofToken' | 'contextHash' | 'briefingHash' | 'boundaryMs'
> {
  eventsPath: string;
}

/** Writes process projections, never a configured-roster source or liveness verdict. */
export class NodeNativeMemberRegistration {
  private readonly store: NativeTeamConfigStore;

  constructor(private readonly ports: Dependencies) {
    this.store = new NativeTeamConfigStore(ports.teamsRoot);
  }

  async register(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>,
    proof: NativeMemberRegistrationProof,
    signal: AbortSignal
  ): Promise<void> {
    if (settings.role !== 'member') throw new Error('Invalid configured member registration');
    const leadName = await this.registerProcess(settings, token, identity, signal, {
      bootstrapExpectedAfter: new Date(proof.boundaryMs).toISOString(),
      bootstrapRuntimeEventsPath: proof.eventsPath,
      bootstrapProofToken: proof.proofToken,
      bootstrapRunId: token.runId,
      bootstrapProofMode: 'native_app_managed_context',
      bootstrapContextHash: proof.contextHash,
      bootstrapBriefingHash: proof.briefingHash,
    });
    signal.throwIfAborted();
    await this.ports.inbox.sendMessage(
      token.teamName,
      {
        member: token.memberName,
        from: leadName,
        to: token.memberName,
        text: buildNativeAppManagedBootstrapCheckText(),
        messageId: `native-bootstrap-${token.operationId}`,
        conversationId: `native-bootstrap-${token.operationId}`,
        source: 'system_notification',
        summary: `Private startup check for ${token.memberName}`,
        leadSessionId: token.runId,
      },
      { teamsBasePath: this.ports.teamsRoot, shouldStillWrite: () => !signal.aborted }
    );
  }

  async registerLead(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>,
    signal: AbortSignal
  ): Promise<void> {
    if (settings.role !== 'lead') throw new Error('Invalid configured lead registration');
    await this.registerProcess(settings, token, identity, signal, {});
  }

  async release(
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>
  ): Promise<void> {
    await this.store.mutate(token.teamName, new AbortController().signal, async (config) => {
      const claim = config?.appManagedRun as { identity?: unknown } | undefined;
      if (
        !config ||
        !isNativeTeamRunOwner(claim?.identity, token) ||
        !Array.isArray(config.members)
      )
        return null;
      const member = config.members.find(
        (value: unknown): value is NativeTeamConfig =>
          !!value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          (value as NativeTeamConfig).name === token.memberName
      );
      if (
        member?.runtimePid !== identity.pid ||
        member.runtimeProcessBirthId !== identity.birthId ||
        member.runtimeGeneration !== token.generation ||
        member.runtimeOperationId !== token.operationId
      )
        return null;
      for (const key of Object.keys(member))
        if (/^(runtime|bootstrap)/.test(key)) delete member[key];
      return config;
    });
    this.ports.invalidate(token.teamName);
  }

  private async registerProcess(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>,
    signal: AbortSignal,
    proof: NativeTeamConfig
  ): Promise<string> {
    signal.throwIfAborted();
    if (
      !validateTeamName(token.teamName).valid ||
      !validateMemberName(token.memberName).valid ||
      settings.memberName !== token.memberName ||
      !isNativeTeamRunOwner(settings.team, token) ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      !identity.birthId ||
      !Number.isSafeInteger(token.generation) ||
      token.generation < 1 ||
      !token.operationId
    ) {
      throw new Error('Invalid configured process registration');
    }
    let leadName = '';
    await this.store.mutate(token.teamName, signal, async (config) => {
      const claim = config?.appManagedRun as
        | { identity?: unknown; configurationRevision?: unknown }
        | undefined;
      if (
        config?.name !== token.teamName ||
        !Array.isArray(config.members) ||
        config.deletedAt ||
        !isNativeTeamRunOwner(claim?.identity, token) ||
        claim?.configurationRevision !== settings.configurationRevision
      ) {
        throw new Error('Configured team projection owner is unavailable');
      }
      const members = config.members as unknown[];
      const rows = members.filter(
        (value): value is NativeTeamConfig =>
          !!value && typeof value === 'object' && !Array.isArray(value)
      );
      const member = rows.find((row) => row.name === token.memberName);
      const lead = rows.find((row) => row.agentId === config.leadAgentId);
      if (
        !member ||
        member.removedAt ||
        !lead ||
        typeof lead.name !== 'string' ||
        (member === lead) !== (settings.role === 'lead')
      )
        throw new Error('Member is not configured in the existing team runtime projection');
      if (
        (member.runtimePid != null && member.runtimePid !== identity.pid) ||
        (member.runtimeOperationId != null && member.runtimeOperationId !== token.operationId) ||
        (member.runtimeProcessBirthId != null && member.runtimeProcessBirthId !== identity.birthId)
      ) {
        throw new Error('Native member projection belongs to another process attempt');
      }
      leadName = lead.name;
      Object.assign(member, {
        agentId: `${token.memberName}@${token.teamName}`,
        provider: settings.providerId,
        providerId: settings.providerId,
        cwd: settings.workingDirectory,
        ...(settings.worktree
          ? {
              worktreePath: settings.workingDirectory,
              worktreeBranch: settings.worktree.branchName,
              worktreeGitRoot: settings.worktree.baseRepoPath,
              worktreeBaseWorkspaceRoot: settings.worktree.baseRepoPath,
            }
          : {}),
        model: settings.model,
        effort: settings.effort,
        backendType: 'process',
        runtimePid: identity.pid,
        runtimeProcessBirthId: identity.birthId,
        // Recorded so a later launch can tell a reused pid from our own process.
        runtimeStartedAt: Date.now(),
        runtimeGeneration: token.generation,
        runtimeOperationId: token.operationId,
        ...proof,
      });
      signal.throwIfAborted();
      return config;
    });
    this.ports.invalidate(token.teamName);
    return leadName;
  }
}
