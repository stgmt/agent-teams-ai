import 'fake-indexeddb/auto';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { BoundControlContext } from '@features/external-agent-connection/main/BoundControlContext';
import {
  createTaskWriteGuardStorage,
  taskWriteGuardKey,
} from '@features/team-task-detail/renderer/adapters/taskWriteGuardStorage';
import { del } from 'idb-keyval';
import { afterEach, expect, it, vi } from 'vitest';

import { VERIFIED_ACTION_FENCE_DECISION, VERIFIED_ACTION_LIST } from '../contracts';
import { registerVerifiedActionIpc } from '../main/composition/registerVerifiedActionIpc';
import { FileVerifiedActionStore } from '../main/infrastructure/FileVerifiedActionStore';

import { VerifiedActionPanel } from './VerifiedActionPanel';

import type { TaskWriteDecision } from '@features/team-task-detail/contracts';
import type { IpcMain } from 'electron';

const paths = vi.hoisted(() => ({ appData: '', claude: '' }));
const bridge = vi.hoisted(() => ({
  list: vi.fn(),
  prepare: vi.fn(),
  approve: vi.fn(),
  decide: vi.fn(),
  fenceDecision: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('@main/utils/pathDecoder', () => ({
  getAppDataPath: () => paths.appData,
  getClaudeBasePath: () => paths.claude,
}));
vi.mock('@features/localization/renderer', () => ({ useAppTranslation: () => ({ t: bridge.t }) }));
vi.mock('@renderer/api', () => ({ api: { verifiedAction: bridge } }));

const identity = {
  contextId: 'local',
  teamName: 'team',
  taskId: 'task',
  dataRootFingerprint: 'b'.repeat(64),
};
const temporaryRoots: string[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function button(host: HTMLElement, text: string): HTMLButtonElement {
  const item = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text
  );
  if (!item) throw new Error(`Missing button: ${text}`);
  return item;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await del(taskWriteGuardKey(identity));
  const parent = await fs.promises.realpath(os.tmpdir());
  for (const root of temporaryRoots.splice(0)) {
    const resolved = await fs.promises.realpath(root);
    const relative = path.relative(parent, resolved);
    if (!relative.startsWith('verified-rebind-') || relative.includes(path.sep))
      throw new Error('Refusing to remove a fixture outside its scratch parent');
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
  document.body.innerHTML = '';
});

it('releases a proven unadmitted claim and fences only after a new explicit check', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verified-rebind-'));
  temporaryRoots.push(temporaryRoot);
  paths.appData = temporaryRoot;
  paths.claude = path.join(temporaryRoot, 'claude');
  const bound = new BoundControlContext('test-app', paths.claude);
  const oldContext = bound.snapshot();
  let liveContext = oldContext;
  const actionId = 'a'.repeat(64);
  const decisionId = '11111111-1111-4111-8111-111111111111';
  const claimId = '22222222-2222-4222-8222-222222222222';
  const action = {
    id: actionId,
    scope: identity.dataRootFingerprint,
    teamName: identity.teamName,
    taskId: identity.taskId,
    proof: { attachmentId: 'report', sha256: 'c'.repeat(64), size: 23 },
    status: 'question' as const,
    attempts: 1 as const,
    createdAt: 'now',
    updatedAt: 'now',
  };
  const fileStore = new FileVerifiedActionStore(path.join(temporaryRoot, 'verified-actions'));
  await fileStore.transaction((tx) => tx.write([action]));
  const enqueue = vi.spyOn(FileVerifiedActionStore.prototype, 'enqueue');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerVerifiedActionIpc(
    {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    } as unknown as IpcMain,
    {
      getActiveContextId: () => 'local',
      isLocal: () => true,
      getRootFingerprint: () => identity.dataRootFingerprint,
      withAdmission: async (context, _root, operation) => {
        const release = bound.admit(context);
        try {
          return await operation();
        } finally {
          release();
        }
      },
    }
  );
  bridge.list
    .mockReset()
    .mockImplementation((...args: unknown[]) => handlers.get(VERIFIED_ACTION_LIST)!({}, ...args));
  bridge.fenceDecision
    .mockReset()
    .mockImplementation((...args: unknown[]) =>
      handlers.get(VERIFIED_ACTION_FENCE_DECISION)!({}, ...args)
    );
  bridge.prepare.mockReset();
  bridge.approve.mockReset();
  bridge.decide.mockReset();
  const storage = createTaskWriteGuardStorage();
  const marker = {
    version: 1 as const,
    attemptId: 'token',
    operation: 'manifest' as const,
    decision: { actionId, decisionId, decision: 'retry_once' as const, stage: 'decision' as const },
  };
  await storage.beginDecision(identity, null, marker);
  const started = deferred<void>();
  const gate = deferred<void>();
  let hold = true;
  const guard = {
    taskWriteGuard: {
      status: 'ready' as const,
      reason: null,
      activeId: null,
      markerId: marker.attemptId,
      operation: 'manifest' as const,
      unknown: true,
      checked: false,
      expectedContext: oldContext,
      expectedRootFingerprint: identity.dataRootFingerprint,
      decision: marker.decision,
    },
    beginGuardedTaskWrite: vi.fn(),
    beginGuardedTaskDecision: vi.fn(),
    markGuardedDecisionFenceSent: vi.fn(async () => {
      if (hold) {
        started.resolve();
        await gate.promise;
      }
      return (await storage.markFenceSent(identity, marker, claimId)) ? claimId : null;
    }),
    releaseUnadmittedDecisionFence: vi.fn(
      (token: string, fingerprint: string, decision: TaskWriteDecision, claim: string) =>
        storage.releaseUnadmittedFence(
          { ...identity, dataRootFingerprint: fingerprint },
          { ...marker, attemptId: token, decision },
          claim
        )
    ),
    readGuardedTaskDecisionIds: vi.fn(() => storage.readChosenActionIds(identity)),
    settleGuardedTaskWrite: vi.fn(),
    checkGuardedTaskWriteOutcome: vi.fn(async () => ({
      expectedContext: liveContext,
      expectedRootFingerprint: identity.dataRootFingerprint,
    })),
    confirmGuardedTaskWriteOutcome: vi.fn(async () => storage.release(identity, marker)),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const reactRoot = createRoot(host);
  const render = (context: typeof oldContext) =>
    reactRoot.render(
      <VerifiedActionPanel
        contextId="local"
        teamName="team"
        taskId="task"
        enabled
        artifactRevision="same"
        canMutate={() => true}
        guard={{ ...guard, taskWriteGuard: { ...guard.taskWriteGuard, expectedContext: context } }}
      />
    );
  await act(async () => render(oldContext));
  await vi.waitFor(() => expect(button(host, 'verifiedAction.guardCheck').disabled).toBe(false));
  await act(async () => {
    button(host, 'verifiedAction.guardCheck').click();
    await started.promise;
  });
  await bound.closeAdmission();
  bound.rebind(paths.claude);
  liveContext = bound.snapshot();
  hold = false;
  await act(async () => {
    gate.resolve();
  });
  await vi.waitFor(() => expect(guard.releaseUnadmittedDecisionFence).toHaveBeenCalledOnce());
  expect(bridge.fenceDecision).toHaveBeenCalledOnce();
  expect(await storage.read(identity)).toEqual(marker);
  expect((await fileStore.transaction((tx) => tx.read()))[0]).toMatchObject({
    status: 'question',
    attempts: 1,
  });
  expect(bridge.decide).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  await act(async () => render(liveContext));
  await vi.waitFor(() => expect(button(host, 'verifiedAction.guardCheck').disabled).toBe(false));
  // No second fence is sent until the user explicitly asks to check again.
  expect(bridge.fenceDecision).toHaveBeenCalledOnce();
  await act(async () => button(host, 'verifiedAction.guardCheck').click());
  await vi.waitFor(() => expect(guard.confirmGuardedTaskWriteOutcome).toHaveBeenCalledOnce());
  expect(bridge.fenceDecision).toHaveBeenCalledTimes(2);
  expect(await storage.read(identity)).toBeNull();
  expect(await storage.readChosenActionIds(identity)).toEqual([actionId]);
  expect((await fileStore.transaction((tx) => tx.read()))[0]).toMatchObject({
    status: 'manual',
    decisionReceipt: { id: decisionId, decision: 'retry_once' },
    attempts: 1,
  });
  expect(bridge.decide).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  await act(async () => reactRoot.unmount());
  host.remove();
});
