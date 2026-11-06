import * as fs from 'node:fs';

import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { TeamTaskActivityIntervalService } from '@main/services/team/TeamTaskActivityIntervalService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

const root = process.argv[2];
if (!root) throw new Error('Missing fixture root');
setClaudeBasePathOverride(root);
if (process.argv[3]) fs.writeFileSync(process.argv[3], 'ready');
const published = await new TeamLaunchStateStore().beginLaunch(
  'fixture',
  'other-process-run',
  ['lead'],
  () => true
);
if (process.argv[4]) fs.writeFileSync(process.argv[4], 'done');
const result = new TeamTaskActivityIntervalService().resumeActiveIntervalsForMember(
  'fixture',
  'lead',
  '2026-11-06T00:00:00.000Z'
);
process.stdout.write(JSON.stringify({ published, result }));
