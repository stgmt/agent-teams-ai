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
    fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({
      name: 'fixture', projectPath: project,
      members: [{ name: 'lead', role: 'team-lead' }, { name: 'worker', role: 'developer' }],
    }));
    desktop = createController({ teamName: 'fixture', claudeDir: dir }).taskBoard;
    agent = createController({ teamName: 'fixture', claudeDir: dir, allowUserMessageSender: false }).taskBoard;
    task = desktop.createTask({ subject: 'Fixture artifact task', owner: 'worker' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

  it('keeps legacy tasks completable and reports no proof', () => {
    expect(desktop.verifyTaskArtifact(task.id)).toBeNull();
    expect(agent.completeTask(task.id, 'worker').status).toBe('completed');
  });

  it.each(['completeTask', 'setTaskStatus'])('requires a current file for %s and preserves the task on failure', (method) => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    const complete = () => method === 'completeTask'
      ? agent.completeTask(task.id, 'worker') : agent.setTaskStatus(task.id, 'completed', 'worker');
    expect(complete).toThrow(/not been attached/);
    const file = path.join(project, 'result.txt');
    fs.writeFileSync(file, 'first');
    agent.setTaskArtifactFile(task.id, 'result.txt', 'worker');
    const proof = desktop.verifyTaskArtifact(task.id);
    expect(proof).toMatchObject({ size: 5, sha256: 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e' });
    fs.writeFileSync(file, 'other');
    expect(complete).toThrow(/has changed/);
    expect(desktop.getTask(task.id).status).toBe('pending');
    fs.unlinkSync(file);
    expect(complete).toThrow(/cannot be verified/);
    fs.writeFileSync(file, 'first');
    expect(complete().status).toBe('completed');
    expect(desktop.verifyTaskArtifact(task.id)).toEqual(proof);
  });

  it('rechecks before requesting review and rejects removed attachment metadata', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    fs.writeFileSync(path.join(project, 'result.txt'), 'before');
    desktop.updateTaskFields(task.id, { artifactProjectPath: 'result.txt' });
    desktop.completeTask(task.id, 'worker');
    fs.writeFileSync(path.join(project, 'result.txt'), 'after');
    expect(() => desktop.requestReview(task.id, { from: 'worker', reviewer: 'lead' })).toThrow(/has changed/);
    fs.writeFileSync(path.join(project, 'result.txt'), 'before');
    const proof = desktop.verifyTaskArtifact(task.id);
    desktop.removeTaskAttachment(task.id, proof.attachmentId);
    expect(() => desktop.verifyTaskArtifact(task.id)).toThrow(/not been attached/);
  });

  it('does not let agents disable or supply their own proof and enforces task ownership', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    fs.writeFileSync(path.join(project, 'result.txt'), 'result');
    expect(() => agent.updateTaskFields(task.id, { artifactRequired: false })).toThrow(/Only the user/);
    agent.updateTaskFields(task.id, { artifactRequirement: { required: false }, attachments: [] });
    expect(() => agent.completeTask(task.id, 'worker')).toThrow(/not been attached/);
    expect(() => agent.setTaskArtifactFile(task.id, 'result.txt', 'lead')).toThrow(/owned/);
    expect(() => agent.setTaskArtifactFile(task.id, 'result.txt')).toThrow(/requires actor/);
    expect(agent.setTaskArtifactFile(task.id, 'result.txt', 'worker').artifactRequirement.proof.size).toBe(6);
  });

  it('rejects traversal, absolute paths and project root changes', () => {
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    fs.writeFileSync(path.join(project, 'result.txt'), 'result');
    expect(() => desktop.updateTaskFields(task.id, { artifactProjectPath: '../result.txt' })).toThrow(/relative file path/);
    expect(() => desktop.updateTaskFields(task.id, { artifactProjectPath: path.join(project, 'result.txt') })).toThrow(/relative file path/);
    desktop.updateTaskFields(task.id, { artifactProjectPath: 'result.txt' });
    const alternate = path.join(dir, 'alternate');
    fs.mkdirSync(alternate);
    fs.writeFileSync(path.join(alternate, 'result.txt'), 'result');
    const configFile = path.join(dir, 'teams', 'fixture', 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, projectPath: alternate }));
    expect(() => desktop.verifyTaskArtifact(task.id)).toThrow(/has changed/);
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
