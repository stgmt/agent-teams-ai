import { createRequire } from 'node:module';
import { afterEach, beforeEach, vi } from 'vitest';

import { createNodeMemberRuntimeFixture } from './nodeMemberRuntimeFixture';

import type { NativeClaudeSdkHost } from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeSdkHost';

export const nativeSpecScope = { projects: ['TEST/project'], bindings: [] };
export const nativeSpecRegistryEnvironment = async () => ({
  OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8650/mcp',
  OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
});

/** Each test uses the real host, socket endpoint and command ledger. */
export function installNativeSdkHostFixture(): () => NativeClaudeSdkHost {
  let host: NativeClaudeSdkHost;
  beforeEach(async () => {
    host = (await createNodeMemberRuntimeFixture()).host;
  });
  return () => host;
}

/** Reuse the isolated app-bound task API provider, never a legacy file task board. */
export function installNativeTaskControlFixture() {
  const require = createRequire(import.meta.url);
  const {
    startControlServer,
  } = require('../../../../agent-teams-controller/test/helpers/controlServer.js');
  const {
    resetTaskBackendCache,
  } = require('../../../../agent-teams-controller/src/internal/taskBackendSelection.js');
  const {
    resetSyncControlRequestChannel,
  } = require('../../../../agent-teams-controller/src/internal/syncControlRequest.js');
  const servers: { stop(): Promise<void> }[] = [];
  afterEach(async () => {
    resetTaskBackendCache();
    resetSyncControlRequestChannel();
    for (const server of servers.splice(0)) await server.stop();
    vi.unstubAllEnvs();
  });
  return async (
    claudeDir: string,
    context: {
      appInstanceId: string;
      dataRootFingerprint: string;
      connectionGeneration: number;
    }
  ): Promise<void> => {
    resetTaskBackendCache();
    const server = await startControlServer();
    servers.push(server);
    vi.stubEnv('AGENT_TEAMS_BOUND_CONTROL_URL', server.url);
    vi.stubEnv('AGENT_TEAMS_BOUND_CONTEXT_JSON', JSON.stringify(context));
    vi.stubEnv('AGENT_TEAMS_MCP_CLAUDE_DIR', claudeDir);
  };
}

export { deferred as nativeSdkDeferred } from './nodeMemberRuntimeFixture';
