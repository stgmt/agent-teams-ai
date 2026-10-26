// @vitest-environment node
import { createDefaultTeamProvisioningRuntimeResourceSampling } from '@main/services/team/provisioning/TeamProvisioningRuntimeResourceSamplingFactory';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('node:child_process');
vi.unmock('child_process');

/** Real host observation only: the same read-only PowerShell probe the app runs,
 * through the reader and the default options the app is built with. A test that
 * stubs the reader cannot see that the default timeout cuts the real query off.
 */
describe.skipIf(process.platform !== 'win32')(
  'real Windows host process table for liveness',
  () => {
    it('reads this Node process within the default runtime sampling timeout', async () => {
      const sampling = createDefaultTeamProvisioningRuntimeResourceSampling(
        { getRuntimeSnapshotCacheGeneration: () => 1, getTrackedRunId: () => null },
        { logDebug: vi.fn() }
      );

      const result =
        await sampling.readWindowsHostProcessRowsForLiveRuntimeMetadata('liveness-probe');

      expect({
        processTableAvailable: result.processTableAvailable,
        selfPresent: result.rows.some((row) => row.pid === process.pid),
      }).toEqual({ processTableAvailable: true, selfPresent: true });
    }, 30_000);
  }
);
