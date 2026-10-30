import { TEAM_SUBMIT_HUMAN_REQUEST } from '../../../contracts';

import type { HumanRequestSubmission } from '../../../core/application/ports/HumanRequestSubmission';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

/** A model's lead credential is not permission to originate a human question. */
export function registerHumanRequestSubmissionIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  submission: HumanRequestSubmission,
  getMainContents: () => WebContents | null
): () => void {
  let disposed = false;
  ipc.handle(TEAM_SUBMIT_HUMAN_REQUEST, (event: IpcMainInvokeEvent, input: unknown) => {
    if (
      disposed ||
      event.sender !== getMainContents() ||
      event.sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Human request submission requires the current main renderer');
    return submission.submit(input);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    ipc.removeHandler(TEAM_SUBMIT_HUMAN_REQUEST);
  };
}
