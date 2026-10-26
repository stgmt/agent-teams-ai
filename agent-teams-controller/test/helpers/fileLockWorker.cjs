// Child process of fileLock.contention.test.js: appends lines to one file under withFileLock.
const fs = require('node:fs');
const { withFileLock, withFileLockSync } = require('../../src/internal/fileLock');

const [target, iterationsArg, mode] = process.argv.slice(2);
const errors = {};
let ok = 0;

function record(error) {
  const key = `${error.code ?? 'ERR'} ${error.syscall ?? ''} ${String(error.message).slice(0, 60)}`;
  errors[key] = (errors[key] ?? 0) + 1;
}

async function main() {
  for (let i = 0; i < Number(iterationsArg); i += 1) {
    try {
      if (mode === 'sync') {
        withFileLockSync(target, () => fs.appendFileSync(target, 'x\n'));
      } else {
        await withFileLock(target, async () => fs.appendFileSync(target, 'x\n'));
      }
      ok += 1;
    } catch (error) {
      record(error);
    }
  }
  process.stdout.write(JSON.stringify({ ok, errors }));
}

void main();
