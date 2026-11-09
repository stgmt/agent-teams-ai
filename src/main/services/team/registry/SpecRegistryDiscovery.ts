import { isRecord } from './RegistryJson';
import { RegistryMcpTransport } from './RegistryMcpTransport';
import { resolveRegistryTaskClientConfig } from './RegistryTaskClientConfig';
import { RegistryTaskClientError, RegistryTaskProtocolError } from './RegistryTaskClientErrors';

import type { ResolveRegistryTaskClientConfigInput } from './RegistryTaskClientConfig';
import type { SpecRegistryDiscovery } from '@shared/types';

export interface SpecRegistryDiscoveryOptions extends ResolveRegistryTaskClientConfigInput {
  fetchImpl?: typeof globalThis.fetch;
}

/** Discover projects and specifications using the same endpoint and credential as task reads. */
export async function discoverSpecRegistry(
  options: SpecRegistryDiscoveryOptions = {}
): Promise<SpecRegistryDiscovery> {
  try {
    const config = await resolveRegistryTaskClientConfig(options);
    const transport = new RegistryMcpTransport({
      ...config,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const result = await transport.callTool(
      'spec_registry',
      { allProjects: true },
      'discoverSpecRegistry'
    );
    if (!isRecord(result.data) || !Array.isArray(result.data.projects)) {
      throw new RegistryTaskProtocolError('discoverSpecRegistry', 'Invalid project list');
    }

    const projects = result.data.projects.map((project: unknown) => {
      if (!isRecord(project) || typeof project.id !== 'string' || !project.id.trim()) {
        throw new RegistryTaskProtocolError('discoverSpecRegistry', 'Invalid project entry');
      }
      if (!Array.isArray(project.specs)) {
        if (typeof project.error === 'string' && project.error.trim()) {
          return { id: project.id, specs: [], unavailable: true as const };
        }
        throw new RegistryTaskProtocolError('discoverSpecRegistry', 'Invalid project entry');
      }
      const specs = project.specs.map((spec: unknown) => {
        if (!isRecord(spec) || typeof spec.slug !== 'string' || !spec.slug.trim()) {
          throw new RegistryTaskProtocolError(
            'discoverSpecRegistry',
            'Invalid specification entry'
          );
        }
        return { slug: spec.slug };
      });
      return { id: project.id, specs };
    });

    // A configured URL may contain credentials or query parameters. Never send them to the UI.
    const url = new URL(config.url);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { url: url.toString(), projects };
  } catch (error) {
    // IPC errors and logs must not include configuration or server-provided secrets.
    throw new Error(
      error instanceof RegistryTaskClientError ? error.code : 'REGISTRY_REQUEST_FAILED'
    );
  }
}
