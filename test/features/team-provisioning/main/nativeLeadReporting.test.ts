// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBoundHumanRequestSubmission,
  createNativeLeadReporting,
  registerHumanRequestSubmissionIpc,
} from '../../../../src/features/team-provisioning/main';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';
import { createLeadHumanRequestBridge } from '../../../../src/features/team-provisioning/preload';

import type { PersistedLeadRequest } from '../../../../src/features/team-provisioning/core/application/ports/LeadRequestDeliveryPorts';
import type { MemberRuntimeEvents } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import type { InvokeIpcWithResult } from '../../../../src/features/team-provisioning/preload';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      })
    )
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-lead-reporting-'));
  directories.push(root);
  const teamsRoot = join(root, 'teams');
  const owner = { appInstanceId: 'TEST-app', dataRootFingerprint: root, connectionGeneration: 1 };
  const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
  await mkdir(join(teamsRoot, run.teamName), { recursive: true });
  await writeFile(
    join(teamsRoot, run.teamName, 'config.json'),
    JSON.stringify({
      name: run.teamName,
      leadAgentId: `team-lead@${run.teamName}`,
      members: [
        { name: 'team-lead', agentId: `team-lead@${run.teamName}`, agentType: 'team-lead' },
      ],
    })
  );
  const lifecycle = createMemberLifecycle({
    owner,
    settings: {
      findConfiguredMember: (team, memberName) =>
        Promise.resolve({
          team,
          memberName,
          configurationRevision: 'TEST-revision',
          providerId: 'TEST',
          model: null,
          workingDirectory: root,
          instructions: 'TEST',
        }),
    },
    runtime: {
      spawn() {
        let events: MemberRuntimeEvents;
        return Promise.resolve({
          identity: { pid: 100, birthId: 'TEST-owned' },
          writeInput: () => Promise.resolve(),
          subscribe(listener: MemberRuntimeEvents) {
            events = listener;
            listener.connected();
            return () => undefined;
          },
          stop() {
            events.exited({ code: 0, signal: null });
            events.released();
            return Promise.resolve();
          },
        });
      },
    },
  });
  await lifecycle.teams.launch(run, [{ memberName: 'team-lead', role: 'lead' }]);
  await lifecycle.commands.settled(run, 'team-lead');
  const human: PersistedLeadRequest = {
    run,
    requestMessageId: 'TEST-human-1',
    text: 'What is two plus two?',
    origin: { kind: 'human' },
    isMeta: false,
  };
  const requestFile = join(teamsRoot, run.teamName, 'sentMessages.json');
  const saveHuman = (request: PersistedLeadRequest): Promise<void> =>
    writeFile(
      requestFile,
      JSON.stringify([
        {
          from: 'user',
          to: 'team-lead',
          source: 'user_sent',
          messageId: request.requestMessageId,
          leadSessionId: request.run.runId,
          text: request.text,
          timestamp: '2026-10-29T02:30:00.000Z',
          read: true,
        },
      ])
    );
  await saveHuman(human);
  const send = vi.fn<(run: typeof human.run, text: string) => Promise<void>>(() =>
    Promise.resolve()
  );
  const changed = vi.fn();
  const meta = vi.fn(() => Promise.reject(new Error('TEST canonical roster unavailable')));
  const admission = new AbortController();
  // РИСК: real history reader/reporting/controller/inbox with a controlled lifecycle; no native CLI or production queue is exercised.
  const createFeature = () =>
    createNativeLeadReporting({
      lifecycle: {
        resolveLeadCredential: (credential) => {
          if (credential !== 'TEST-existing-credential') throw new Error('TEST unauthorized');
          lifecycle.registry.assertRun(run);
          return run;
        },
        snapshot: (teamName) => lifecycle.snapshot(teamName),
        queries: {
          snapshot: () => Promise.resolve(lifecycle.snapshot(run.teamName)),
          watch: () => Promise.resolve(lifecycle.watch(run.teamName)),
          aliveTeamNames: () => Promise.resolve(lifecycle.registry.aliveTeamNames()),
          aliveRunId: () => Promise.resolve(lifecycle.registry.aliveRunId(run.teamName)),
        },
        taskChanges: { read: () => Promise.resolve(null) },
        sendLeadMessage: (identity, text) => send(identity, text),
      },
      reporting: {
        teamsRoot,
        members: { getMeta: meta },
        leadName: () => Promise.resolve('team-lead'),
        changed,
      },
      contextInvalidationSignal: () => admission.signal,
    });
  return {
    feature: createFeature(),
    createFeature,
    lifecycle,
    human,
    run,
    requestFile,
    saveHuman,
    send,
    changed,
    meta,
    admission,
    inbox: join(teamsRoot, run.teamName, 'inboxes', 'user.json'),
  };
}

