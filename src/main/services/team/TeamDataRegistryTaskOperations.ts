import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { signTaskGenesisAttestation } from '../identity/TaskAttestation';

import {
  RegistryTaskProvider,
  RegistryTaskProviderError,
  type RegistryTaskScope,
} from './registry/RegistryTaskProvider';
import {
  type RegistryTaskGenesisSigner,
  RegistryTeamTaskWriteError,
  type RegistryTeamTaskWriter,
} from './registry/RegistryTeamTaskWriter';
import { createRegistryTeamTaskWriter } from './registry/RegistryTeamTaskWriterFactory';
import {
  resolveRegistryBindingConfig,
  resolveTeamSpecBindings,
  resolveTeamSpecScope,
  type TeamSpecBinding,
  type TeamSpecBindingConfig,
  TeamSpecBindingError,
} from './registry/TeamSpecBinding';
import { TeamConfigReader } from './TeamConfigReader';

import type { DesktopSigningKeyStore } from '../identity/DesktopSigningKeyStore';
import type { TeamMetaStore } from './TeamMetaStore';
import type { RegistryRegistrationIdentity, TeamConfig, TeamTask } from '@shared/types';

export interface TeamRegistryTaskWriterRequest {
  teamName: string;
  binding: TeamSpecBinding;
}

export type TeamRegistryTaskWriterProvider = (
  request: TeamRegistryTaskWriterRequest
) => Promise<RegistryTeamTaskWriter>;

export interface RegistryTaskWriteTarget {
  task: TeamTask;
  writer: RegistryTeamTaskWriter;
  teamId: string;
}

/** Owns registry task write authority, registration state and writer reuse. */
export class TeamDataRegistryTaskOperations {
  private readonly registryTaskWriters = new Map<
    string,
    { key: string; writer: Promise<RegistryTeamTaskWriter> }
  >();
  private readonly registryTeamRegistrationInFlight = new Map<
    string,
    Promise<TeamSpecBindingConfig>
  >();
  private readonly registryTeamTaskWriterProvider: TeamRegistryTaskWriterProvider;

  constructor(
    private readonly configReader: Pick<TeamConfigReader, 'updateSpecScope'>,
    private readonly teamMetaStore: Pick<TeamMetaStore, 'getMeta' | 'updateMeta'>,
    private readonly readSnapshotConfig: (teamName: string) => Promise<TeamConfig | null>,
    private readonly getRegistryTaskProvider: () => RegistryTaskProvider,
    private readonly taskSigningKeyStoreFactory: () => Promise<DesktopSigningKeyStore>,
    writerProvider?: TeamRegistryTaskWriterProvider
  ) {
    this.registryTeamTaskWriterProvider =
      writerProvider ?? ((request) => this.createDefaultRegistryTaskWriter(request));
  }

  invalidateWriter(teamName: string): void {
    this.registryTaskWriters.delete(teamName);
  }

