import * as fs from 'node:fs';

import {
  getTeamLaunchStatePath,
  TeamLaunchStateStore,
} from '@main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

setClaudeBasePathOverride(process.argv[2]);
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
const originalRead = fs.promises.readFile;
let intercepted = false;
fs.promises.readFile = (async (file: unknown, ...args: unknown[]) => {
  if (!intercepted && String(file) === getTeamLaunchStatePath('fixture')) {
    intercepted = true;
    process.stdout.write('LAUNCH_HAS_LOCK\n');
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  }
  return (originalRead as (...params: unknown[]) => Promise<unknown>)(file, ...args);
}) as typeof fs.promises.readFile;
const published = await new TeamLaunchStateStore().beginLaunch(
  'fixture',
  'successor-run',
  ['lead'],
  () => true
);
process.stdout.write(`LAUNCH_DONE ${JSON.stringify({ published })}\n`);
