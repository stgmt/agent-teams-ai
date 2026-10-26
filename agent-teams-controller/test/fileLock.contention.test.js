const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const worker = path.join(__dirname, 'helpers', 'fileLockWorker.cjs');

function runWorker(target, iterations, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, target, String(iterations), mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('file lock across processes', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-contention-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  // On Windows a path another process is deleting answers EPERM until the delete
  // completes. Before the lock treated that as contention, 8 writers lost about
  // half of their acquisitions to EPERM open/rename/scandir/rmdir errors.
  it.each(['async', 'sync'])(
    'serializes %s writers in separate processes without spurious permission errors',
    async (mode) => {
      const target = path.join(dir, 'journal.jsonl');
      fs.writeFileSync(target, '');
      const workers = 6;
      const iterations = 100;

      const results = await Promise.all(
        Array.from({ length: workers }, () => runWorker(target, iterations, mode))
      );

      expect(results.map((result) => result.errors)).toEqual(results.map(() => ({})));
      expect(results.reduce((sum, result) => sum + result.ok, 0)).toBe(workers * iterations);
      expect(fs.readFileSync(target, 'utf8').split('\n').filter(Boolean)).toHaveLength(
        workers * iterations
      );
    }
  );
});
