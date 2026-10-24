/**
 * Воспроизведение, часть 2: что получает агент после «Save + Restart» (спека bugfix-member-save-restart).
 *
 * Перезапуск живого агента строит стартовый контекст так же, как launchDirectProcessMemberRestartInternal:
 * buildNativeAppManagedBootstrapSpecs с составом из ОДНОГО участника (TeamProvisioningMemberLifecycle.ts:915-922).
 * Настоящая сборка контекста, настоящее хранилище участников, временная папка вместо ~/.claude.
 *
 * РИСК: тест проверяет содержимое стартового контекста, а не то, что процесс его прочитал;
 * чтение процессом и подтверждение запуска покрывают сценарии SR-07 и SR-08 спеки.
 */
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildNativeAppManagedBootstrapSpecs } from '../../../../src/main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const TEAM = 'restart-context-team';
const LONG_WORKFLOW = [
  'Ты DEPLOY. Выкатываешь только готовый кандидат.',
  ...Array.from(
    { length: 60 },
    (_, i) => `Шаг ${i + 1}: проверить ревизию и образ, сравнить с кандидатом, записать результат.`
  ),
  'ПОСЛЕДНЯЯ СТРОКА: откат делается командой gate.sh rollback.',
].join('\n');

describe('стартовый контекст перезапущенного агента (воспроизведение)', () => {
  let tempClaudeRoot = '';

  beforeEach(async () => {
    tempClaudeRoot = await mkdtemp(join(tmpdir(), 'restart-context-'));
    setClaudeBasePathOverride(tempClaudeRoot);
    await new TeamMetaStore().writeMeta(TEAM, {
      cwd: '/tmp/workspace',
      providerId: 'anthropic',
      model: 'claude-sonnet-5-5',
      createdAt: Date.now(),
    });
    await new TeamMembersMetaStore().writeMembers(TEAM, [
      { name: 'DEPLOY', providerId: 'anthropic', role: 'architect', workflow: LONG_WORKFLOW },
      { name: 'REVIWER', providerId: 'anthropic', role: 'reviewer' },
      { name: 'BALANSER', providerId: 'anthropic', role: 'developer' },
    ]);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await rm(tempClaudeRoot, { recursive: true, force: true });
  });

  it('SR-06 новый workflow доходит до агента целиком, вместе с последней строкой', async () => {
    const specs = await buildNativeAppManagedBootstrapSpecs({
      teamName: TEAM,
      cwd: '/tmp/workspace',
      members: [
        { name: 'DEPLOY', providerId: 'anthropic', role: 'architect', workflow: LONG_WORKFLOW },
      ],
    });

    const context = specs.get('DEPLOY')?.contextText ?? '';
    expect(context).toContain('Шаг 1:');
    expect(context).toContain('Шаг 60:');
    expect(context).toContain('ПОСЛЕДНЯЯ СТРОКА: откат делается командой gate.sh rollback.');
    // Общий хвост правил в briefing обрезается по лимиту 18 000 знаков, workflow стоит раньше и доходит целиком.
  });

  it('SR-06b перезапущенный агент видит команду (состав), а не только себя', async () => {
    const specs = await buildNativeAppManagedBootstrapSpecs({
      teamName: TEAM,
      cwd: '/tmp/workspace',
      members: [
        { name: 'DEPLOY', providerId: 'anthropic', role: 'architect', workflow: LONG_WORKFLOW },
      ],
    });

    const context = specs.get('DEPLOY')?.contextText ?? '';
    expect(context).toContain('REVIWER');
    expect(context).toContain('BALANSER');
  });
});
