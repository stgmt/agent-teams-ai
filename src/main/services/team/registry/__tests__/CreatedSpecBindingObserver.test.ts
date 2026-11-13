// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamConfigReader } from '../../TeamConfigReader';
import { TeamMetaStore } from '../../TeamMetaStore';
import { CreatedSpecBindingObserver } from '../CreatedSpecBindingObserver';

const subject = { teamName: 'creation-team', sessionId: 'session-1' };
const project = 'owner/project';

function call(id = 'create-1', spec = 'first-spec', selectedProject = project) {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'mcp__agent_teams__team_spec_spec_patch',
          input: {
            intent: 'createSpec',
            dryRun: false,
            project: selectedProject,
            spec,
            requestId: id,
          },
        },
      ],
    },
  };
}

function result(id = 'create-1', spec = 'first-spec', selectedProject = project) {
  return {
    ok: true,
    error: null,
    provenance: { project: selectedProject },
    data: {
      schemaVersion: 'spec-mcp-operations-patch@1',
      requestId: id,
      dryRun: false,
      proposalHash: 'confirmed-proposal',
      outcome: 'APPLIED',
      receipt: {
        schemaVersion: 'spec-mcp-operations-receipt@1',
        requestId: id,
        proposalHash: 'confirmed-proposal',
        outcome: 'APPLIED',
        changedDocuments: [
          { path: `.specs/${spec}/SPEC.md`, beforeSha256: null, afterSha256: 'created-content' },
        ],
      },
    },
  };
}

function event(value: unknown = result(), id = 'create-1', isError = false) {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: isError,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        },
      ],
    },
  };
}

describe('registry-confirmed spec creation binding', () => {
  let root: string;
  let metadata: TeamMetaStore;
  let observer: CreatedSpecBindingObserver;
  let configPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'created-spec-binding-'));
    setClaudeBasePathOverride(root);
    const directory = join(root, 'teams', subject.teamName);
    await mkdir(directory, { recursive: true });
    const specScope = { projects: [project], bindings: [] };
    await writeFile(
      join(directory, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: root,
        createdAt: 1,
        specScope,
      })
    );
    configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ name: 'Creation Team', members: [], specScope, custom: 'preserved' })
    );
    metadata = new TeamMetaStore();
    observer = new CreatedSpecBindingObserver({
      teamMetaStore: metadata,
      configReader: new TeamConfigReader(),
    });
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  it('binds the first specification from an empty binding set and leaves replayed bytes unchanged', async () => {
    await observer.observe(subject, call());
    await observer.observe(subject, event());
    expect((await metadata.getMeta(subject.teamName))?.specScope).toEqual({
      projects: [project],
      bindings: [{ project, spec: 'first-spec' }],
    });
    const metadataPath = join(root, 'teams', subject.teamName, 'team.meta.json');
    const before = await readFile(metadataPath, 'utf8');
    await observer.observe(subject, call());
    await observer.observe(subject, event());
    expect(await readFile(metadataPath, 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(configPath, 'utf8')).specScope.bindings).toEqual([
      { project, spec: 'first-spec' },
    ]);
  });

  it('persists the first binding, preserves concurrent existing/copy bindings and replays idempotently', async () => {
    await observer.observe(subject, call());
    await metadata.updateSpecScope(subject.teamName, (current) => ({
      ...current,
      bindings: [{ project, spec: 'copied-spec' }],
    }));
    await observer.observe(subject, call('create-2', 'second-spec'));
    await Promise.all([
      observer.observe(subject, event()),
      observer.observe(subject, event(result('create-2', 'second-spec'), 'create-2')),
    ]);
    await observer.observe(subject, call());
    await observer.observe(subject, event());
    await observer.observe(subject, event());
    const expected = [
      { project, spec: 'copied-spec' },
      { project, spec: 'first-spec' },
      { project, spec: 'second-spec' },
    ];
    const stored = await new TeamMetaStore().getMeta(subject.teamName);
    expect(stored?.specScope?.projects).toEqual([project]);
    expect(stored?.specScope?.bindings).toHaveLength(3);
    expect(stored?.specScope?.bindings).toEqual(expect.arrayContaining(expected));
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      custom: 'preserved',
      specScope: stored?.specScope,
    });
  });

  it.each([
    'refused',
    'preview',
    'error',
    'unrelated',
    'mismatched-spec',
    'mismatched-request',
    'prose',
    'uncorrelated',
    'other-session',
  ])('does not bind %s results', async (variant) => {
    const response = result();
    await observer.observe(subject, call());
    if (variant === 'refused') response.data.outcome = 'REFUSED';
    if (variant === 'preview') {
      response.data.outcome = 'PREVIEW';
      response.data.dryRun = true;
    }
    if (variant === 'unrelated') response.provenance.project = 'foreign/project';
    if (variant === 'mismatched-spec')
      response.data.receipt.changedDocuments[0].path = '.specs/another-spec/SPEC.md';
    if (variant === 'mismatched-request') response.data.receipt.requestId = 'different';
    const incoming = event(
      variant === 'prose' ? 'Successfully created first-spec' : response,
      variant === 'uncorrelated' ? 'unknown-call' : 'create-1',
      variant === 'error'
    );
    await observer.observe(
      variant === 'other-session' ? { ...subject, sessionId: 'other-session' } : subject,
      incoming
    );
    expect((await metadata.getMeta(subject.teamName))?.specScope).toEqual({
      projects: [project],
      bindings: [],
    });
    expect(JSON.parse(await readFile(configPath, 'utf8')).specScope.bindings).toEqual([]);
  });

  it('checks current authority inside the writer lock and never restores a removed project', async () => {
    await observer.observe(subject, call());
    await metadata.updateSpecScope(subject.teamName, () => ({
      projects: ['owner/replacement'],
      bindings: [],
    }));
    await expect(observer.observe(subject, event())).rejects.toThrow(
      'outside the current team scope'
    );
    expect((await metadata.getMeta(subject.teamName))?.specScope).toEqual({
      projects: ['owner/replacement'],
      bindings: [],
    });
  });

  it('retains the result for retry after config projection fails, without duplicating the canonical binding', async () => {
    await observer.observe(subject, call());
    const saved = await readFile(configPath, 'utf8');
    await rm(configPath);
    await expect(observer.observe(subject, event())).rejects.toThrow('missing team configuration');
    expect((await metadata.getMeta(subject.teamName))?.specScope?.bindings).toEqual([
      { project, spec: 'first-spec' },
    ]);
    await writeFile(configPath, saved);
    await observer.observe(subject, event());
    expect(JSON.parse(await readFile(configPath, 'utf8')).specScope.bindings).toEqual([
      { project, spec: 'first-spec' },
    ]);
  });
});
