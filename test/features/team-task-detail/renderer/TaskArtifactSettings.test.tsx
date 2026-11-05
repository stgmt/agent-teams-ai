import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TaskArtifactSettings } from '@features/team-task-detail/renderer/ui/TaskArtifactSettings';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const updateTaskFields = vi.fn(async () => undefined);
const outcomeProps = {
  outcomeUnknown: false,
  outcomeChecked: false,
  writeInFlight: false,
  guardStatus: 'ready' as const,
  guardReason: null,
  otherOperation: false,
  onOutcomeUnknown: vi.fn(),
  onCheckOutcome: vi.fn(async () => undefined),
  onConfirmOutcome: vi.fn(async () => undefined),
};

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
    const props = {
      ...outcomeProps,
      onUpdate: updateTaskFields,
      onDownload: vi.fn(async () => null),
      canMutate: () => true,
      completed: false,
    };
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
    expect(host.textContent).toContain('artifact.anyName');
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
          {...outcomeProps}
          onUpdate={updateTaskFields}
          onDownload={async () => null}
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

  it.each([
    ['in flight', { writeInFlight: true }, 'artifact.saving'],
    [
      'storage unavailable',
      { guardStatus: 'unavailable' as const, guardReason: 'unavailable' as const },
      'artifact.guardUnavailable',
    ],
    [
      'unsupported browser',
      { guardStatus: 'unavailable' as const, guardReason: 'unsupported' as const },
      'artifact.guardUnsupported',
    ],
    ['other operation', { outcomeUnknown: true, otherOperation: true }, 'artifact.otherOperation'],
  ])('blocks artifact writes for %s', async (_label, overrides, message) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskArtifactSettings
          {...outcomeProps}
          {...overrides}
          onUpdate={updateTaskFields}
          onDownload={async () => null}
          canMutate={() => true}
          completed={false}
        />
      );
    });
    expect((host.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain(message);
    if ('otherOperation' in overrides && overrides.otherOperation)
      expect(host.textContent).not.toContain('artifact.checkOutcome');
    expect(updateTaskFields).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('reports an invalid filename before sending a mutation and does not mark the outcome unknown', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onUnknown = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskArtifactSettings
          {...outcomeProps}
          onOutcomeUnknown={onUnknown}
          onUpdate={updateTaskFields}
          onDownload={async () => null}
          canMutate={() => true}
          completed={false}
          requirement={{ required: true }}
        />
      );
    });
    const input = host.querySelector<HTMLInputElement>('input:not([type="file"])')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '../bad.txt'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'artifact.setName'
    )!;
    await act(async () => {
      save.click();
    });
    expect(updateTaskFields).not.toHaveBeenCalled();
    expect(onUnknown).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('artifact.invalidName');
    await act(async () => root.unmount());
  });

  it('requires reopening a completed task before enabling the requirement', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskArtifactSettings
          {...outcomeProps}
          onUpdate={updateTaskFields}
          onDownload={async () => null}
          canMutate={() => true}
          completed
        />
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

  it('downloads the verified attachment bytes under the expected filename', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => new Blob(['abc']) }))
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      expect(this.download).toBe('result.txt');
      expect(this.href).toBe('blob:test');
    });
    const onDownload = vi.fn(async () => 'YWJj');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskArtifactSettings
          {...outcomeProps}
          onUpdate={updateTaskFields}
          onDownload={onDownload}
          canMutate={() => true}
          completed
          requirement={{
            required: true,
            expectedFilename: 'result.txt',
            proof: { attachmentId: 'artifact-1', sha256: 'a'.repeat(64), size: 3 },
          }}
        />
      );
    });
    const button = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'artifact.download'
    )!;
    await act(async () => {
      button.click();
    });
    expect(onDownload).toHaveBeenCalledWith('artifact-1');
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    await act(async () => root.unmount());
  });

  it('shows a verification failure without retrying the download', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onDownload = vi.fn(async () => {
      throw new Error('Artifact has changed');
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskArtifactSettings
          {...outcomeProps}
          onUpdate={updateTaskFields}
          onDownload={onDownload}
          canMutate={() => true}
          completed
          requirement={{
            required: true,
            expectedFilename: 'result.txt',
            proof: { attachmentId: 'artifact-1', sha256: 'a'.repeat(64), size: 3 },
          }}
        />
      );
    });
    const button = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'artifact.download'
    )!;
    await act(async () => {
      button.click();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Artifact has changed');
    await act(async () => root.unmount());
  });

  it.each(['lost IPC response', 'refresh failed after commit'])(
    'asks to check once when %s leaves the result unknown',
    async (failure) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      let serverRequired = false;
      const mutate = vi.fn(async () => {
        serverRequired = true;
        throw new Error(failure);
      });
      const check = vi.fn(async () => undefined);
      const View = (): React.JSX.Element => {
        const [unknown, setUnknown] = useState(false);
        const [checked, setChecked] = useState(false);
        const [required, setRequired] = useState(false);
        return (
          <TaskArtifactSettings
            outcomeUnknown={unknown}
            outcomeChecked={checked}
            writeInFlight={false}
            guardStatus="ready"
            guardReason={null}
            otherOperation={false}
            onOutcomeUnknown={() => setUnknown(true)}
            onCheckOutcome={async () => {
              await check();
              setRequired(serverRequired);
              setChecked(true);
            }}
            onConfirmOutcome={async () => {
              setUnknown(false);
            }}
            onUpdate={mutate}
            onDownload={async () => null}
            canMutate={() => true}
            completed={false}
            requirement={{ required }}
          />
        );
      };
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(<View />);
      });
      const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
      await act(async () => {
        toggle.click();
      });
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(toggle.disabled).toBe(true);
      expect(host.textContent).toContain('artifact.unknown');
      expect(check).not.toHaveBeenCalled();
      const checkButton = Array.from(host.querySelectorAll('button')).find(
        (item) => item.textContent === 'artifact.checkOutcome'
      )!;
      await act(async () => {
        checkButton.click();
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect((host.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
      expect(host.textContent).toContain('artifact.confirmMessage');
      const confirmButton = Array.from(host.querySelectorAll('button')).find(
        (item) => item.textContent === 'artifact.confirmOutcome'
      )!;
      await act(async () => {
        confirmButton.click();
      });
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(
        (host.querySelector('[role="switch"]') as HTMLButtonElement).getAttribute('aria-checked')
      ).toBe('true');
      expect(host.textContent).not.toContain('artifact.unknown');
      await act(async () => root.unmount());
    }
  );

  it('does not reattach a file when its committed write loses the response', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const mutate = vi.fn(async () => {
      throw new Error('response lost after commit');
    });
    const check = vi.fn(async () => undefined);
    const View = (): React.JSX.Element => {
      const [unknown, setUnknown] = useState(false);
      const [checked, setChecked] = useState(false);
      return (
        <TaskArtifactSettings
          outcomeUnknown={unknown}
          outcomeChecked={checked}
          writeInFlight={false}
          guardStatus="ready"
          guardReason={null}
          otherOperation={false}
          onOutcomeUnknown={() => setUnknown(true)}
          onCheckOutcome={async () => {
            await check();
            setChecked(true);
          }}
          onConfirmOutcome={async () => {
            setUnknown(false);
          }}
          onUpdate={mutate}
          onDownload={async () => null}
          canMutate={() => true}
          completed={false}
          requirement={{ required: true, expectedFilename: 'result.txt' }}
        />
      );
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<View />);
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
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('artifact.unknown');
    const attachButton = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'artifact.attach'
    )!;
    expect(attachButton.disabled).toBe(true);
    const checkButton = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'artifact.checkOutcome'
    )!;
    await act(async () => {
      checkButton.click();
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(attachButton.disabled).toBe(true);
    const confirmButton = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'artifact.confirmOutcome'
    )!;
    await act(async () => {
      confirmButton.click();
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(attachButton.disabled).toBe(false);
    await act(async () => root.unmount());
  });
});
