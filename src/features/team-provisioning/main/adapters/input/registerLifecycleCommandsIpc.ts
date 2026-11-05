import { TEAM_LIFECYCLE_COMMAND_CHANNELS } from '../../../contracts';

import type { LifecycleCommands } from '../../../core/application/ports/LifecycleCommands';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

export function registerLifecycleCommandsIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  commands: LifecycleCommands,
  getMainContents: () => WebContents | null
): () => void {
  let disposed = false;
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (
      disposed ||
      event.sender !== getMainContents() ||
      event.sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Lifecycle commands require the current main renderer');
  };
  ipc.handle(TEAM_LIFECYCLE_COMMAND_CHANNELS.launch, (event, input: unknown) => {
    trusted(event);
    return commands.launch(input);
  });
  ipc.handle(TEAM_LIFECYCLE_COMMAND_CHANNELS.stop, (event, input: unknown) => {
    trusted(event);
    return commands.stop(input);
  });
  ipc.handle(TEAM_LIFECYCLE_COMMAND_CHANNELS.restartMember, (event, input: unknown) => {
    trusted(event);
    return commands.restartMember(input);
  });
  ipc.handle(TEAM_LIFECYCLE_COMMAND_CHANNELS.skipMember, (event, input: unknown) => {
    trusted(event);
    return commands.skipMember(input);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    for (const channel of Object.values(TEAM_LIFECYCLE_COMMAND_CHANNELS))
      ipc.removeHandler(channel);
  };
}
