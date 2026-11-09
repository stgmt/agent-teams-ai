import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpecificationBinding } from '@renderer/utils/specificationTaskPresentation';
import type { CreateTaskRequest } from '@shared/types';

interface CapturedDialogProps {
  bindingState: 'known' | 'unknown';
  specBindings: readonly SpecificationBinding[];
  defaultOwner: string;
  onClose: () => void;
  onSubmit: (request: CreateTaskRequest) => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  listTeamSpecBindings: vi.fn(
    (_teamName: string): Promise<{ project: string; spec: string }[]> => Promise.resolve([])
  ),
  createTeamTask: vi.fn((_teamName: string, _request: unknown) => Promise.resolve()),
  teamData: { tasks: [], isAlive: true },
  dialogProps: null as CapturedDialogProps | null,
}));

vi.mock('@renderer/api', () => ({
  api: { teams: { listTeamSpecBindings: mocks.listTeamSpecBindings, processSend: vi.fn() } },
}));
vi.mock('@renderer/components/team/dialogs/CreateTaskDialog', () => ({
  CreateTaskDialog: (props: CapturedDialogProps) => {
    mocks.dialogProps = props;
    return null;
  },
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { createTeamTask: typeof mocks.createTeamTask }) => unknown) =>
    selector({ createTeamTask: mocks.createTeamTask }),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: () => false,
  selectResolvedMembersForTeamName: () => [],
  selectTeamDataForName: () => mocks.teamData,
}));

import { useGraphCreateTaskDialog } from '@features/agent-graph/renderer/hooks/useGraphCreateTaskDialog';

const TEAM_NAME = 'graph-team';
let openCreateTaskDialog: (owner?: string) => void = () => undefined;
let mountedRoot: Root | undefined;
let host: HTMLDivElement | undefined;

function Harness(): React.JSX.Element {
  const dialog = useGraphCreateTaskDialog(TEAM_NAME);
  openCreateTaskDialog = dialog.openCreateTaskDialog;
  return <>{dialog.dialog}</>;
}

async function mountHarness(): Promise<void> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(<Harness />);
  });
}

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot?.unmount();
    });
  }
  host?.remove();
  mountedRoot = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.listTeamSpecBindings.mockReset().mockResolvedValue([]);
  mocks.createTeamTask.mockReset().mockResolvedValue(undefined);
  mocks.teamData = { tasks: [], isAlive: true };
  mocks.dialogProps = null;
});

describe('useGraphCreateTaskDialog', () => {
  it('loads current specification bindings on each open and keeps them unknown until loaded', async () => {
    let resolveInitial!: (bindings: SpecificationBinding[]) => void;
    let resolveUpdated!: (bindings: SpecificationBinding[]) => void;
    mocks.listTeamSpecBindings
      .mockReturnValueOnce(new Promise<SpecificationBinding[]>((resolve) => { resolveInitial = resolve; }))
      .mockReturnValueOnce(new Promise<SpecificationBinding[]>((resolve) => { resolveUpdated = resolve; }));

    await mountHarness();
    await act(async () => {
      openCreateTaskDialog('alice');
    });

    expect(mocks.listTeamSpecBindings).toHaveBeenCalledWith(TEAM_NAME);
    expect(mocks.dialogProps).toMatchObject({
      bindingState: 'unknown',
      defaultOwner: 'alice',
      specBindings: [],
    });

    const initialBindings: SpecificationBinding[] = [{ project: 'studio', spec: 'first' }];
    await act(async () => {
      resolveInitial(initialBindings);
      await Promise.resolve();
    });
    expect(mocks.dialogProps).toMatchObject({ bindingState: 'known', specBindings: initialBindings });

    const closeDialog = mocks.dialogProps?.onClose;
    if (typeof closeDialog !== 'function') throw new Error('CreateTaskDialog did not receive onClose');
    await act(async () => {
      closeDialog();
    });
    await act(async () => {
      openCreateTaskDialog();
    });

    expect(mocks.listTeamSpecBindings).toHaveBeenCalledTimes(2);
    expect(mocks.dialogProps).toMatchObject({ bindingState: 'unknown', specBindings: [] });

    const updatedBindings: SpecificationBinding[] = [{ project: 'studio', spec: 'second' }];
    await act(async () => {
      resolveUpdated(updatedBindings);
      await Promise.resolve();
    });
    expect(mocks.dialogProps).toMatchObject({ bindingState: 'known', specBindings: updatedBindings });
    const request: CreateTaskRequest = {
      subject: 'Task for the current specification',
      specProject: 'studio',
      specSlug: 'second',
      requirements: ['FR-1'],
    };
    const currentDialog = mocks.dialogProps;
    if (!currentDialog) throw new Error('CreateTaskDialog did not receive props');
    await act(async () => {
      await currentDialog.onSubmit(request);
    });
    expect(mocks.createTeamTask).toHaveBeenCalledWith(TEAM_NAME, request);
  });

  it('keeps the binding state unknown when the registry binding list fails to load', async () => {
    mocks.listTeamSpecBindings.mockRejectedValue(new Error('registry unavailable'));
    await mountHarness();
    await act(async () => {
      openCreateTaskDialog();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.dialogProps).toMatchObject({ bindingState: 'unknown', specBindings: [] });
  });
});