describe('native lifecycle reporting and exact persisted human-turn composition', () => {
  it('carries a trusted plain-value submission through canonical persistence, admission, exact durable reply and the next question', async () => {
    const { feature, run, human, requestFile, send, admission, inbox } = await setup();
    await rm(requestFile);
    const submission = createBoundHumanRequestSubmission({
      owner: run,
      submit: (identity, id, text) => feature.submitHumanRequest(identity, id, text),
      invalidationSignal: () => admission.signal,
      withExpectedContext: (_expected, operation) => operation(),
    });
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
    const sender = { mainFrame: {}, isDestroyed: () => false };
    const dispose = registerHumanRequestSubmissionIpc(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
        removeHandler: (channel) => {
          handlers.delete(channel);
        },
      },
      submission,
      () => sender as unknown as WebContents
    );
    const bridge = createLeadHumanRequestBridge(
      (async (channel: string, input: unknown) =>
        await handlers.get(channel)!(
          { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent,
          input
        )) as InvokeIpcWithResult
    );
    const request = {
      expectedContext: run,
      teamName: run.teamName,
      runId: run.runId,
      requestMessageId: human.requestMessageId,
      text: human.text,
    };
    try {
      await expect(bridge.submitHumanRequest(request)).resolves.toMatchObject({ state: 'sent' });
      await expect(bridge.submitHumanRequest(request)).resolves.toMatchObject({ state: 'sent' });
      expect(send).toHaveBeenCalledOnce();
      const next = { ...request, requestMessageId: 'TEST-next', text: 'What is three plus three?' };
      await expect(bridge.submitHumanRequest(next)).resolves.toMatchObject({
        requestMessageId: 'TEST-next',
        state: 'queued',
      });
      expect(JSON.parse(await readFile(requestFile, 'utf8'))).toHaveLength(2);
      await feature.reporting.reply('TEST-existing-credential', request.requestMessageId, 'Four.');
      await expect(bridge.submitHumanRequest(request)).resolves.toMatchObject({
        state: 'delivered',
      });
      expect(JSON.parse(await readFile(inbox, 'utf8'))).toEqual([
        expect.objectContaining({ replyToMessageIds: [request.requestMessageId], text: 'Four.' }),
      ]);
      await expect(bridge.submitHumanRequest(next)).resolves.toMatchObject({ state: 'sent' });
      expect(send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await readFile(requestFile, 'utf8'))).toHaveLength(2);
      await expect(
        bridge.submitHumanRequest({
          ...request,
          runId: 'TEST-successor',
          requestMessageId: 'TEST-foreign',
        })
      ).rejects.toThrow('current');
      expect(JSON.parse(await readFile(requestFile, 'utf8'))).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it('saves an original human request before reporting or stdin can observe it and deduplicates an exact submission retry', async () => {
    const { feature, run, human, requestFile, send } = await setup();
    await rm(requestFile);
    send.mockImplementationOnce(async () => {
      const saved = JSON.parse(await readFile(requestFile, 'utf8'));
      expect(saved).toEqual([
        expect.objectContaining({
          messageId: human.requestMessageId,
          from: 'user',
          to: 'team-lead',
          source: 'user_sent',
          leadSessionId: run.runId,
          text: human.text,
        }),
      ]);
    });
    await expect(
      feature.submitHumanRequest(run, human.requestMessageId, human.text)
    ).resolves.toMatchObject({ state: 'sent' });
    await expect(
      feature.submitHumanRequest(run, human.requestMessageId, human.text)
    ).resolves.toMatchObject({ state: 'sent' });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(requestFile, 'utf8'))).toHaveLength(1);
    await expect(
      feature.submitHumanRequest(run, human.requestMessageId, 'Changed question')
    ).rejects.toThrow('differs');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not admit or write stdin when canonical human persistence fails', async () => {
    const { feature, run, human, requestFile, send, meta } = await setup();
    await writeFile(requestFile, 'TEST malformed saved history');
    await expect(
      feature.submitHumanRequest(run, human.requestMessageId, human.text)
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
    expect(await readFile(requestFile, 'utf8')).toBe('TEST malformed saved history');
  });

  it('persists the exact human original before admission itself delivers a limitation without stdin', async () => {
    const { feature, run, human, requestFile, send, inbox } = await setup();
    await rm(requestFile);
    const text = 'Report progress for the whole team';
    await expect(
      feature.submitHumanRequest(run, human.requestMessageId, text)
    ).resolves.toMatchObject({ state: 'delivered' });
    expect(JSON.parse(await readFile(requestFile, 'utf8'))).toEqual([
      expect.objectContaining({ messageId: human.requestMessageId, text }),
    ]);
    expect(JSON.parse(await readFile(inbox, 'utf8'))).toEqual([
      expect.objectContaining({ replyToMessageIds: [human.requestMessageId] }),
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('admits a saved ordinary question before stdin and closes it only after a real durable exact reply', async () => {
    const { feature, human, run, send, saveHuman, inbox, changed, meta } = await setup();
    const result = await feature.deliverPersistedHumanRequest(run, human.requestMessageId);
    expect(result).toMatchObject({ state: 'sent', requestMessageId: human.requestMessageId });
    expect(send).toHaveBeenCalledWith(run, expect.stringContaining(human.text));
    expect(send).toHaveBeenCalledWith(run, expect.stringContaining(human.requestMessageId));
    expect(meta).not.toHaveBeenCalled();
    expect(feature.reporting).not.toHaveProperty('acceptHumanRequest');
    await expect(readFile(inbox)).rejects.toMatchObject({ code: 'ENOENT' });
    const successor = {
      ...human,
      requestMessageId: 'TEST-human-2',
      text: 'What is three plus three?',
    };
    await saveHuman(successor);
    await expect(
      feature.deliverPersistedHumanRequest(run, successor.requestMessageId)
    ).resolves.toMatchObject({ state: 'queued' });
    const reply = await feature.reporting.reply(
      'TEST-existing-credential',
      human.requestMessageId,
      'Four.'
    );
    expect(reply.requestMessageId).toBe(human.requestMessageId);
    const rows = JSON.parse(await readFile(inbox, 'utf8'));
    expect(rows).toEqual([
      expect.objectContaining({
        text: 'Four.',
        replyToMessageIds: [human.requestMessageId],
        leadSessionId: run.runId,
      }),
    ]);
    expect(changed).toHaveBeenCalledOnce();
    await expect(
      feature.deliverPersistedHumanRequest(run, successor.requestMessageId)
    ).resolves.toMatchObject({ state: 'sent' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('handles roster limitation delivered inside accept without sending a duplicate human turn', async () => {
    const { feature, human, run, saveHuman, send, inbox, changed, meta } = await setup();
    const request = { ...human, text: 'Report the progress of the whole team' };
    await saveHuman(request);
    await expect(
      feature.deliverPersistedHumanRequest(run, request.requestMessageId)
    ).resolves.toEqual({
      requestMessageId: request.requestMessageId,
      state: 'delivered',
    });
    expect(meta).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    const rows = JSON.parse(await readFile(inbox, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      replyToMessageIds: [request.requestMessageId],
      replyChannel: 'explicit',
    });
    expect(rows[0].text).toContain('could not be read');
    await feature.deliverPersistedHumanRequest(run, request.requestMessageId);
    expect(changed).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(inbox, 'utf8'))).toEqual(rows);
    await saveHuman({ ...human, requestMessageId: 'TEST-next' });
    await expect(feature.deliverPersistedHumanRequest(run, 'TEST-next')).resolves.toMatchObject({
      state: 'sent',
    });
  });

  it('keeps the same exact request retryable after append failure, without pretending delivery or advancing the next turn', async () => {
    const { feature, human, run, inbox } = await setup();
    await feature.deliverPersistedHumanRequest(run, human.requestMessageId);
    await mkdir(inbox, { recursive: true });
    await expect(
      feature.reporting.reply('TEST-existing-credential', human.requestMessageId, 'Four.')
    ).rejects.toThrow();
    await expect(feature.deliverPersistedHumanRequest(run, 'TEST-next')).resolves.toMatchObject({
      state: 'queued',
    });
    await rm(inbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await feature.reporting.reply('TEST-existing-credential', human.requestMessageId, 'Four.');
    expect(JSON.parse(await readFile(inbox, 'utf8'))).toHaveLength(1);
    await expect(
      feature.deliverPersistedHumanRequest(run, human.requestMessageId)
    ).resolves.toMatchObject({ state: 'delivered' });
  });

  it('restores durable completion into a fresh delivery composition without admitting or sending the same request again', async () => {
    const { feature, createFeature, run, human, send, inbox } = await setup();
    await feature.deliverPersistedHumanRequest(run, human.requestMessageId);
    await feature.reporting.reply('TEST-existing-credential', human.requestMessageId, 'Four.');
    const restarted = createFeature();
    await expect(
      restarted.deliverPersistedHumanRequest(run, human.requestMessageId)
    ).resolves.toMatchObject({ state: 'delivered' });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(inbox, 'utf8'))).toHaveLength(1);
    await expect(
      restarted.reporting.reply(
        'TEST-existing-credential',
        human.requestMessageId,
        'Another answer'
      )
    ).rejects.toThrow();
  });

  it('retries immediate limitation notification without skipping reporting closure or sending stdin', async () => {
    const { feature, run, human, saveHuman, changed, send, inbox } = await setup();
    const request = { ...human, text: 'Report the whole team progress' };
    await saveHuman(request);
    changed.mockImplementationOnce(() => {
      throw new Error('TEST notification failed after append');
    });
    await expect(
      feature.deliverPersistedHumanRequest(run, request.requestMessageId)
    ).rejects.toThrow('notification failed');
    await expect(feature.deliverPersistedHumanRequest(run, 'TEST-next')).resolves.toMatchObject({
      state: 'queued',
    });
    await expect(
      feature.deliverPersistedHumanRequest(run, request.requestMessageId)
    ).resolves.toMatchObject({ state: 'delivered' });
    await saveHuman({ ...human, requestMessageId: 'TEST-next' });
    await expect(feature.deliverPersistedHumanRequest(run, 'TEST-next')).resolves.toMatchObject({
      state: 'sent',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(inbox, 'utf8'))).toHaveLength(1);
  });

  it('restores a sent input into a fresh composition without writing stdin twice, while still waiting for the exact answer', async () => {
    const { feature, createFeature, run, human, send } = await setup();
    await feature.deliverPersistedHumanRequest(run, human.requestMessageId);
    const restored = createFeature();
    await expect(
      restored.deliverPersistedHumanRequest(run, human.requestMessageId)
    ).resolves.toMatchObject({ state: 'sent' });
    expect(send).toHaveBeenCalledOnce();
    await expect(restored.deliverPersistedHumanRequest(run, 'TEST-next')).resolves.toMatchObject({
      state: 'queued',
    });
    await restored.reporting.reply('TEST-existing-credential', human.requestMessageId, 'Four.');
    await expect(
      restored.deliverPersistedHumanRequest(run, human.requestMessageId)
    ).resolves.toMatchObject({ state: 'delivered' });
  });

  it('preserves an uncertain input across fresh composition and never resends it to discover whether the first write arrived', async () => {
    const { feature, createFeature, run, human, send } = await setup();
    send.mockRejectedValueOnce(new Error('TEST pipe failed after possible acceptance'));
    await expect(feature.deliverPersistedHumanRequest(run, human.requestMessageId)).rejects.toThrow(
      'unconfirmed'
    );
    const restored = createFeature();
    await expect(
      restored.deliverPersistedHumanRequest(run, human.requestMessageId)
    ).rejects.toThrow('unconfirmed');
    expect(send).toHaveBeenCalledOnce();
    await restored.reporting.reply('TEST-existing-credential', human.requestMessageId, 'Four.');
    await expect(
      restored.deliverPersistedHumanRequest(run, human.requestMessageId)
    ).resolves.toMatchObject({ state: 'delivered' });
  });

  it('blocks a different saved question after composition recreation until the original durable reply, then permits the exact queued question', async () => {
    const { feature, createFeature, run, human, send, saveHuman, requestFile } = await setup();
    await feature.deliverPersistedHumanRequest(run, human.requestMessageId);
    const firstHistory = JSON.parse(await readFile(requestFile, 'utf8'));
    const next = { ...human, requestMessageId: 'TEST-next', text: 'What is three plus three?' };
    await saveHuman(next);
    const nextHistory = JSON.parse(await readFile(requestFile, 'utf8'));
    await writeFile(requestFile, JSON.stringify([...firstHistory, ...nextHistory]));
    const restored = createFeature();
    await expect(
      restored.deliverPersistedHumanRequest(run, next.requestMessageId)
    ).resolves.toMatchObject({ state: 'queued' });
    expect(send).toHaveBeenCalledOnce();
    await feature.reporting.reply('TEST-existing-credential', human.requestMessageId, 'Four.');
    await expect(
      restored.deliverPersistedHumanRequest(run, next.requestMessageId)
    ).resolves.toMatchObject({ state: 'sent' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(run, expect.stringContaining(next.text));
  });

  it('does not read or admit persisted requests for a stopped run or invalidated context', async () => {
    const { feature, lifecycle, run, human, requestFile, admission } = await setup();
    await writeFile(requestFile, 'TEST unreadable history');
    admission.abort(new Error('TEST context invalidated'));
    await expect(feature.deliverPersistedHumanRequest(run, human.requestMessageId)).rejects.toThrow(
      'invalidated'
    );
    await lifecycle.teams.stop(run);
  });
});
