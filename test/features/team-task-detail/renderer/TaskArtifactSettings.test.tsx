import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TaskArtifactSettings } from '@features/team-task-detail/renderer/ui/TaskArtifactSettings';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const updateTaskFields = vi.fn(async () => undefined);

describe('task artifact settings', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('enables the requirement and sends the project-relative path without a client-supplied hash', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const props = { onUpdate: updateTaskFields, canMutate: () => true };
    await act(async () => {
      root.render(<TaskArtifactSettings {...props} />);
    });
    await act(async () => {
      (host.querySelector('[role="switch"]') as HTMLButtonElement).click();
    });
    expect(updateTaskFields).toHaveBeenCalledWith({ artifactRequired: true });
    await act(async () => {
      root.render(<TaskArtifactSettings {...props} requirement={{ required: true }} />);
    });
    const input = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'outputs/result.mp4'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const attach = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'artifact.attach'
    )!;
    await act(async () => {
      attach.click();
    });
    expect(updateTaskFields).toHaveBeenLastCalledWith({
      artifactProjectPath: 'outputs/result.mp4',
    });
    await act(async () => root.unmount());
  });

  it('respects the existing context mutation gate', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<TaskArtifactSettings onUpdate={updateTaskFields} canMutate={() => false} />);
    });
    await act(async () => {
      (host.querySelector('[role="switch"]') as HTMLButtonElement).click();
    });
    expect(updateTaskFields).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
