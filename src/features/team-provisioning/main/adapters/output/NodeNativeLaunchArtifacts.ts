import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildEvidenceBasedLeadReplyInstruction,
  buildLeadServiceRefreshInstruction,
} from '@features/lead-reporting/main';
import {
  canonicalizeNativeBootstrapContextText as canonicalText,
  hashNativeBootstrapText as hash,
} from '@main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import { ownedCleanup } from '../../infrastructure/ownedCleanup';
import { rejectAfterOwnedCleanup } from '../../infrastructure/rejectAfterOwnedCleanup';

import type { MemberProcessToken, OwnedProcessIdentity, TeamRunIdentity } from '../../../contracts';
import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeLaunchArtifacts } from './NativeClaudeLaunchPlanner';
import type { NodeNativeMemberRegistration } from './NodeNativeMemberRegistration';
import type { TeamMemberMcpPolicy } from '@shared/types';

const { AGENT_TEAMS_OPERATIONAL_LEAD_TOOL_NAMES } = agentTeamsControllerModule;

interface Dependencies {
  runtimeRoot: string;
  mcp: {
    writeConfigFile(
      cwd: string,
      options: {
        mcpPolicy?: TeamMemberMcpPolicy;
        controlApiBaseUrl: string;
        runtimeScope: { role: 'lead'; credential: string } | { role: 'member' };
        serverEnv?: Readonly<Record<string, string>>;
      }
    ): Promise<string>;
    removeConfigFile(path: string): Promise<void>;
  };
  controlUrl(): Promise<string>;
  leadCredential(run: TeamRunIdentity): string;
  briefing(settings: Readonly<ConfiguredMemberLaunch>): Promise<string>;
  registration: Pick<NodeNativeMemberRegistration, 'register' | 'registerLead' | 'release'>;
}

/** Materializes only files owned by one launch attempt, not team configuration or liveness. */
export class NodeNativeLaunchArtifacts {
  constructor(private readonly ports: Dependencies) {}

  async prepare(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<NativeLaunchArtifacts> {
    signal.throwIfAborted();
    const controlApiBaseUrl = await this.ports.controlUrl();
    signal.throwIfAborted();
    if (!controlApiBaseUrl) throw new Error('Bound desktop control URL is required');
    if (settings.role !== 'lead' && settings.role !== 'member')
      throw new Error('Configured runtime role is required');
    await mkdir(this.ports.runtimeRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.ports.runtimeRoot, 'owned-attempt-'));
    let mcpConfigPath: string | null = null;
    let processIdentity: Readonly<OwnedProcessIdentity> | null = null;
    const dispose = ownedCleanup(async () => {
      // Keep attempt evidence until its exact runtime projection has been released.
      if (processIdentity) await this.ports.registration.release(token, processIdentity);
      const results = await Promise.allSettled([
        mcpConfigPath ? this.ports.mcp.removeConfigFile(mcpConfigPath) : Promise.resolve(),
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
      ]);
      const errors: unknown[] = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      );
      if (errors.length)
        throw new AggregateError(errors, 'Owned native launch files could not be removed');
    });
    const write = async (name: string, content: string): Promise<string> => {
      signal.throwIfAborted();
      const path = join(directory, name);
      await writeFile(path, content, { mode: 0o600, flag: 'wx' });
      return path;
    };
    try {
      await chmod(directory, 0o700);
      signal.throwIfAborted();
      const lead = settings.role === 'lead';
      const specServerEnv = settings.specMcpServerEnv
        ? {
            ...settings.specMcpServerEnv,
            ...(settings.specScope
              ? { AGENT_TEAMS_SPEC_SCOPE: JSON.stringify(settings.specScope) }
              : {}),
          }
        : undefined;
      mcpConfigPath = await this.ports.mcp.writeConfigFile(settings.workingDirectory, {
        mcpPolicy: settings.mcpPolicy,
        controlApiBaseUrl,
        ...(specServerEnv ? { serverEnv: specServerEnv } : {}),
        runtimeScope: lead
          ? { role: 'lead', credential: this.ports.leadCredential(token) }
          : { role: 'member' },
      });
      signal.throwIfAborted();
      if (lead) {
        const bootstrapSpecPath = await write(
          'lead-bootstrap.json',
          JSON.stringify({
            version: 1,
            runId: token.runId,
            mode: 'launch',
            initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
            team: { name: token.teamName, cwd: settings.workingDirectory },
            lead: {
              permissionSeedTools: AGENT_TEAMS_OPERATIONAL_LEAD_TOOL_NAMES.map(
                (name) => `mcp__agent-teams__${name}`
              ),
            },
            // The desktop owns member spawning; the CLI attaches only this lead to the existing team.
            members: [],
            launch: { continueOnPartialFailure: false },
            ui: { emitStructuredEvents: true },
          })
        );
        const userPromptPath = await write(
          'lead-prompt.txt',
          [
            buildLeadServiceRefreshInstruction(),
            buildEvidenceBasedLeadReplyInstruction(),
            'Publish human replies only through message_send to user with the exact requestMessageId supplied by the application for that human turn. Native SendMessage is disabled; plain assistant text is the internal work log. Do not invent a requestMessageId or publish a reply when no human request is pending.',
            'The configured instructions below are standing team context, not an active human request.',
            settings.instructions,
          ].join('\n\n')
        );
        signal.throwIfAborted();
        return {
          mcpConfigPath,
          bootstrapSpecPath,
          userPromptPath,
          env: {},
          dispose,
          afterSpawn: (identity, lifetime) => {
            processIdentity = identity;
            return this.ports.registration.registerLead(settings, token, identity, lifetime);
          },
        };
      }
      const briefing = canonicalText(await this.ports.briefing(settings));
      if (!briefing || briefing.length > 18_000)
        throw new Error('Canonical native member briefing must be nonempty and bounded');
      signal.throwIfAborted();
      const contextText = canonicalText(
        [
          'Private Agent Teams startup context. Confirm the private bootstrap, then wait for assigned work.',
          `Team: ${token.teamName}`,
          `Member: ${token.memberName}`,
          `Project: ${settings.workingDirectory}`,
          briefing,
        ].join('\n\n')
      );
      const bootstrapProof = {
        proofToken: randomBytes(32).toString('base64url'),
        contextHash: hash(contextText),
        briefingHash: hash(briefing),
        boundaryMs: Date.now(),
      };
      const contextPath = await write(
        'member-context.json',
        JSON.stringify({
          schemaVersion: 1,
          kind: 'native_app_managed_bootstrap',
          mode: 'startup_context_file',
          teamName: token.teamName,
          memberName: token.memberName,
          agentId: `${token.memberName}@${token.teamName}`,
          runId: token.runId,
          provider: settings.providerId,
          contextText,
          contextHash: bootstrapProof.contextHash,
          briefingHash: bootstrapProof.briefingHash,
          generatedAt: new Date().toISOString(),
          bootstrapProofToken: bootstrapProof.proofToken,
        })
      );
      const eventsPath = await write('member-events.jsonl', '');
      signal.throwIfAborted();
      return {
        mcpConfigPath,
        eventsPath,
        bootstrapProof,
        dispose,
        afterSpawn: (identity, lifetime) => {
          processIdentity = identity;
          return this.ports.registration.register(
            settings,
            token,
            identity,
            { eventsPath, ...bootstrapProof },
            lifetime
          );
        },
        env: { CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH: contextPath },
      };
    } catch (error) {
      return rejectAfterOwnedCleanup(error, dispose);
    }
  }
}
