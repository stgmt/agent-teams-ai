const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createController } = require('../src/index.js');

const file = (filename, text) => ({ filename, base64Data: Buffer.from(text).toString('base64') });

describe('required task artifacts', () => {
  let dir, desktop, agent, task;
  const stored = () => {
    const current = desktop.getTask(task.id);
    return current.attachments.find(
      (item) => item.id === current.artifactRequirement.proof.attachmentId
    ).filePath;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifact-test-'));
    const teamDir = path.join(dir, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
    desktop = createController({ teamName: 'fixture', claudeDir: dir }).taskBoard;
    agent = createController({
      teamName: 'fixture',
      claudeDir: dir,
      allowUserMessageSender: false,
    }).taskBoard;
    task = desktop.createTask({ subject: 'Fixture artifact task', owner: 'worker' });
  });
  afterEach(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  );

  it('keeps legacy tasks completable and reports no proof', () => {
    expect(desktop.verifyTaskArtifact(task.id)).toBeNull();
    expect(agent.completeTask(task.id, 'worker').status).toBe('completed');
  });

  it.each(['completeTask', 'setTaskStatus'])('requires current stored bytes for %s', (method) => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    const complete = () =>
      method === 'completeTask'
        ? agent.completeTask(task.id, 'worker')
        : agent.setTaskStatus(task.id, 'completed', 'worker');
    expect(complete).toThrow(/not been attached/);
    agent.setTaskArtifactFile(task.id, file('result.txt', 'first'), 'worker');
    const proof = desktop.verifyTaskArtifact(task.id);
    expect(proof).toMatchObject({
      size: 5,
      sha256: crypto.createHash('sha256').update('first').digest('hex'),
    });
    const target = stored();
    fs.writeFileSync(target, 'other');
    expect(complete).toThrow(/has changed/);
    expect(desktop.getTask(task.id).status).toBe('pending');
    fs.unlinkSync(target);
    expect(complete).toThrow(/cannot be verified/);
    fs.writeFileSync(target, 'first');
    expect(complete().status).toBe('completed');
    expect(desktop.verifyTaskArtifact(task.id)).toEqual(proof);
  });

  it('preserves existing review state when verification rejects a review transition', () => {
    desktop.updateTaskFields(task.id, {
      artifactRequired: true,
      artifactFile: file('result.txt', 'before'),
    });
    desktop.completeTask(task.id, 'worker');
    desktop.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
    const reviewBoard = desktop.getKanbanState();
    const reviewTask = desktop.getTask(task.id);
    fs.writeFileSync(stored(), 'after');
    expect(() => desktop.startReview(task.id, { from: 'lead' })).toThrow(/has changed/);
    expect(desktop.getKanbanState()).toEqual(reviewBoard);
    expect(desktop.getTask(task.id)).toEqual(reviewTask);
    expect(() => desktop.requestReview(task.id, { from: 'worker', reviewer: 'lead' })).toThrow(
      /has changed/
    );
    expect(desktop.getKanbanState()).toEqual(reviewBoard);
    expect(desktop.getTask(task.id)).toEqual(reviewTask);
    fs.writeFileSync(stored(), 'before');
    desktop.startReview(task.id, { from: 'lead' });
    fs.writeFileSync(stored(), 'after');
    expect(() => desktop.approveReview(task.id, { from: 'lead' })).toThrow(/has changed/);
  });

  it.each(['completed', 'approved'])(
    'requires reopening an already %s task before adding a requirement',
    (state) => {
      desktop.completeTask(task.id, 'worker');
      if (state === 'approved') {
        desktop.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
        desktop.startReview(task.id, { from: 'lead' });
        desktop.approveReview(task.id, { from: 'lead' });
      }
      const before = desktop.getTask(task.id),
        board = desktop.getKanbanState();
      expect(() => desktop.updateTaskFields(task.id, { artifactRequired: true })).toThrow(/Reopen/);
      expect(() => agent.updateTaskFields(task.id, { artifactRequired: true })).toThrow(
        /Only the user/
      );
      expect(desktop.getTask(task.id)).toEqual(before);
      expect(desktop.getKanbanState()).toEqual(board);
      desktop.setTaskStatus(task.id, 'pending');
      expect(
        desktop.updateTaskFields(task.id, { artifactRequired: true }).artifactRequirement.required
      ).toBe(true);
    }
  );

  it.each(['completed', 'approved'])(
    'prevents changing the proof of an already %s task',
    (state) => {
      desktop.updateTaskFields(task.id, {
        artifactRequired: true,
        artifactFile: file('result.txt', 'first'),
      });
      desktop.completeTask(task.id, 'worker');
      if (state === 'approved') {
        desktop.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
        desktop.startReview(task.id, { from: 'lead' });
        desktop.approveReview(task.id, { from: 'lead' });
      }
      const before = desktop.verifyTaskArtifact(task.id);
      expect(() =>
        agent.setTaskArtifactFile(task.id, file('result.txt', 'other'), 'worker')
      ).toThrow(/Reopen/);
      expect(() =>
        desktop.updateTaskFields(task.id, { artifactFile: file('result.txt', 'other') })
      ).toThrow(/Reopen/);
      expect(() =>
        desktop.updateTaskFields(task.id, { artifactExpectedFilename: 'other.txt' })
      ).toThrow(/Reopen/);
      expect(desktop.verifyTaskArtifact(task.id)).toEqual(before);
    }
  );

  it('preserves the user-selected name against a decoy and allows a new version at the same name', () => {
    desktop.updateTaskFields(task.id, {
      artifactRequired: true,
      artifactExpectedFilename: 'requested.txt',
    });
    expect(() => agent.setTaskArtifactFile(task.id, file('decoy.txt', 'decoy'), 'worker')).toThrow(
      /requested.txt/
    );
    expect(() => agent.completeTask(task.id, 'worker')).toThrow(/not been attached/);
    agent.setTaskArtifactFile(task.id, file('requested.txt', 'first'), 'worker');
    const oldFile = stored();
    const first = desktop.verifyTaskArtifact(task.id);
    agent.setTaskArtifactFile(task.id, file('requested.txt', 'second'), 'worker');
    expect(desktop.verifyTaskArtifact(task.id).sha256).not.toBe(first.sha256);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(desktop.getTask(task.id).artifactRequirement.expectedFilename).toBe('requested.txt');
  });

  it('lets the user explicitly replace the required name and removes the old copy', () => {
    desktop.updateTaskFields(task.id, {
      artifactRequired: true,
      artifactFile: file('old.txt', 'old'),
    });
    const oldFile = stored();
    const updated = desktop.updateTaskFields(task.id, { artifactExpectedFilename: 'new.txt' });
    expect(updated.artifactRequirement).toEqual({ required: true, expectedFilename: 'new.txt' });
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(() => agent.completeTask(task.id, 'worker')).toThrow(/not been attached/);
    agent.setTaskArtifactFile(task.id, file('new.txt', 'new'), 'worker');
    const newFile = stored();
    desktop.updateTaskFields(task.id, { artifactRequired: false });
    expect(fs.existsSync(newFile)).toBe(false);
    expect(desktop.verifyTaskArtifact(task.id)).toBeNull();
  });

  it('locks the first filename when none was specified and enforces existing actor checks', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    expect(() => agent.setTaskArtifactFile(task.id, file('result.txt', 'x'), 'lead')).toThrow(
      /owned/
    );
    expect(() => agent.setTaskArtifactFile(task.id, file('result.txt', 'x'))).toThrow(
      /requires actor/
    );
    agent.setTaskArtifactFile(task.id, file('result.txt', 'x'), 'worker');
    expect(() => agent.setTaskArtifactFile(task.id, file('decoy.txt', 'x'), 'worker')).toThrow(
      /result.txt/
    );
    expect(() =>
      agent.updateTaskFields(task.id, { artifactExpectedFilename: 'decoy.txt' })
    ).toThrow(/Only the user/);
  });

  it('does not accept project paths, path-like names, or caller supplied proofs', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    const outside = path.join(dir, 'outside');
    fs.writeFileSync(outside, 'secret');
    expect(() => desktop.updateTaskFields(task.id, { artifactProjectPath: outside })).toThrow(
      /Project paths are not supported/
    );
    expect(() =>
      desktop.updateTaskFields(task.id, { artifactFile: file('../outside', 'secret') })
    ).toThrow(/filename/);
    agent.updateTaskFields(task.id, { artifactRequirement: { required: false }, attachments: [] });
    expect(() => agent.completeTask(task.id, 'worker')).toThrow(/not been attached/);
  });

  it('rejects the project-path junction race before attempting to inspect the project file', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    const projectFile = path.join(dir, 'project', 'output', 'result.txt');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, 'project data');
    const originalLstat = fs.lstatSync;
    let inspected = false;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((candidate, ...args) => {
      if (path.resolve(String(candidate)) === projectFile) inspected = true;
      return originalLstat(candidate, ...args);
    });
    try {
      expect(() =>
        desktop.updateTaskFields(task.id, { artifactProjectPath: 'output/result.txt' })
      ).toThrow(/Project paths are not supported/);
      expect(inspected).toBe(false);
      expect(desktop.getTask(task.id).artifactRequirement.proof).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects invalid base64 and checks the decoded limit before storing', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    expect(() =>
      desktop.updateTaskFields(task.id, {
        artifactFile: { filename: 'result', base64Data: '!!==' },
      })
    ).toThrow(/base64/);
    const tooBig = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
    expect(() =>
      desktop.updateTaskFields(task.id, {
        artifactFile: { filename: 'result', base64Data: tooBig },
      })
    ).toThrow(/20 MiB/);
    expect(desktop.getTask(task.id).artifactRequirement.proof).toBeUndefined();
    const max = Buffer.alloc(20 * 1024 * 1024).toString('base64');
    desktop.updateTaskFields(task.id, { artifactFile: { filename: 'result', base64Data: max } });
    expect(desktop.verifyTaskArtifact(task.id).size).toBe(20 * 1024 * 1024);
  });

  it('rejects same-sized stored-file changes during verification', () => {
    desktop.updateTaskFields(task.id, {
      artifactRequired: true,
      artifactFile: file('result.bin', Buffer.alloc(2 * 1024 * 1024, 1)),
    });
    const target = stored(),
      originalRead = fs.readSync;
    let changed = false;
    const spy = vi.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const bytes = originalRead(fd, ...args);
      if (!changed && fs.fstatSync(fd).size === 2 * 1024 * 1024) {
        fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 2));
        changed = true;
      }
      return bytes;
    });
    try {
      expect(() => desktop.verifyTaskArtifact(task.id)).toThrow(/changed while it was being read/);
      expect(changed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
