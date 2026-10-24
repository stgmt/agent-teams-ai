// @vitest-environment node
/**
 * L2: остановка агента на настоящих процессах Windows (спека bugfix-member-save-restart, SR-18, SR-20, SR-21).
 *
 * Ничего не подменено: настоящий родительский процесс node с четырьмя дочерними (как дерево агента с его
 * MCP-серверами), настоящий `taskkill /T /F`, настоящий запрос PowerShell, настоящее время.
 * Командная строка родителя содержит `--team-name` и `--agent-name`, поэтому проверка личности узнаёт его
 * так же, как узнаёт агента приложения.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isProcessAlive } from '@main/utils/processHealth';
import { inspectProcessByPid, inspectProcessByPidOnce } from '@main/utils/processInspection';
import { createNodeStopPrimaryOwnedRosterRuntimeUseCase } from '@main/services/team/provisioning/TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TEAM = 'l2-save-restart-team';
const MEMBER = 'DEPLOY';
// Дерево живого агента на машине владельца: 16 процессов (замер 22.10, tree_size.ps1). Здесь 1 + 3 + 12.
const BRANCHES = 3;
const LEAVES_PER_BRANCH = 4;
const L2_TIMEOUT_MS = 120_000;

const BRANCH_SCRIPT = `
const { spawn } = require('node:child_process');
const leaves = [];
for (let i = 0; i < ${LEAVES_PER_BRANCH}; i += 1) {
  leaves.push(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid);
}
process.stdout.write(JSON.stringify(leaves) + '\\n');
setInterval(() => {}, 1000);
`;

const MEMBER_SCRIPT = `
const { spawn } = require('node:child_process');
const kids = [];
let reported = 0;
for (let i = 0; i < ${BRANCHES}; i += 1) {
  const branch = spawn(process.execPath, ['-e', ${JSON.stringify(BRANCH_SCRIPT)}], { stdio: ['ignore', 'pipe', 'ignore'] });
  kids.push(branch.pid);
  branch.stdout.once('data', (chunk) => {
    kids.push(...JSON.parse(String(chunk).split('\\n')[0]));
    reported += 1;
    if (reported === ${BRANCHES}) process.stdout.write(JSON.stringify({ kids }) + '\\n');
  });
}
setInterval(() => {}, 1000);
`;

interface MemberTree {
  child: ChildProcess;
  pid: number;
  kidPids: number[];
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function killTreeSync(pid: number): void {
  spawn(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/T', '/F', '/PID', String(pid)],
    { stdio: 'ignore', windowsHide: true }
  );
}

describe.skipIf(process.platform !== 'win32')(
  'остановка агента на настоящем дереве процессов (Windows)',
  () => {
    let dir = '';
    const trees: MemberTree[] = [];

    async function startMemberTree(memberName: string): Promise<MemberTree> {
      const scriptPath = path.join(dir, `${memberName}.cjs`);
      await writeFile(scriptPath, MEMBER_SCRIPT, 'utf8');
      const child = spawn(
        process.execPath,
        [
          scriptPath,
          '--teammate-runtime',
          'headless',
          '--agent-id',
          `${memberName}@${TEAM}`,
          '--agent-name',
          memberName,
          '--team-name',
          TEAM,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
      const pid = child.pid;
      if (!pid) throw new Error('member tree did not start');
      const kidPids = await new Promise<number[]>((resolve, reject) => {
        let buffered = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8');
          const line = buffered.split('\n')[0];
          if (buffered.includes('\n')) {
            try {
              resolve((JSON.parse(line) as { kids: number[] }).kids);
            } catch (error) {
              reject(error);
            }
          }
        });
        child.once('error', reject);
      });
      const tree = { child, pid, kidPids };
      trees.push(tree);
      return tree;
    }

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'l2-save-restart-'));
    });

    afterEach(async () => {
      for (const tree of trees.splice(0)) {
        if (isProcessAlive(tree.pid)) killTreeSync(tree.pid);
        await waitFor(() => !isProcessAlive(tree.pid), 10_000);
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    });

    it(
      'SR-20 пять остановок живого дерева подряд возвращаются после смерти процесса и детей',
      async () => {
        const stop = createNodeStopPrimaryOwnedRosterRuntimeUseCase();
        const elapsedMs: number[] = [];

        // Время смерти дерева на Windows плавает (замер 22.10: 1,3-6 с), одной остановки для вывода мало.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const tree = await startMemberTree(MEMBER);
          const startedAt = performance.now();

          await stop({
            teamName: TEAM,
            memberName: MEMBER,
            persistedRuntimeMembers: [{ backendType: 'process', runtimePid: tree.pid }],
            liveRuntimeByMember: new Map(),
            actionLabel: `Update for teammate "${MEMBER}"`,
          });
          elapsedMs.push(Math.round(performance.now() - startedAt));

          expect(isProcessAlive(tree.pid)).toBe(false);
          const kidsGone = await waitFor(
            () => tree.kidPids.every((kidPid) => !isProcessAlive(kidPid)),
            10_000
          );
          expect(kidsGone).toBe(true);
        }
        expect(elapsedMs).toHaveLength(5);
      },
      L2_TIMEOUT_MS
    );

    it(
      'SR-18 пока идёт остановка, цикл событий главного потока не замирает',
      async () => {
        const tree = await startMemberTree(MEMBER);
        const stop = createNodeStopPrimaryOwnedRosterRuntimeUseCase();

        let lastTick = performance.now();
        let longestGapMs = 0;
        const ticker = setInterval(() => {
          const now = performance.now();
          longestGapMs = Math.max(longestGapMs, now - lastTick);
          lastTick = now;
        }, 20);
        try {
          await stop({
            teamName: TEAM,
            memberName: MEMBER,
            persistedRuntimeMembers: [{ backendType: 'process', runtimePid: tree.pid }],
            liveRuntimeByMember: new Map(),
            actionLabel: `Update for teammate "${MEMBER}"`,
          });
        } finally {
          clearInterval(ticker);
        }

        // Раньше синхронный запрос PowerShell останавливал поток на 2-4 с.
        expect(longestGapMs).toBeLessThan(250);
      },
      L2_TIMEOUT_MS
    );

    it(
      'SR-21 настоящий запрос по одному pid: found, not_found и unreadable при лимите в 1 мс',
      async () => {
        const tree = await startMemberTree(MEMBER);

        const found = await inspectProcessByPid(tree.pid);
        expect(found.status).toBe('found');
        if (found.status === 'found') {
          expect(found.command).toContain(`--team-name ${TEAM}`);
          expect(found.command).toContain(`--agent-name ${MEMBER}`);
        }

        const tooShort = await inspectProcessByPidOnce(tree.pid, { timeoutMs: 1 });
        expect(tooShort.status).toBe('unreadable');
        if (tooShort.status === 'unreadable') {
          expect(tooShort.cause).toContain('windows_process_inspection');
          expect(tooShort.cause).toContain('timeoutMs=1');
        }

        const attempts: number[] = [];
        const retried = await inspectProcessByPid(tree.pid, {
          timeoutMs: 1,
          onUnreadable: (attempt) => attempts.push(attempt),
        });
        expect(retried.status).toBe('unreadable');
        expect(attempts).toEqual([1, 2]);

        killTreeSync(tree.pid);
        expect(await waitFor(() => !isProcessAlive(tree.pid), 15_000)).toBe(true);
        await expect(inspectProcessByPid(tree.pid)).resolves.toEqual({ status: 'not_found' });
      },
      L2_TIMEOUT_MS
    );

    it(
      'SR-18b пока идёт запрос по pid, цикл событий главного потока не замирает',
      async () => {
        const tree = await startMemberTree(MEMBER);

        let lastTick = performance.now();
        let longestGapMs = 0;
        const ticker = setInterval(() => {
          const now = performance.now();
          longestGapMs = Math.max(longestGapMs, now - lastTick);
          lastTick = now;
        }, 20);
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            expect((await inspectProcessByPid(tree.pid)).status).toBe('found');
          }
        } finally {
          clearInterval(ticker);
        }

        // Раньше синхронный запрос PowerShell останавливал поток на 0,9-4 с.
        expect(longestGapMs).toBeLessThan(250);
      },
      L2_TIMEOUT_MS
    );
  }
);
