const AGENT_TEAMS_PREFIXES = [
  'mcp__agent-teams__',
  'mcp__agent_teams__',
  'agent-teams_',
  'agent_teams_',
] as const;

const TASK_BOUNDARY_TOOL_NAMES = ['task_start', 'task_complete', 'task_set_status'] as const;
const TASK_BOUNDARY_TOOL_SET = new Set<string>(TASK_BOUNDARY_TOOL_NAMES);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TASK_BOUNDARY_TOOL_LINE_PATTERN = new RegExp(
  `"name"\\s*:\\s*"(?:${[
    ...TASK_BOUNDARY_TOOL_NAMES,
    ...TASK_BOUNDARY_TOOL_NAMES.map((toolName) => `proxy_${toolName}`),
    ...AGENT_TEAMS_PREFIXES.flatMap((prefix) =>
      TASK_BOUNDARY_TOOL_NAMES.map((toolName) => `${prefix}${toolName}`)
    ),
    ...AGENT_TEAMS_PREFIXES.flatMap((prefix) =>
      TASK_BOUNDARY_TOOL_NAMES.map((toolName) => `proxy_${prefix}${toolName}`)
    ),
  ]
    .map(escapeRegex)
    .join('|')})"`
);

/**
 * Built-in runtime task tools write to the agent's own private task list
 * (`tasks/<list id>/`), never to the team board. Team agents now run with an
 * isolated personal list, so their numeric task ids have no relationship to a
 * board task with the same number. Board attribution must ignore these tools;
 * app-provided task tools (`task_start`, `task_complete`, ...) remain the only
 * transcript evidence of board work.
 */
const BUILTIN_PERSONAL_TASK_TOOL_NAMES = new Set([
  'taskcreate',
  'taskupdate',
  'taskget',
  'tasklist',
  'todowrite',
]);

export function isBuiltinPersonalTaskToolName(rawName: string): boolean {
  return BUILTIN_PERSONAL_TASK_TOOL_NAMES.has(
    canonicalizeAgentTeamsToolName(rawName).toLowerCase()
  );
}

export function canonicalizeAgentTeamsToolName(rawName: string): string {
  const normalized = rawName.trim().replace(/^proxy_/, '');

  for (const prefix of AGENT_TEAMS_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }

  return normalized;
}

export function isAgentTeamsToolName(rawName: string, canonicalName: string): boolean {
  return canonicalizeAgentTeamsToolName(rawName).toLowerCase() === canonicalName.toLowerCase();
}

export function isAgentTeamsToolUse(input: {
  rawName: string;
  canonicalName: string;
  toolInput?: Record<string, unknown>;
  currentTeamName?: string;
}): boolean {
  const rawName = input.rawName.trim();
  const normalizedRawName = rawName.replace(/^proxy_/, '');
  const canonical = canonicalizeAgentTeamsToolName(rawName);
  if (canonical.toLowerCase() !== input.canonicalName.toLowerCase()) {
    return false;
  }

  const hasKnownPrefix = AGENT_TEAMS_PREFIXES.some((prefix) =>
    normalizedRawName.startsWith(prefix)
  );
  if (hasKnownPrefix) {
    return true;
  }

  if (input.canonicalName === 'message_send') {
    return (
      typeof input.toolInput?.teamName === 'string' &&
      input.toolInput.teamName === input.currentTeamName &&
      typeof input.toolInput?.to === 'string' &&
      typeof input.toolInput?.text === 'string'
    );
  }

  if (input.canonicalName === 'cross_team_send') {
    return (
      typeof input.toolInput?.teamName === 'string' &&
      input.toolInput.teamName === input.currentTeamName &&
      typeof input.toolInput?.toTeam === 'string' &&
      typeof input.toolInput?.text === 'string'
    );
  }

  return false;
}

export function isAgentTeamsTaskBoundaryToolName(rawName: string): boolean {
  return TASK_BOUNDARY_TOOL_SET.has(canonicalizeAgentTeamsToolName(rawName));
}

export function lineHasAgentTeamsTaskBoundaryToolName(line: string): boolean {
  return TASK_BOUNDARY_TOOL_LINE_PATTERN.test(line);
}
