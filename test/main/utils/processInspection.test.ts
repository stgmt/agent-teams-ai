import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inspectProcessByPidOnce,
  inspectWithRetry,
  PROCESS_INSPECTION_ATTEMPTS,
  type ProcessInspection,
} from '@main/utils/processInspection';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const exec = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: { timeout?: number } }>,
  respond: ((callback: ExecCallback) => callback(null, '', '')) as (callback: ExecCallback) => void,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = vi.fn(
    (file: string, args: string[], options: { timeout?: number }, callback: ExecCallback) => {
      exec.calls.push({ file, args, options });
      exec.respond(callback);
      return {} as never;
    }
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

beforeEach(() => {
  exec.calls.length = 0;
  exec.respond = (callback) => callback(null, '', '');
});

describe('inspectProcessByPidOnce on POSIX', () => {
  it('returns the command line of a live process', async () => {
    exec.respond = (callback) => callback(null, ' node worker.js --agent-name Alice \n', '');

    await expect(inspectProcessByPidOnce(4242, { platform: 'linux' })).resolves.toEqual({
      status: 'found',
      command: 'node worker.js --agent-name Alice',
    });
    expect(exec.calls[0]).toMatchObject({
      file: '/bin/ps',
      args: ['-p', '4242', '-o', 'command='],
    });
  });

  it('reports not_found when ps exits with 1 and prints nothing', async () => {
    exec.respond = (callback) =>
      callback(Object.assign(new Error('Command failed'), { code: 1 }), '', '');

    await expect(inspectProcessByPidOnce(4242, { platform: 'linux' })).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('reports unreadable, not not_found, when ps fails for another reason', async () => {
    exec.respond = (callback) =>
      callback(Object.assign(new Error('spawn /bin/ps ENOENT'), { code: 'ENOENT' }), '', '');

    const inspection = await inspectProcessByPidOnce(4242, { platform: 'linux' });

    expect(inspection.status).toBe('unreadable');
    expect(inspection).toMatchObject({
      cause: expect.stringContaining('posix_process_inspection'),
    });
  });

  it('treats an invalid pid as not found without starting a process', async () => {
    await expect(inspectProcessByPidOnce(0, { platform: 'linux' })).resolves.toEqual({
      status: 'not_found',
    });
    await expect(inspectProcessByPidOnce(Number.NaN, { platform: 'linux' })).resolves.toEqual({
      status: 'not_found',
    });
    expect(exec.calls).toEqual([]);
  });
});

describe('inspectProcessByPidOnce on Windows', () => {
  it('reads one process by pid and passes the time limit to the child', async () => {
    exec.respond = (callback) =>
      callback(
        null,
        JSON.stringify({ ProcessId: 77, CommandLine: ' claude.exe --agent-name A ' }),
        ''
      );

    await expect(
      inspectProcessByPidOnce(77, { platform: 'win32', timeoutMs: 9_000 })
    ).resolves.toEqual({ status: 'found', command: 'claude.exe --agent-name A' });
    expect(exec.calls[0].file).toBe('powershell.exe');
    expect(exec.calls[0].args.at(-1)).toContain('ProcessId=77');
    expect(exec.calls[0].options.timeout).toBe(9_000);
  });

  it('reports not_found for an empty answer', async () => {
    await expect(inspectProcessByPidOnce(77, { platform: 'win32' })).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('reports unreadable with the timeout cause when the child was killed by the limit', async () => {
    exec.respond = (callback) =>
      callback(
        Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }),
        '',
        ''
      );

    const inspection = await inspectProcessByPidOnce(77, { platform: 'win32', timeoutMs: 1 });

    expect(inspection).toMatchObject({
      status: 'unreadable',
      cause: expect.stringMatching(/windows_process_inspection.*timeoutMs=1.*killed=true/),
    });
  });

  it('reports unreadable for output that is not JSON', async () => {
    exec.respond = (callback) => callback(null, 'not json', '');

    await expect(inspectProcessByPidOnce(77, { platform: 'win32' })).resolves.toMatchObject({
      status: 'unreadable',
    });
  });

  it('reports unreadable when PowerShell wrote to stderr', async () => {
    exec.respond = (callback) => callback(null, '', 'Get-CimInstance : access denied');

    await expect(inspectProcessByPidOnce(77, { platform: 'win32' })).resolves.toMatchObject({
      status: 'unreadable',
    });
  });
});

describe('inspectWithRetry', () => {
  const unreadable: ProcessInspection = { status: 'unreadable', cause: 'probe timed out' };

  it('does not retry a found or not_found answer', async () => {
    for (const final of [{ status: 'found', command: 'x' }, { status: 'not_found' }] as const) {
      const inspectOnce = vi.fn(async (): Promise<ProcessInspection> => final);

      await expect(inspectWithRetry(inspectOnce)).resolves.toEqual(final);
      expect(inspectOnce).toHaveBeenCalledTimes(1);
    }
  });

  it('retries an unreadable answer once and returns the second answer', async () => {
    const inspectOnce = vi
      .fn<() => Promise<ProcessInspection>>()
      .mockResolvedValueOnce(unreadable)
      .mockResolvedValueOnce({ status: 'found', command: 'x' });
    const onUnreadable = vi.fn();

    await expect(
      inspectWithRetry(inspectOnce, PROCESS_INSPECTION_ATTEMPTS, onUnreadable)
    ).resolves.toEqual({ status: 'found', command: 'x' });
    expect(inspectOnce).toHaveBeenCalledTimes(2);
    expect(onUnreadable).toHaveBeenCalledTimes(1);
    expect(onUnreadable).toHaveBeenCalledWith(1, 'probe timed out');
  });

  it('returns the last unreadable answer after all attempts and reports each one', async () => {
    const inspectOnce = vi
      .fn<() => Promise<ProcessInspection>>()
      .mockResolvedValueOnce({ status: 'unreadable', cause: 'first' })
      .mockResolvedValueOnce({ status: 'unreadable', cause: 'second' });
    const onUnreadable = vi.fn();

    await expect(inspectWithRetry(inspectOnce, 2, onUnreadable)).resolves.toEqual({
      status: 'unreadable',
      cause: 'second',
    });
    expect(inspectOnce).toHaveBeenCalledTimes(2);
    expect(onUnreadable.mock.calls).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });

  it('makes exactly two attempts by default', () => {
    expect(PROCESS_INSPECTION_ATTEMPTS).toBe(2);
  });
});
