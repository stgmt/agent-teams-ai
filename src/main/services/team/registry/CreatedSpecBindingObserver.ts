import { resolveTeamSpecScope, validateSpecBinding } from './TeamSpecBinding';

import type { TeamConfigReader } from '../TeamConfigReader';
import type { TeamMetaStore } from '../TeamMetaStore';
import type { TeamSpecBinding } from '@shared/types';

export interface CreatedSpecBindingSubject {
  teamName: string;
  /** Stable SDK session identity, never the member display name. */
  sessionId: string;
}

export interface CreatedSpecBindingObserverDependencies {
  teamMetaStore: Pick<TeamMetaStore, 'updateSpecScope'>;
  configReader: Pick<TeamConfigReader, 'updateSpecScope'>;
}

interface PendingCreation {
  spec: string;
  project?: string;
  requestId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Decode only a complete MCP JSON result, never assistant text or a prose substring. */
function envelope(content: unknown): Record<string, unknown> | null {
  if (Array.isArray(content)) {
    if (content.length !== 1 || !record(content[0]) || content[0].type !== 'text') return null;
    content = content[0].text;
  }
  if (typeof content !== 'string') return null;
  try {
    const value: unknown = JSON.parse(content);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

function confirmedBinding(pending: PendingCreation, content: unknown): TeamSpecBinding | null {
  const result = envelope(content);
  if (!result || result.ok !== true || result.error != null || !record(result.data)) return null;
  const data = result.data;
  if (
    data.schemaVersion !== 'spec-mcp-operations-patch@1' ||
    data.outcome !== 'APPLIED' ||
    data.dryRun !== false ||
    data.error != null ||
    !record(data.receipt)
  )
    return null;
  const receipt = data.receipt;
  if (
    receipt.schemaVersion !== 'spec-mcp-operations-receipt@1' ||
    receipt.outcome !== 'APPLIED' ||
    typeof data.requestId !== 'string' ||
    !data.requestId ||
    receipt.requestId !== data.requestId ||
    typeof data.proposalHash !== 'string' ||
    !data.proposalHash ||
    receipt.proposalHash !== data.proposalHash ||
    (pending.requestId !== undefined && pending.requestId !== data.requestId) ||
    !Array.isArray(receipt.changedDocuments) ||
    !receipt.changedDocuments.some(
      (document) => record(document) && document.path === `.specs/${pending.spec}/SPEC.md`
    )
  )
    return null;
  if (!record(result.provenance) || typeof result.provenance.project !== 'string') return null;
  const project = result.provenance.project;
  if (pending.project !== undefined && pending.project !== project) return null;
  try {
    return validateSpecBinding({ project, spec: pending.spec });
  } catch {
    return null;
  }
}

/** Observe existing SDK tool events; exposes no agent-callable binding capability. */
export class CreatedSpecBindingObserver {
  private readonly pending = new Map<string, Map<string, PendingCreation>>();

  constructor(private readonly deps: CreatedSpecBindingObserverDependencies) {}

  forget(subject: CreatedSpecBindingSubject): void {
    this.pending.delete(JSON.stringify([subject.teamName, subject.sessionId]));
  }

  /** Await before acknowledging ingestion; a persistence failure remains retryable. */
  async observe(subject: CreatedSpecBindingSubject, event: unknown): Promise<void> {
    if (!record(event) || !record(event.message) || !Array.isArray(event.message.content)) return;
    const key = JSON.stringify([subject.teamName, subject.sessionId]);
    for (const block of event.message.content) {
      if (!record(block)) continue;
      if (
        event.type === 'assistant' &&
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        /^(?:mcp__[^\s]+__)?team_spec_spec_patch$/.test(block.name) &&
        record(block.input) &&
        block.input.intent === 'createSpec' &&
        block.input.dryRun === false &&
        typeof block.input.spec === 'string'
      ) {
        let calls = this.pending.get(key);
        if (!calls) {
          calls = new Map();
          this.pending.set(key, calls);
        }
        calls.set(block.id, {
          spec: block.input.spec,
          ...(typeof block.input.project === 'string' ? { project: block.input.project } : {}),
          ...(typeof block.input.requestId === 'string'
            ? { requestId: block.input.requestId }
            : {}),
        });
      }
      if (
        event.type !== 'user' ||
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      )
        continue;
      const calls = this.pending.get(key);
      const pending = calls?.get(block.tool_use_id);
      if (!pending) continue;
      const binding = block.is_error === true ? null : confirmedBinding(pending, block.content);
      if (binding) {
        await this.deps.teamMetaStore.updateSpecScope(subject.teamName, (current) => {
          const scope = resolveTeamSpecScope({ specScope: current }, subject.teamName);
          // Recheck current authority inside the writer lock, not the launch snapshot.
          if (!scope.projects.includes(binding.project))
            throw new Error('Created spec is outside the current team scope');
          if (
            scope.bindings.some(
              (entry) => entry.project === binding.project && entry.spec === binding.spec
            )
          )
            return scope;
          return { ...scope, bindings: [...scope.bindings, binding] };
        });
        // Read the latest canonical scope under the config lock; never project a stale snapshot.
        if (!(await this.deps.configReader.updateSpecScope(subject.teamName))) {
          throw new Error('Cannot project created spec binding to missing team configuration');
        }
      }
      calls!.delete(block.tool_use_id);
      if (calls!.size === 0) this.pending.delete(key);
    }
  }
}