  async readRegistryBindingConfig(teamName: string): Promise<TeamSpecBindingConfig | null> {
    const config = await resolveRegistryBindingConfig(teamName, {
      readConfig: (name) => this.readSnapshotConfig(name),
      readMetadata: (name) => this.teamMetaStore.getMeta(name),
    });
    if (config) return config;

    let configFileExists = false;
    try {
      await fs.promises.lstat(path.join(getTeamsBasePath(), teamName, 'config.json'));
      configFileExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const metadata = await this.teamMetaStore.getMeta(teamName);
    const metadataBindings = metadata ? resolveTeamSpecBindings(metadata, teamName) : [];
    if (
      configFileExists ||
      metadataBindings.length > 0 ||
      (typeof metadata?.registryTeamId === 'string' && metadata.registryTeamId.trim()) ||
      (typeof metadata?.registryRegistrationRequestId === 'string' &&
        metadata.registryRegistrationRequestId.trim())
    ) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: `Team "${teamName}" task authority could not be verified because its configuration or registry metadata is incomplete.`,
      });
    }
    return null;
  }

  async readRegistryTaskAuthority(teamName: string): Promise<{
    config: TeamSpecBindingConfig | null;
    bindings: TeamSpecBinding[];
    backed: boolean;
  }> {
    const config = await this.readRegistryBindingConfig(teamName);
    if (!config) return { config: null, bindings: [], backed: false };
    const bindings = resolveTeamSpecBindings(config, teamName);
    const backed =
      config.specScope !== undefined ||
      (typeof config.registryTeamId === 'string' && config.registryTeamId.trim().length > 0) ||
      (typeof config.registryRegistrationRequestId === 'string' &&
        config.registryRegistrationRequestId.trim().length > 0) ||
      config.registryRegistrationCompleted === false;
    return { config, bindings, backed };
  }

  async persistRegistryBindings(
    teamName: string,
    bindings: readonly TeamSpecBinding[]
  ): Promise<void> {
    const config = await this.readSnapshotConfig(teamName);
    const current = await this.teamMetaStore.getMeta(teamName);
    const scope = { ...resolveTeamSpecScope(current, teamName), bindings: [...bindings] };
    await this.teamMetaStore.updateMeta(teamName, (current) => {
      if (!current) throw new Error('Team metadata is missing or unreadable');
      const { version: _version, ...metadata } = current;
      return { ...metadata, specScope: scope };
    });
    if (config) {
      if (!(await this.configReader.updateSpecScope(teamName, scope))) {
        throw new Error('Team configuration is missing or unreadable');
      }
    }
    TeamConfigReader.invalidateListTeamsCache();
  }

  async markRegistryRegistrationCompleted(teamName: string): Promise<void> {
    await this.teamMetaStore.updateMeta(teamName, (current) => {
      if (!current) throw new Error('Team metadata is missing or unreadable');
      const { version: _version, ...metadata } = current;
      return { ...metadata, registryRegistrationCompleted: true };
    });
  }

  /**
   * Bindings are team configuration. The registry exposes no tool that lists,
   * links or registers them, so this never leaves the app: it persists the
   * bindings and marks the team configured.
   */
  async ensureRegistryTeamRegistration(
    teamName: string,
    initialConfig: TeamSpecBindingConfig,
    desiredBindings: readonly TeamSpecBinding[]
  ): Promise<TeamSpecBindingConfig> {
    const pending = this.registryTeamRegistrationInFlight.get(teamName);
    if (pending) return pending;
    const request = (async () => {
      // Registration is durable; repeating the two writes on every board read
      // put file locks on the read path and made reads take seconds under load.
      const meta = await this.teamMetaStore.getMeta(teamName);
      const persisted = meta?.specScope?.bindings ?? [];
      const sameBindings =
        persisted.length === desiredBindings.length &&
        persisted.every((binding, index) => {
          const desired = desiredBindings[index];
          return (
            binding !== null &&
            typeof binding === 'object' &&
            desired !== undefined &&
            binding.project === desired.project &&
            binding.spec === desired.spec
          );
        });
      if (meta?.registryRegistrationCompleted === true && sameBindings) {
        return {
          ...initialConfig,
          specScope: {
            ...resolveTeamSpecScope(initialConfig, teamName),
            bindings: [...desiredBindings],
          },
          registryRegistrationCompleted: true,
        } satisfies TeamSpecBindingConfig;
      }
      await this.persistRegistryBindings(teamName, [...desiredBindings]);
      await this.markRegistryRegistrationCompleted(teamName);
      const config = (await this.readRegistryBindingConfig(teamName)) ?? initialConfig;
      return {
        ...config,
        specScope: { ...resolveTeamSpecScope(config, teamName), bindings: [...desiredBindings] },
        registryRegistrationCompleted: true,
      } satisfies TeamSpecBindingConfig;
    })();
    this.registryTeamRegistrationInFlight.set(teamName, request);
    try {
      return await request;
    } finally {
      if (this.registryTeamRegistrationInFlight.get(teamName) === request)
        this.registryTeamRegistrationInFlight.delete(teamName);
    }
  }

  async createDefaultRegistryTaskWriter(
    request: TeamRegistryTaskWriterRequest
  ): Promise<RegistryTeamTaskWriter> {
    const { config, bindings, backed } = await this.readRegistryTaskAuthority(request.teamName);
    if (
      !config ||
      !backed ||
      !bindings.some(
        (binding) =>
          binding.project === request.binding.project && binding.spec === request.binding.spec
      )
    ) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_UNLINKED',
        teamName: request.teamName,
        project: request.binding.project,
        spec: request.binding.spec,
        message: `Registry scope "${request.binding.project}/${request.binding.spec}" is not linked to team "${request.teamName}".`,
      });
    }
    const registered = await this.ensureRegistryTeamRegistration(
      request.teamName,
      config,
      bindings
    );
    // Optional: the registry addresses tasks by project and spec.
    const teamId =
      typeof registered.registryTeamId === 'string' ? registered.registryTeamId.trim() : '';
    const registrationMeta = await this.teamMetaStore.getMeta(request.teamName);
    const expectedRegistrationIdentity: RegistryRegistrationIdentity | undefined =
      registrationMeta?.registryRegistrationIdentity;
    const genesisSigner: RegistryTaskGenesisSigner = async (expected, challenge) =>
      signTaskGenesisAttestation(await this.taskSigningKeyStoreFactory(), expected, challenge);
    return createRegistryTeamTaskWriter({
      teamName: request.teamName,
      teamId,
      binding: request.binding,
      expectedRegistrationIdentity,
      signTaskGenesisAttestation: genesisSigner,
    });
  }

  async resolveRegistryTeamTaskWriter(
    teamName: string,
    binding: TeamSpecBinding
  ): Promise<RegistryTeamTaskWriter> {
    const { config, bindings, backed } = await this.readRegistryTaskAuthority(teamName);
    if (!config || !backed) {
      throw new TeamSpecBindingError(
        'SPEC_PROJECT_MISSING',
        teamName,
        `Team ${teamName} requires a linked spec before it can write canonical tasks`
      );
    }
    if (
      !bindings.some(
        (candidate) => candidate.project === binding.project && candidate.spec === binding.spec
      )
    ) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_UNLINKED',
        teamName,
        project: binding.project,
        spec: binding.spec,
        message: `Registry scope "${binding.project}/${binding.spec}" is not linked to team "${teamName}".`,
      });
    }
    const key = `${binding.project}\u0000${binding.spec}`;
    const cached = this.registryTaskWriters.get(teamName);
    if (cached?.key === key) return cached.writer;
    const writer = this.registryTeamTaskWriterProvider({ teamName, binding });
    const entry = { key, writer };
    this.registryTaskWriters.set(teamName, entry);
    writer.catch(() => {
      if (this.registryTaskWriters.get(teamName) === entry) {
        this.registryTaskWriters.delete(teamName);
      }
    });
    return writer;
  }

  async resolveRegistryTaskWriterForTask(
    teamName: string,
    taskId: string,
    requestedBinding?: RegistryTaskScope
  ): Promise<RegistryTeamTaskWriter> {
    const { bindings } = await this.readRegistryTaskAuthority(teamName);
    let binding: TeamSpecBinding | undefined;
    if (requestedBinding) {
      binding = bindings.find(
        (candidate) =>
          candidate.project === requestedBinding.project && candidate.spec === requestedBinding.spec
      );
      if (!binding) {
        throw new RegistryTaskProviderError({
          code: 'REGISTRY_SCOPE_UNLINKED',
          teamName,
          project: requestedBinding.project,
          spec: requestedBinding.spec,
          message: `Registry scope "${requestedBinding.project}/${requestedBinding.spec}" is not linked to team "${teamName}".`,
        });
      }
    } else if (bindings.length === 1) {
      binding = bindings[0];
    } else {
      const scope = await this.getRegistryTaskProvider().getTaskScope(teamName, taskId, {
        forceRefresh: true,
      });
      binding = scope
        ? bindings.find(
            (candidate) => candidate.project === scope.project && candidate.spec === scope.spec
          )
        : undefined;
    }
    if (!binding) {
      throw new RegistryTeamTaskWriteError(
        'TASK_NOT_FOUND',
        `Task "${taskId}" was not found in the linked registry scopes.`,
        { taskId }
      );
    }
    return this.resolveRegistryTeamTaskWriter(teamName, binding);
  }

  async readRegistryTaskForWrite(
    teamName: string,
    taskId: string,
    requestedBinding?: RegistryTaskScope
  ): Promise<RegistryTaskWriteTarget> {
    const authority = await this.readRegistryTaskAuthority(teamName);
    if (!authority.backed) {
      if (requestedBinding) {
        throw new RegistryTaskProviderError({
          code: 'REGISTRY_SCOPE_UNLINKED',
          teamName,
          project: requestedBinding.project,
          spec: requestedBinding.spec,
          message: `Team "${teamName}" is not linked to registry scope "${requestedBinding.project}/${requestedBinding.spec}".`,
        });
      }
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: `Team "${teamName}" has no configured registry task scope.`,
      });
    }
    if (!authority.config) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: `Team "${teamName}" registry binding is unavailable.`,
      });
    }
    const registeredConfig =
      authority.bindings.length > 0
        ? await this.ensureRegistryTeamRegistration(teamName, authority.config, authority.bindings)
        : authority.config;
    // The registry scopes tasks by project and spec; a team identity is optional.
    const teamId =
      typeof registeredConfig.registryTeamId === 'string'
        ? registeredConfig.registryTeamId.trim()
        : '';
    const readOptions = requestedBinding
      ? { forceRefresh: true, binding: requestedBinding }
      : { forceRefresh: true };
    const { task } = await this.getRegistryTaskProvider().getTask(teamName, taskId, readOptions);
    if (!task) {
      throw new RegistryTeamTaskWriteError(
        'TASK_NOT_FOUND',
        `Task "${taskId}" was not found in the linked registry scopes.`,
        { taskId }
      );
    }
    const binding = requestedBinding ?? {
      project: task.specProject!,
      spec: task.specSlug!,
    };
    if (task.specProject !== binding.project || task.specSlug !== binding.spec) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_UNLINKED',
        teamName,
        project: binding.project,
        spec: binding.spec,
        message: `Task "${taskId}" is not in the requested registry scope.`,
      });
    }
    return {
      task,
      teamId,
      writer: await this.resolveRegistryTeamTaskWriter(teamName, binding),
    };
  }
}
