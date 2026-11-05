const path = require('node:path');
const fs = require('node:fs');
const { withFileLock } = require('../../src/internal/fileLock.js');
const { createController } = require('../../src/controller.js');

const [mode, claudeDir] = process.argv.slice(2);
const teamName = 'my-team';
const boardLockPath = path.join(claudeDir, 'teams', teamName, 'board-state');
// This shared gate is the one TeamKanbanManager holds across async registry reads.

function send(type, detail = {}) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('Board lock race worker requires an IPC channel'));
      return;
    }
    process.send({ type, ...detail }, (error) => (error ? reject(error) : resolve()));
  });
}

function waitForRelease() {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== 'release') return;
      process.off('message', onMessage);
      resolve();
    };
    process.on('message', onMessage);
  });
}

async function holdBoardLock() {
  const release = waitForRelease();
  await withFileLock(boardLockPath, async () => {
    await send('locked');
    await release;
  });
  await send('released');
  process.disconnect();
}

async function collectAgenda(controller, mode) {
  const facts = controller.taskBoard.readLeadReportFacts();
  const inventory = controller.taskBoard.listTaskInventory();
  const briefing = await controller.taskBoard.memberBriefing('bob', {
    includeActiveProcesses: false,
  });
  const startup =
    mode === 'child'
      ? controller.taskBoard.deliverStartupWork('bob', {
          launchId: `board-lock-race-${mode}`,
        })
      : await controller.taskBoard.deliverStartupWorkAsync('bob', {
          launchId: `board-lock-race-${mode}`,
          isCurrent: () => true,
        });
  await send('complete', {
    facts: facts.length,
    inventory: inventory.length,
    briefing: typeof briefing === 'string',
    delivered: startup.delivered.length,
  });
}

async function readAgendaUnderSameThreadLock() {
  const release = waitForRelease();
  let signalLockAcquired;
  const lockAcquired = new Promise((resolve) => {
    signalLockAcquired = resolve;
  });
  const lock = withFileLock(boardLockPath, async () => {
    await send('locked');
    signalLockAcquired();
    await release;
  });
  await lockAcquired;
  await collectAgenda(
    createController({ teamName, claudeDir, readOnlyTaskSnapshot: [] }),
    'snapshot-same-thread'
  );
  await lock;
  await send('released');
  process.disconnect();
}

async function deliverWithInboxLockSameThread() {
  const seedingController = createController({ teamName, claudeDir });
  const task = seedingController.taskBoard.createTask({
    subject: 'Inbox lock race assignment',
    owner: 'bob',
    requirements: ['FR-1'],
  });
  const controller = createController({
    teamName,
    claudeDir,
    readOnlyTaskSnapshot: [task],
  });
  const inboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'bob.json');
  if (fs.existsSync(inboxPath)) {
    const existingRows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    fs.writeFileSync(
      inboxPath,
      JSON.stringify(existingRows.map((row) => ({ ...row, read: true })))
    );
  }
  const release = waitForRelease();
  let signalLockAcquired;
  const lockAcquired = new Promise((resolve) => {
    signalLockAcquired = resolve;
  });
  const lock = withFileLock(inboxPath, async () => {
    await send('inbox-locked');
    signalLockAcquired();
    await release;
  });
  await lockAcquired;

  const launchId = 'inbox-lock-race-1';
  const firstDelivery = controller.taskBoard.deliverStartupWorkAsync('bob', {
    launchId,
    isCurrent: () => true,
  });
  const secondDelivery = controller.taskBoard.deliverStartupWorkAsync('bob', {
    launchId,
    isCurrent: () => true,
  });
  setImmediate(() => {
    send('event-loop-responsive').catch((error) =>
      send('error', { message: error instanceof Error ? error.message : String(error) })
    );
  });
  const results = await Promise.all([firstDelivery, secondDelivery]);
  const messageId = `startup-work:${launchId}:bob:${task.id}:assignment`;
  const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
  const startupRows = rows.filter((row) => row.messageId === messageId);
  await send('complete', {
    delivered: results.reduce((count, result) => count + result.delivered.length, 0),
    duplicateSkips: results.reduce(
      (count, result) =>
        count + result.skipped.filter((item) => item.reason === 'duplicate_message').length,
      0
    ),
    startupRows: startupRows.length,
    messageId: startupRows[0]?.messageId,
  });
  await lock;
  await send('released');
  process.disconnect();
}

async function readAgenda(mode) {
  const options = { teamName, claudeDir };
  if (mode === 'snapshot') options.readOnlyTaskSnapshot = [];
  await collectAgenda(createController(options), mode);
  process.disconnect();
}

async function main() {
  if (mode === 'hold') return holdBoardLock();
  if (mode === 'same-thread-snapshot') return readAgendaUnderSameThreadLock();
  if (mode === 'same-thread-inbox-snapshot') return deliverWithInboxLockSameThread();
  if (mode === 'snapshot' || mode === 'child') return readAgenda(mode);
  throw new Error(`Unknown board lock race worker mode: ${String(mode)}`);
}

main().catch(async (error) => {
  try {
    await send('error', { message: error instanceof Error ? error.message : String(error) });
  } catch {}
  process.exitCode = 1;
  if (typeof process.disconnect === 'function' && process.connected) process.disconnect();
});
