import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const guardPath = join(
  root,
  'src/main/services/team/provisioning/__tests__/TeamProvisioningServiceFacadeGuard.test.ts'
);
const source = readFileSync(guardPath, 'utf8');
const start = source.indexOf('const DOCUMENTED_EFFECTIVE_PUBLIC_SERVICE_INSTANCE_MEMBERS = [');
if (start < 0) throw new Error('Canonical public surface array not found');
const end = source.indexOf('] as const;', start);
if (end < 0) throw new Error('Canonical public surface array end not found');
const members = [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]);

function callers(member) {
  try {
    const output = execFileSync(
      'git',
      ['grep', '-n', `\\.${member}\\b`, '--', 'src/main', 'src/preload', 'src/renderer'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.replace(/^.*?:(?=\S)/, ''));
  } catch {
    return [];
  }
}

function category(member) {
  if (/OpenCode|opencode|Aggregate|Secondary/i.test(member)) return 'opencode';
  if (/^set[A-Z]/.test(member)) return 'setter';
  if (
    /^(create|launch|stop|cancel|restart|skip|attach|detach|relay|deliver|rebootstrap|reattach|record|answer|warmup|prepare|validate|scan|schedule|initialize|runLive|tryRun|notify|forward|publish)/.test(
      member
    )
  )
    return 'process-or-write';
  if (/^(get|has|is|list|build|resolve|assess)/.test(member)) return 'read';
  return 'unclassified';
}

const rows = members.map((member) => {
  const refs = callers(member);
  const kind = category(member);
  const target =
    kind === 'opencode'
      ? 'keep until 6a'
      : kind === 'read'
        ? 'native mapper'
        : kind === 'process-or-write'
          ? 'native command'
          : kind === 'setter'
            ? 'native wiring'
            : 'manual review (phase 0.1)';
  const test =
    kind === 'opencode'
      ? 'test/features/team-provisioning/main/native*'
      : kind === 'read'
        ? 'test/features/team-provisioning/main/nativeRuntimeConnection.test.ts'
        : kind === 'process-or-write'
          ? 'test/features/team-provisioning/core/*'
          : kind === 'setter'
            ? 'test/features/team-provisioning/main/nativeTeamLifecycleComposition.test.ts'
            : 'phase 0.1';
  return { member, category: kind, count: refs.length, refs: refs.slice(0, 4), target, test };
});

const lines = [
  '# D-445 canonical public surface inventory (generated)',
  '',
  `Generated from \`${guardPath}\` against the current tree. Do not edit by hand; rerun \`node scripts/team-provisioning-inventory.mjs\`.`,
  '',
  `Members: ${rows.length}.`,
  '',
  '| Member | Category | Callers | First callers | Target owner | Test ID |',
  '|---|---|---:|---|---|---|',
  ...rows.map(
    (row) =>
      `| \`${row.member}\` | ${row.category} | ${row.count} | ${
        row.refs.length ? row.refs.map((ref) => `\`${ref}\``).join('<br>') : '—'
      } | ${row.target} | ${row.test} |`
  ),
  '',
  '## Category counts',
  '',
  ...Object.entries(
    rows.reduce((acc, row) => {
      acc[row.category] = (acc[row.category] ?? 0) + 1;
      return acc;
    }, {})
  ).map(([name, count]) => `- ${name}: ${count}`),
  '',
];

const outputPath = join(root, 'docs/team-management/d445-ownership-map.generated.md');
writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log(`Wrote ${outputPath} (${rows.length} members)`);
