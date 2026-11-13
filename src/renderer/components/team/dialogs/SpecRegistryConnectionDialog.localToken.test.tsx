/* eslint-disable sonarjs/no-clear-text-protocols -- the loopback plain-http shape IS the subject of these cases */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** React tracks the node value, so a plain assignment would be ignored. */
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// The credential transport, the bootstrap request and localization are the
// only seams: the dialog itself, its real inputs and its real buttons render.
const fixture = vi.hoisted(() => ({
  status: vi.fn(),
  check: vi.fn(),
  localToken: vi.fn(),
  translate: (key: string, options?: { code?: string }) =>
    options?.code ? `${key}:${options.code}` : key,
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getSpecRegistryCredentialStatus: fixture.status,
      testSpecRegistryCredential: fixture.check,
      requestSpecRegistryLocalToken: fixture.localToken,
    },
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: fixture.translate, resolvedLanguage: 'en' }),
}));

import { SpecRegistryConnectionDialog } from './SpecRegistryConnectionDialog';

const LOOPBACK = 'http://127.0.0.1:8643/mcp';
const REMOTE = 'https://registry.unit.invalid/mcp';

let root: Root | undefined;

async function render(status: { configured: boolean; url: string | null; source: string }) {
  fixture.status.mockResolvedValue(status);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SpecRegistryConnectionDialog onClose={vi.fn()} onSaved={vi.fn()} />);
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
}

function endpointInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="create.registryPicker.credentialEndpoint"]'
  );
  expect(input, 'the endpoint field must be rendered').not.toBeNull();
  return input!;
}

function tokenInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="password"][aria-label="create.registryPicker.credentialToken"]'
  );
  expect(input, 'the token field must be rendered').not.toBeNull();
  return input!;
}

async function typeEndpoint(value: string): Promise<void> {
  await act(async () => {
    setNativeInputValue(endpointInput(), value);
    await Promise.resolve();
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.status.mockReset();
  fixture.check.mockReset().mockResolvedValue({
    ok: true,
    url: LOOPBACK,
    toolCount: 2,
    errorCode: null,
  });
  fixture.localToken.mockReset().mockResolvedValue({ ok: true, token: 'registry-local-token' });
});

describe('registry dialog local token bootstrap', () => {
  it('offers Get token only for an endpoint on this machine', async () => {
    await render({ configured: false, url: null, source: 'none' });
    const label = 'create.registryPicker.credentialGetToken';
    expect(button(label), 'no endpoint yet: nothing to bootstrap').toBeUndefined();

    await typeEndpoint(REMOTE);
    expect(button(label), 'a remote endpoint has no local bootstrap').toBeUndefined();

    await typeEndpoint(LOOPBACK);
    expect(button(label), 'a loopback endpoint can mint its own token').toBeDefined();
    expect(button(label)!.disabled).toBe(false);

    await typeEndpoint('http://10.2.3.4:8643/mcp');
    expect(button(label), 'another host on the network is not this machine').toBeUndefined();
  });

  it('shows Get token for the stored loopback credential the dialog opens with', async () => {
    await render({ configured: true, url: LOOPBACK, source: 'store' });
    expect(button('create.registryPicker.credentialGetToken')).toBeDefined();
  });

  it('fills the token field with the obtained token and checks it immediately', async () => {
    await render({ configured: false, url: null, source: 'none' });
    await typeEndpoint(LOOPBACK);
    expect(tokenInput().value).toBe('');

    await act(async () => {
      button('create.registryPicker.credentialGetToken')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fixture.localToken).toHaveBeenCalledWith(LOOPBACK);
    expect(tokenInput().value).toBe('registry-local-token');
    expect(fixture.check).toHaveBeenCalledWith(LOOPBACK, 'registry-local-token');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'create.registryPicker.credentialCheckOk'
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ['LOCAL_BOOTSTRAP_DISABLED', 'create.registryPicker.localTokenDisabled'],
    ['LOCAL_BOOTSTRAP_FORBIDDEN', 'create.registryPicker.localTokenForbidden'],
    ['LOCAL_BOOTSTRAP_NOT_LOOPBACK', 'create.registryPicker.localTokenNotLoopback'],
    ['UPSTREAM_ERROR', 'create.registryPicker.localTokenFailed:UPSTREAM_ERROR'],
  ])('explains a %s refusal and leaves the token field untouched', async (code, expected) => {
    fixture.localToken.mockResolvedValue({ ok: false, code });
    await render({ configured: false, url: null, source: 'none' });
    await typeEndpoint(LOOPBACK);

    await act(async () => {
      button('create.registryPicker.credentialGetToken')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tokenInput().value).toBe('');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(expected);
    expect(fixture.check, 'a refused bootstrap must not run a check').not.toHaveBeenCalled();
  });

  it('reports a transport failure instead of silently succeeding', async () => {
    fixture.localToken.mockRejectedValue(new Error('bridge unavailable'));
    await render({ configured: false, url: null, source: 'none' });
    await typeEndpoint(LOOPBACK);

    await act(async () => {
      button('create.registryPicker.credentialGetToken')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'create.registryPicker.localTokenFailed:LOCAL_BOOTSTRAP_FAILED'
    );
    expect(tokenInput().value).toBe('');
  });
});

/* eslint-enable sonarjs/no-clear-text-protocols */
