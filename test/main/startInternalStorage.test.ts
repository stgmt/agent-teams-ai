// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const getPath = vi.fn(() => '/tmp/app-profile');
  const getLocale = vi.fn(() => 'ru-RU');
  const addError = vi.fn(async (_warning: unknown) => null);
  const probeBackend = vi.fn(() => Promise.resolve({ status: 'ok' }));
  const feature = { probeBackend, customTeamTemplatesBackend: null };
  return {
    getPath,
    getLocale,
    addError,
    probeBackend,
    feature,
    createInternalStorageFeature: vi.fn(
      (_options: {
        userDataPath: string;
        onCommentJournalFailure: (teamName: string, error: unknown) => void;
        onCommentJournalMutationSuccess: (teamName: string) => void;
        onInternalStorageUnavailable: (kind: 'recovery-required' | 'verification-required') => void;
      }) => feature
    ),
  };
});

vi.mock('electron', () => ({ app: { getPath: hoisted.getPath, getLocale: hoisted.getLocale } }));
vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: { getInstance: () => ({ addError: hoisted.addError }) },
}));
vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: () => ({ getConfig: () => ({ general: { appLocale: 'system' } }) }),
  },
}));

vi.mock('@features/internal-storage/main', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/internal-storage/main')>()),
  createInternalStorageFeature: hoisted.createInternalStorageFeature,
}));

const { startInternalStorage } = await import('@main/startInternalStorage');

const originalSmoke = process.env.AGENT_TEAMS_PACKAGED_SMOKE;

beforeEach(() => {
  hoisted.getPath.mockClear();
  hoisted.addError.mockClear();
  hoisted.probeBackend.mockClear();
  hoisted.createInternalStorageFeature.mockClear();
  delete process.env.AGENT_TEAMS_PACKAGED_SMOKE;
});

afterEach(() => {
  if (originalSmoke === undefined) delete process.env.AGENT_TEAMS_PACKAGED_SMOKE;
  else process.env.AGENT_TEAMS_PACKAGED_SMOKE = originalSmoke;
});

describe('startInternalStorage', () => {
  it('creates the storage feature under the Electron user-data path', () => {
    const feature = startInternalStorage();

    expect(hoisted.getPath).toHaveBeenCalledWith('userData');
    expect(hoisted.createInternalStorageFeature).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userDataPath: '/tmp/app-profile',
        onCommentJournalFailure: expect.any(Function),
        onCommentJournalMutationSuccess: expect.any(Function),
        onInternalStorageUnavailable: expect.any(Function),
      })
    );
    expect(feature).toBe(hoisted.feature);
  });

  it('routes a comment journal failure to the user notification center once', async () => {
    startInternalStorage();
    const options = hoisted.createInternalStorageFeature.mock.calls[0][0];
    options.onCommentJournalFailure('fixture-team', new Error('worker unavailable'));
    options.onCommentJournalFailure('fixture-team', new Error('worker unavailable'));
    await Promise.resolve();
    expect(hoisted.addError).toHaveBeenCalledOnce();
    expect(hoisted.addError.mock.calls[0][0]).toMatchObject({
      source: 'internal-storage',
      target: { kind: 'team', teamName: 'fixture-team', section: 'tasks' },
    });
    expect((hoisted.addError.mock.calls[0][0] as { message: string }).message).toContain(
      'результат неизвестен'
    );
    options.onCommentJournalMutationSuccess('fixture-team');
    options.onCommentJournalFailure('fixture-team', new Error('new failure'));
    expect(hoisted.addError).toHaveBeenCalledTimes(2);
  });

  it('probes the backend only for a packaged smoke run', () => {
    startInternalStorage();
    expect(hoisted.probeBackend).not.toHaveBeenCalled();

    process.env.AGENT_TEAMS_PACKAGED_SMOKE = '0';
    startInternalStorage();
    process.env.AGENT_TEAMS_PACKAGED_SMOKE = ' ';
    startInternalStorage();
    expect(hoisted.probeBackend).not.toHaveBeenCalled();

    process.env.AGENT_TEAMS_PACKAGED_SMOKE = '1';
    startInternalStorage();
    expect(hoisted.probeBackend).toHaveBeenCalledTimes(1);
  });
});
