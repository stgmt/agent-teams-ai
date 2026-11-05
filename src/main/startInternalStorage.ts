/**
 * Internal-storage startup for the Electron main process.
 *
 * The composition root in `src/main/index.ts` is frozen by
 * `scripts/ci/check-source-file-size.mjs`, so storage-backed startup lives here:
 * this module owns creating the storage feature and running the packaged-smoke
 * backend probe, which must happen before any storage-backed feature is composed.
 */
import {
  createInternalStorageFeature,
  type InternalStorageFeature,
} from '@features/internal-storage/main';
import { resolveAppLocale } from '@features/localization';
import { app } from 'electron';

import { ConfigManager } from './services/infrastructure/ConfigManager';
import { NotificationManager } from './services/infrastructure/NotificationManager';
import { createInternalStorageCommentWarning } from './internalStorageCommentWarning';

export function startInternalStorage(): InternalStorageFeature {
  const feature = createInternalStorageFeature({
    userDataPath: app.getPath('userData'),
    onCommentJournalFailure: createInternalStorageCommentWarning(
      (warning) => NotificationManager.getInstance().addError(warning),
      () =>
        resolveAppLocale({
          preference: ConfigManager.getInstance().getConfig().general.appLocale,
          systemLocale: app.getLocale(),
        })
    ),
  });
  if (process.env.AGENT_TEAMS_PACKAGED_SMOKE?.trim() === '1') {
    void feature.probeBackend();
  }
  return feature;
}
