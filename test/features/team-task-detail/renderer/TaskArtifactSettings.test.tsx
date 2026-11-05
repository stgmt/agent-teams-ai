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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('enables the requirement, fixes the filename, and sends selected bytes without a client-supplied hash', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const props = { onUpdate: updateTaskFields, canMutate: () => true, completed: false };
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
        'result.txt'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const attach = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'artifact.setName'
    )!;
    await act(async () => {
      attach.click();
    });
    expect(updateTaskFields).toHaveBeenLastCalledWith({
      artifactExpectedFilename: 'result.txt',
    });
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File(['abc'], 'result.txt', { type: 'text/plain' }));
    picker.files = transfer.files;
    let finishRead!: () => void;
    const readFinished = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const readAsDataURL = FileReader.prototype.readAsDataURL;
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (
      this: FileReader,
      selected
    ) {
      this.addEventListener('loadend', finishRead, { once: true });
      readAsDataURL.call(this, selected);
    });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await readFinished;
    });
    expect(updateTaskFields).toHaveBeenLastCalledWith({
      artifactFile: { filename: 'result.txt', base64Data: 'YWJj' },
    });
    await act(async () => root.unmount());
  });

  it('respects the existing context mutation gate', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskArtifactSettings
          onUpdate={updateTaskFields}
          canMutate={() => false}
          completed={false}
        />
      );
    });
    await act(async () => {
      (host.querySelector('[role="switch"]') as HTMLButtonElement).click();
    });
    expect(updateTaskFields).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('requires reopening a completed task before enabling the requirement', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskArtifactSettings onUpdate={updateTaskFields} canMutate={() => true} completed />
      );
    });
    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(host.textContent).toContain('artifact.reopen');
    await act(async () => {
      toggle.click();
    });
    expect(updateTaskFields).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
