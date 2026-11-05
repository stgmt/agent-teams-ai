const fs = require('fs');
const os = require('os');
const path = require('path');
const { createController } = require('../src/index.js');

describe('required task artifacts', () => {
  let dir, project, desktop, agent, task;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifact-test-'));
    project = path.join(dir, 'project');
    fs.mkdirSync(project);
    const teamDir = path.join(dir, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        projectPath: project,
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

  it.each(['completeTask', 'setTaskStatus'])(
    'requires a current file for %s and preserves the task on failure',
    (method) => {
      desktop.updateTaskFields(task.id, { artifactRequired: true });
      const complete = () =>
        method === 'completeTask'
          ? agent.completeTask(task.id, 'worker')
          : agent.setTaskStatus(task.id, 'completed', 'worker');
      expect(complete).toThrow(/not been attached/);
      const file = path.join(project, 'result.txt');
      fs.writeFileSync(file, 'first');
      agent.setTaskArtifactFile(task.id, 'result.txt', 'worker');
      const proof = desktop.verifyTaskArtifact(task.id);
      expect(proof).toMatchObject({
        size: 5,
        sha256: 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e',
      });
      fs.writeFileSync(file, 'other');
      expect(complete).toThrow(/has changed/);
      expect(desktop.getTask(task.id).status).toBe('pending');
      fs.unlinkSync(file);
      expect(complete).toThrow(/cannot be verified/);
      fs.writeFileSync(file, 'first');
      expect(complete().status).toBe('completed');
      expect(desktop.verifyTaskArtifact(task.id)).toEqual(proof);
    }
  );

  it('rechecks before requesting review and rejects removed attachment metadata', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    fs.writeFileSync(path.join(project, 'result.txt'), 'before');
    desktop.updateTaskFields(task.id, { artifactProjectPath: 'result.txt' });
    desktop.completeTask(task.id, 'worker');
    fs.writeFileSync(path.join(project, 'result.txt'), 'after');
    expect(() => desktop.requestReview(task.id, { from: 'worker', reviewer: 'lead' })).toThrow(
      /has changed/
    );
    fs.writeFileSync(path.join(project, 'result.txt'), 'before');
    desktop.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
    fs.writeFileSync(path.join(project, 'result.txt'), 'after');
    expect(() => desktop.startReview(task.id, { from: 'lead' })).toThrow(/has changed/);
    fs.writeFileSync(path.join(project, 'result.txt'), 'before');
    desktop.startReview(task.id, { from: 'lead' });
    fs.writeFileSync(path.join(project, 'result.txt'), 'after');
    expect(() => desktop.approveReview(task.id, { from: 'lead' })).toThrow(/has changed/);
    fs.writeFileSync(path.join(project, 'result.txt'), 'before');
    const proof = desktop.verifyTaskArtifact(task.id);
    desktop.removeTaskAttachment(task.id, proof.attachmentId);
    expect(() => desktop.verifyTaskArtifact(task.id)).toThrow(/not been attached/);
  });

  it('does not let agents disable or supply their own proof and enforces task ownership', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    fs.writeFileSync(path.join(project, 'result.txt'), 'result');
    expect(() => agent.updateTaskFields(task.id, { artifactRequired: false })).toThrow(
      /Only the user/
    );
    agent.updateTaskFields(task.id, { artifactRequirement: { required: false }, attachments: [] });
    expect(() => agent.completeTask(task.id, 'worker')).toThrow(/not been attached/);
    expect(() => agent.setTaskArtifactFile(task.id, 'result.txt', 'lead')).toThrow(/owned/);
    expect(() => agent.setTaskArtifactFile(task.id, 'result.txt')).toThrow(/requires actor/);
    expect(
      agent.setTaskArtifactFile(task.id, 'result.txt', 'worker').artifactRequirement.proof.size
    ).toBe(6);
  });

  it('rejects traversal, absolute paths and project root changes', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    fs.writeFileSync(path.join(project, 'result.txt'), 'result');
    expect(() =>
      desktop.updateTaskFields(task.id, { artifactProjectPath: '../result.txt' })
    ).toThrow(/relative file path/);
    expect(() =>
      desktop.updateTaskFields(task.id, { artifactProjectPath: path.join(project, 'result.txt') })
    ).toThrow(/relative file path/);
    desktop.updateTaskFields(task.id, { artifactProjectPath: 'result.txt' });
    const alternate = path.join(dir, 'alternate');
    fs.mkdirSync(alternate);
    fs.writeFileSync(path.join(alternate, 'result.txt'), 'result');
    const configFile = path.join(dir, 'teams', 'fixture', 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, projectPath: alternate }));
    expect(() => desktop.verifyTaskArtifact(task.id)).toThrow(/has changed/);
  });

  it('rejects linked directories which escape the project', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'result.txt'), 'outside');
    fs.symlinkSync(outside, path.join(project, 'link'), 'junction');
    expect(() =>
      desktop.updateTaskFields(task.id, { artifactProjectPath: 'link/result.txt' })
    ).toThrow(/symbolic links/);
    expect(() => desktop.completeTask(task.id, 'worker')).toThrow(/not been attached/);
  });

  it('rejects replacement by a junction while an artifact is being read', () => {
    const folder = path.join(project, 'output');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(folder);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(folder, 'result.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    fs.writeFileSync(path.join(outside, 'result.bin'), Buffer.alloc(2 * 1024 * 1024, 2));
    desktop.updateTaskFields(task.id, {
      artifactRequired: true,
      artifactProjectPath: 'output/result.bin',
    });
    const originalRead = fs.readSync;
    let swapped = false;
    let attempted = false;
    let swapError;
    const spy = vi.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const bytes = originalRead(fd, ...args);
      if (!attempted && fs.fstatSync(fd).size === 2 * 1024 * 1024) {
        attempted = true;
        try {
          fs.renameSync(folder, path.join(project, 'previous-output'));
          fs.symlinkSync(outside, folder, 'junction');
          swapped = true;
        } catch (error) {
          swapError = error;
        }
      }
      return bytes;
    });
    try {
      let result, verificationError;
      try {
        result = desktop.verifyTaskArtifact(task.id);
      } catch (error) {
        verificationError = error;
      }
      expect(attempted).toBe(true);
      if (swapped) {
        expect(verificationError.message).toMatch(/cannot be verified/);
      } else {
        expect(['EPERM', 'EACCES', 'EBUSY']).toContain(swapError?.code);
        expect(result.size).toBe(2 * 1024 * 1024);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects same-sized content changes while reading the artifact', () => {
    const file = path.join(project, 'large.bin');
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1));
    desktop.updateTaskFields(task.id, { artifactRequired: true, artifactProjectPath: 'large.bin' });
    const originalRead = fs.readSync;
    let changed = false;
    const spy = vi.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const bytes = originalRead(fd, ...args);
      if (!changed && fs.fstatSync(fd).size === 2 * 1024 * 1024) {
        fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 2));
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

  it('accepts a project file larger than the UI upload limit without loading it into memory', () => {
    const file = path.join(project, 'video.mp4');
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, 21 * 1024 * 1024);
    fs.closeSync(fd);
    desktop.updateTaskFields(task.id, { artifactRequired: true, artifactProjectPath: 'video.mp4' });
    expect(desktop.verifyTaskArtifact(task.id).size).toBe(21 * 1024 * 1024);
  });
});
