import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import enTeam from '@features/localization/renderer/locales/en/team.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamNotRunningDialog } from '../TeamNotRunningDialog';

import type { DowntimeEpisode } from '../../../core/domain/downtimeEpisode';

// РИСК: подменены только переводчик и формат времени. Тексты берутся из настоящего en/team.json, поэтому
// тест ловит пропавший ключ и неверную подстановку, но не проверяет работу i18next
// (плюральные формы, смену языка).
interface TextTree {
  [key: string]: string | TextTree;
}
const english = vi.hoisted(() => {
  const state: { team: TextTree } = { team: {} };
  return state;
});

vi.mock('@features/localization/renderer', () => ({
  useLocaleFormatters: () => ({
    time: (value: string) =>
      new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  }),
  useAppTranslation: (namespace: string) => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (namespace !== 'team') return key;
      const leaf = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as never)[part] : undefined),
          english.team
        );
      if (typeof leaf !== 'string') return `MISSING:${key}`;
      return leaf.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? ''));
    },
  }),
}));

const exitedAt: DowntimeEpisode = {
  exit: {
    exitCode: 1,
    occurredAt: '2026-10-24T05:48:27.000Z',
    cliLogsTail: 'fatal: out of memory',
  },
  ownerMessageAt: null,
  dismissed: false,
};
const messageOnly: DowntimeEpisode = {
  exit: null,
  ownerMessageAt: '2026-10-24T05:50:00.000Z',
  dismissed: false,
};

describe('TeamNotRunningDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onClose = vi.fn();
  const onLaunch = vi.fn();

  beforeEach(() => {
    english.team = enTeam as never;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onClose.mockReset();
    onLaunch.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  async function show(props: {
    episode: DowntimeEpisode | null;
    queuedCount?: number;
    open?: boolean;
  }): Promise<HTMLElement> {
    await act(async () =>
      root.render(
        <TeamNotRunningDialog
          open={props.open ?? true}
          teamName="my-team"
          episode={props.episode}
          queuedCount={props.queuedCount ?? 0}
          onClose={onClose}
          onLaunch={onLaunch}
        />
      )
    );
    return document.body;
  }

  const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const buttonByText = (text: string): HTMLButtonElement =>
    Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === text
    )!;

  it('NM-S15: names the team, the time and the exit code; keeps the log tail folded', async () => {
    await show({ episode: exitedAt });

    expect(dialog().textContent).toContain('Team "my-team" is not running');
    expect(dialog().textContent).toMatch(/exited at \d{1,2}:\d{2}.*exit code 1/);
    expect(dialog().textContent).not.toContain('MISSING:');
    expect(dialog().textContent).not.toContain('fatal: out of memory');

    await act(async () => buttonByText('Details').click());

    expect(dialog().textContent).toContain('fatal: out of memory');
  });

  it('NM-S16: tells a normal exit and an exit without a code apart', async () => {
    await show({ episode: { ...exitedAt, exit: { ...exitedAt.exit!, exitCode: 0 } } });
    expect(dialog().textContent).toContain('ended by itself');

    await show({ episode: { ...exitedAt, exit: { ...exitedAt.exit!, exitCode: null } } });
    expect(dialog().textContent).toContain('without an exit code');
    expect(dialog().textContent).not.toContain('exit code null');
  });

  it('NM-S17: a message to a team without a witnessed exit says it was saved and has no details', async () => {
    await show({ episode: messageOnly, queuedCount: 1 });

    expect(dialog().textContent).toContain('saved and will arrive after the team starts');
    expect(buttonByText('Details')).toBeUndefined();
    expect(dialog().textContent).not.toContain('are waiting in the queue');
  });

  it('NM-S17: a message after a witnessed exit keeps the exit reason and adds the saved line', async () => {
    await show({ episode: { ...exitedAt, ownerMessageAt: '2026-10-24T05:50:00.000Z' } });

    expect(dialog().textContent).toMatch(/exited at \d{1,2}:\d{2}.*exit code 1/);
    expect(dialog().textContent).toContain('saved and will arrive after the team starts');
    expect(buttonByText('Details')).toBeDefined();
  });

  it('NM-S18: shows the queue line only when owner messages are waiting', async () => {
    await show({ episode: exitedAt, queuedCount: 2 });
    expect(dialog().textContent).toContain('Your messages (2) are waiting in the queue');

    await show({ episode: exitedAt, queuedCount: 0 });
    expect(dialog().textContent).not.toContain('are waiting in the queue');
  });

  it('NM-S19: Launch asks the host to open the launch form, once', async () => {
    await show({ episode: exitedAt });

    await act(async () => buttonByText('Launch').click());

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('NM-S20: Close and Escape both dismiss the notice', async () => {
    await show({ episode: exitedAt });
    await act(async () => buttonByText('Close').click());
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      dialog().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('NM-S21: focuses Launch and links the title and description for screen readers', async () => {
    await show({ episode: exitedAt });

    expect(document.activeElement).toBe(buttonByText('Launch'));
    const titleId = dialog().getAttribute('aria-labelledby');
    const descriptionId = dialog().getAttribute('aria-describedby');
    expect(document.getElementById(titleId ?? '')?.textContent).toContain('is not running');
    expect(document.getElementById(descriptionId ?? '')?.textContent).toContain('exit code 1');
  });

  it('renders nothing while closed or without a reason', async () => {
    await show({ episode: exitedAt, open: false });
    expect(dialog()).toBeNull();

    await show({ episode: null });
    expect(dialog()).toBeNull();
  });
});
