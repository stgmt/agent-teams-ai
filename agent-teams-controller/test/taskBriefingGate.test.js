const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

// Level L2 of the member-startup bugfix, S1.20: while the app has not confirmed a native
// member's launch, the member's own task_briefing call does not hand it work. Work in a turn
// that began before the confirmation keeps the member in that turn and brings back the
// "failed to start" the hand-over after the confirmation was made to avoid. The member asks
// the app (the member diagnostics route); the app is the source of the confirmation.

describe('task_briefing asked by a member while its launch is not confirmed (S1.20)', () => {
  let dir;
  let controller;
  let appServer = null;
  let savedControlUrl;

  const teamDir = () => path.join(dir, 'teams', 'fixture');

  // РИСК: сервер имитирует приложение. Он отвечает JSON такой же формы, как настоящий
  // маршрут `/members/diagnostics`; настоящее подтверждение запуска и процессы членов он не
  // покрывает (это уровень L3, startup.live.test.ts).
  const startFakeApp = async (members) => {
    appServer = http.createServer((request, response) => {
      if (request.url === '/api/teams/fixture/members/diagnostics') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            teamName: 'fixture',
            generatedAt: new Date().toISOString(),
            runId: 'run-1',
            members,
          })
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
    const { port } = appServer.address();
    fs.writeFileSync(
      path.join(dir, 'team-control-api.json'),
      JSON.stringify({ baseUrl: `http://127.0.0.1:${port}` })
    );
  };

  const appKnows = (memberName, bootstrapConfirmed) => ({
    memberName,
    isLead: false,
    diagnostics: [],
    alive: true,
    runtimeAlive: true,
    launchState: bootstrapConfirmed ? 'confirmed_alive' : 'runtime_pending_bootstrap',
    bootstrapConfirmed,
  });

  beforeEach(() => {
    savedControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    delete process.env.CLAUDE_TEAM_CONTROL_URL;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-briefing-gate-'));
    fs.mkdirSync(teamDir(), { recursive: true });
    fs.writeFileSync(
      path.join(teamDir(), 'config.json'),
      JSON.stringify({
        name: 'fixture',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
          { name: 'carol', role: 'developer', providerId: 'opencode' },
        ],
      })
    );
    controller = createController({ teamName: 'fixture', claudeDir: dir });
    controller.taskBoard.createTask({ subject: 'Reconcile the ledger', owner: 'bob' });
    controller.taskBoard.createTask({ subject: 'Export the kassa', owner: 'carol' });
  });

  afterEach(async () => {
    if (appServer) {
      await new Promise((resolve) => appServer.close(resolve));
      appServer = null;
    }
    if (savedControlUrl === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
    else process.env.CLAUDE_TEAM_CONTROL_URL = savedControlUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('S1.20: before the confirmation the member is told its work arrives as messages, with no task rows', async () => {
    await startFakeApp([appKnows('bob', false)]);

    const text = await controller.taskBoard.requestTaskBriefing('bob');

    expect(text).toContain('No Actionable work is loaded');
    expect(text).toContain('after the app confirms your launch');
    expect(text).not.toContain('Reconcile the ledger');
  });

  it('S1.20: after the confirmation the member gets its task briefing', async () => {
    await startFakeApp([appKnows('bob', true)]);

    const text = await controller.taskBoard.requestTaskBriefing('bob');

    expect(text).toContain('Reconcile the ledger');
    expect(text).not.toContain('No Actionable work is loaded');
  });

  it('S1.20: the confirmation of another member does not release this one', async () => {
    await startFakeApp([appKnows('bob', false), appKnows('dora', true)]);

    const text = await controller.taskBoard.requestTaskBriefing('bob');

    expect(text).toContain('No Actionable work is loaded');
  });

  it('S1.17: an OpenCode member keeps its task queue in the briefing and is not held back', async () => {
    await startFakeApp([appKnows('carol', false)]);

    const text = await controller.taskBoard.requestTaskBriefing('carol');

    expect(text).toContain('Export the kassa');
  });

  it('the lead is not held back: its work is not handed over after a confirmation', async () => {
    await startFakeApp([{ ...appKnows('alice', false), isLead: true }]);

    const text = await controller.taskBoard.requestTaskBriefing('alice');

    expect(text).not.toContain('No Actionable work is loaded');
  });

  it('a member the app does not list is not held back (no launch of it is under way)', async () => {
    await startFakeApp([appKnows('someone-else', false)]);

    const text = await controller.taskBoard.requestTaskBriefing('bob');

    expect(text).toContain('Reconcile the ledger');
  });

  it('when the app does not answer the member gets an error that names the reason, not a guess', async () => {
    await startFakeApp([appKnows('bob', true)]);
    await new Promise((resolve) => appServer.close(resolve));
    appServer = null;

    await expect(controller.taskBoard.requestTaskBriefing('bob')).rejects.toThrow(
      /app did not answer.*launch/is
    );
  });

  it('when no control address exists the error says so', async () => {
    await expect(controller.taskBoard.requestTaskBriefing('bob')).rejects.toThrow(
      /Team control API is unavailable/
    );
  });

  it('the plain taskBriefing of the board is unchanged: it never asks the app', async () => {
    const text = await controller.taskBoard.taskBriefing('bob');

    expect(text).toContain('Reconcile the ledger');
  });
});
