import { randomUUID } from 'node:crypto';

import { getDurablePathIdentity, isSameDurablePathIdentity } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { getAdmittedTeamPublicationAuthority } from './provisioning/TeamProvisioningRequestAdmissionContext';
import { atomicWriteAsync } from './atomicWrite';
import {
  resolveLaunchPublicationRoot,
  withLaunchPublicationFileLock,
} from './launchPublicationLock';
import {
  captureOpenCodeTranscriptBindings,
  getTeamLaunchFreshnessPath,
  readTeamLaunchFreshness,
  readTeamLaunchFreshnessSync,
} from './TeamLaunchFreshness';
import {
  createPersistedLaunchSnapshot,
  normalizePersistedLaunchSnapshot,
} from './TeamLaunchStateEvaluator';
import {
  createPersistedLaunchSummaryProjection,
  TEAM_LAUNCH_SUMMARY_FILE,
} from './TeamLaunchSummaryProjection';

import type { OpenCodeTranscriptBindingIdentity, TeamLaunchFreshness } from './TeamLaunchFreshness';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

const logger = createLogger('Service:TeamLaunchStateStore');
const TEAM_LAUNCH_STATE_FILE = 'launch-state.json';
const MAX_LAUNCH_STATE_BYTES = 256 * 1024;
const stopIntentByTeam = new Map<string, number>();
const publicationQueueByTeam = new Map<string, Promise<unknown>>();

function publicationScopeKey(teamName: string, teamsRoot?: string): string {
  let physicalRoot = resolveLaunchPublicationRoot(teamsRoot);
  if (process.platform === 'win32') physicalRoot = physicalRoot.toLowerCase();
  return JSON.stringify([physicalRoot, teamName.normalize('NFC').toLowerCase()]);
}

/** Capture before any caller queue/await; a later Stop revokes this request. */
export function captureTeamLaunchPublicationAuthority(
  teamName: string,
  teamsRoot?: string
): () => boolean {
  const key = publicationScopeKey(teamName, teamsRoot);
  const intent = stopIntentByTeam.get(key);
  const admitted = getAdmittedTeamPublicationAuthority(teamName);
  return () =>
    admitted?.() !== false &&
    publicationScopeKey(teamName, teamsRoot) === key &&
    stopIntentByTeam.get(key) === intent;
}

/** A native owner may clean up its own publication only until a Stop is admitted. */
export function captureTeamStopIntent(teamName: string, teamsRoot?: string): () => boolean {
  const key = publicationScopeKey(teamName, teamsRoot);
  const intent = stopIntentByTeam.get(key);
  return () =>
    publicationScopeKey(teamName, teamsRoot) === key && stopIntentByTeam.get(key) === intent;
}

export interface TeamLaunchStopAuthority {
  teamName: string;
  stopIntent: number;
  scopeKey?: string;
  freshness: TeamLaunchFreshness | null;
  transcriptBindings?: OpenCodeTranscriptBindingIdentity[];
}

function matchesStopAuthority(
  teamName: string,
  authority: TeamLaunchStopAuthority,
  freshness: TeamLaunchFreshness | null,
  teamsRoot?: string
): boolean {
  const key = publicationScopeKey(teamName, teamsRoot);
  return (
    authority.teamName === teamName &&
    (authority.scopeKey === undefined || authority.scopeKey === key) &&
    authority.stopIntent === stopIntentByTeam.get(key) &&
    JSON.stringify(freshness) === JSON.stringify(authority.freshness)
  );
}

export function getTeamLaunchStatePath(teamName: string, teamsRoot = getTeamsBasePath()): string {
  return path.join(teamsRoot, teamName, TEAM_LAUNCH_STATE_FILE);
}

export function getTeamLaunchSummaryPath(teamName: string, teamsRoot = getTeamsBasePath()): string {
  return path.join(teamsRoot, teamName, TEAM_LAUNCH_SUMMARY_FILE);
}

/**
 * Marker written when a team is stopped. While it exists, launch-state
 * reconciliation must not re-derive a half-launched snapshot from leftover
 * metadata: a stopped mixed OpenCode team used to come back as "Last launch
 * failed partway - 2/3 teammates did not join", with members reported as
 * never spawned, because the lane metadata of the run that was just stopped
 * was still on disk. An explicitly authorized new run removes it.
 */
export const TEAM_LAUNCH_STOPPED_MARKER_FILE = 'launch-stopped.json';

export function getTeamLaunchStoppedMarkerPath(
  teamName: string,
  teamsRoot = getTeamsBasePath()
): string {
  return path.join(teamsRoot, teamName, TEAM_LAUNCH_STOPPED_MARKER_FILE);
}

/**
 * The recorded runtime pids of the team's persisted launch members. The stop
 * confirmation path needs this synchronously and without shelling out: an
 * absent or unreadable snapshot answers with no pids, and the caller keeps the
 * process table as its discovery channel for unrecorded processes.
 */
export function readPersistedLaunchRuntimePidsSync(teamName: string): number[] {
  const targetPath = getTeamLaunchStatePath(teamName);
  let parsed: unknown;
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
      return [];
    }
    parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return [];
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (
      record.version === 2 &&
      (typeof record.teamName !== 'string' || record.teamName.trim() !== teamName)
    ) {
      return [];
    }
  }
  const snapshot = normalizePersistedLaunchSnapshot(teamName, parsed);
  if (!snapshot) {
    return [];
  }
  const pids = new Set<number>();
  for (const member of Object.values(snapshot.members)) {
    const pid = member?.runtimePid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
      pids.add(Math.trunc(pid));
    }
  }
  return [...pids];
}

export interface TeamLaunchStatePublicationOptions {
  /**
   * True when the write republishes launch truth that already existed instead
   * of starting a launch: the rollback of a stale write restoring what it
   * overwrote, or a recovery re-deriving the run that was just stopped. Only a
   * launch may lift a stop, so a stop that landed meanwhile stays final over
   * such a write - it is not published, and it never removes the marker.
   */
  republishesExistingLaunch?: boolean;
  runId?: string;
  isAuthorized?: () => boolean;
  authorizesNewRun?: () => boolean;
}

async function removeStoppedMarkerIfPresent(teamName: string, teamsRoot?: string): Promise<void> {
  const markerPath = getTeamLaunchStoppedMarkerPath(teamName, teamsRoot);
  if (!fs.existsSync(markerPath)) return;
  await fs.promises.rm(markerPath, { force: true });
}

async function isMissingTeamDirectoryWriteRace(
  targetPath: string,
  error: unknown
): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'EINVAL') {
    return false;
  }
  const targetDir = path.dirname(targetPath);
  try {
    await fs.promises.access(targetDir);
    return false;
  } catch (accessError) {
    return (accessError as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Reports the revocation failures the caller has to see; silent when there are none. */
function throwPublicationRevocationFailure(
  teamName: string,
  results: PromiseSettledResult<void>[]
): void {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, `[${teamName}] Failed to clear launch-state publication`);
  }
}

function enqueuePublication<T>(
  teamName: string,
  operation: () => Promise<T>,
  teamsRoot?: string
): Promise<T> {
  const key = publicationScopeKey(teamName, teamsRoot);
  const previous = publicationQueueByTeam.get(key);
  const queued = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => withLaunchPublicationFileLock(teamName, operation, teamsRoot));
  publicationQueueByTeam.set(key, queued);
  return queued.finally(() => {
    if (publicationQueueByTeam.get(key) === queued) {
      publicationQueueByTeam.delete(key);
    }
  });
}

/**
 * Runs `operation` in this team's launch-state publication queue - the same one
 * `write` and `markStopped` use. A caller that publishes or withdraws these
 * files from outside the store needs it, because a stop is not one instant:
 * `markStopped` removes the publication files first and writes its marker
 * afterwards, and only the queue makes those two steps indivisible from the
 * outside. Checking the marker without holding the queue reads a stop that has
 * begun as a stop that never happened.
 */
export function withTeamLaunchStatePublicationLock<T>(
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  return enqueuePublication(teamName, operation);
}

/**
 * What a launch-state read found. `absent` is an answer - this team published
 * no launch state - while `unreadable` is the lack of one: something is on
 * disk that the store could not turn into a snapshot, so nothing may be
 * concluded about what the team has running.
 */
export type TeamLaunchStateReadResult =
  | { status: 'snapshot'; snapshot: PersistedTeamLaunchSnapshot }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string };

function describeReadFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TeamLaunchStateStore {
  constructor(private readonly teamsRoot?: string) {}
  /**
   * The launch snapshot, or `null` when there is none to be had. It cannot say
   * why: a team that never launched and a launch state this app could not read
   * both answer `null`. Callers that draw a conclusion from the absence of
   * recorded state - "nothing is running" - need `readResult` instead.
   */
  async read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null> {
    const result = await this.readResult(teamName);
    return result.status === 'snapshot' ? result.snapshot : null;
  }

  /**
   * The same read, keeping "this team has no launch state" apart from "the
   * launch state could not be read". Only the first is evidence about the team;
   * the second is the absence of evidence, and a caller that counts it as an
   * empty snapshot reports a probe that answered nothing as a definite zero.
   */
  async readResult(teamName: string): Promise<TeamLaunchStateReadResult> {
    let freshness: TeamLaunchFreshness | null;
    try {
      freshness = await readTeamLaunchFreshness(teamName, this.teamsRoot);
      if (freshness?.kind === 'stop' && freshness.native) {
        return { status: 'unreadable', reason: 'native launch status is not persisted' };
      }
    } catch (error) {
      return { status: 'unreadable', reason: describeReadFailure(error) };
    }
    const targetPath = getTeamLaunchStatePath(teamName, this.teamsRoot);
    let raw: string;
    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile()) {
        return { status: 'unreadable', reason: 'launch state path is not a file' };
      }
      if (stat.size > MAX_LAUNCH_STATE_BYTES) {
        return { status: 'unreadable', reason: `launch state exceeds ${MAX_LAUNCH_STATE_BYTES}B` };
      }
      raw = await fs.promises.readFile(targetPath, 'utf8');
    } catch (error) {
      // Only a missing file is an answer; every other failure leaves the
      // question open.
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? freshness?.native
          ? { status: 'unreadable', reason: 'native launch status is not persisted' }
          : { status: 'absent' }
        : { status: 'unreadable', reason: describeReadFailure(error) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      return { status: 'unreadable', reason: describeReadFailure(error) };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (
        record.version === 2 &&
        (typeof record.teamName !== 'string' || record.teamName.trim() !== teamName)
      ) {
        return { status: 'unreadable', reason: 'launch state names a different team' };
      }
    }
    const snapshot = normalizePersistedLaunchSnapshot(teamName, parsed);
    if (
      snapshot &&
      parsed &&
      typeof parsed === 'object' &&
      'publicationRunId' in parsed &&
      typeof parsed.publicationRunId === 'string'
    )
      snapshot.publicationRunId = parsed.publicationRunId;
    try {
      const current = await readTeamLaunchFreshness(teamName, this.teamsRoot);
      if (JSON.stringify(current) !== JSON.stringify(freshness))
        return { status: 'unreadable', reason: 'launch authority changed while reading' };
      if (
        freshness?.kind === 'launch' &&
        freshness.native &&
        snapshot?.publicationRunId !== freshness.runId
      )
        return { status: 'unreadable', reason: 'native launch status is not persisted' };
    } catch (error) {
      return { status: 'unreadable', reason: describeReadFailure(error) };
    }
    return snapshot
      ? { status: 'snapshot', snapshot }
      : { status: 'unreadable', reason: 'launch state did not describe a launch' };
  }

  async beginLaunch(
    teamName: string,
    runId: string,
    expectedMembers: string[],
    isAuthorized: () => boolean
  ): Promise<boolean> {
    if (!runId.trim()) throw new Error('Launch publication requires a run identity');
    const publicationIsCurrent = captureTeamLaunchPublicationAuthority(teamName, this.teamsRoot);
    return enqueuePublication(
      teamName,
      () =>
        this.writeNow(
          teamName,
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers,
            launchPhase: 'active',
            members: {},
          }),
          {
            runId,
            isAuthorized: () => isAuthorized() && publicationIsCurrent(),
          },
          true
        ),
      this.teamsRoot
    );
  }

  /** Native lifecycle owns its live status; publish ownership without inventing a status snapshot. */
  async beginNativeLaunch(
    teamName: string,
    runId: string,
    isAuthorized: () => boolean
  ): Promise<boolean> {
    if (!runId.trim()) throw new Error('Launch publication requires a run identity');
    const publicationIsCurrent = captureTeamLaunchPublicationAuthority(teamName, this.teamsRoot);
    const authorized = (): boolean => isAuthorized() && publicationIsCurrent();
    return enqueuePublication(
      teamName,
      async () => {
        if (!authorized()) return false;
        const directory = path.dirname(getTeamLaunchStatePath(teamName, this.teamsRoot));
        const initial = await fs.promises.stat(directory).catch(() => null);
        if (!initial) return false;
        const beforeCommit = async (): Promise<void> => {
          const current = await fs.promises.stat(directory).catch(() => null);
          if (
            !authorized() ||
            !current ||
            !isSameDurablePathIdentity(
              getDurablePathIdentity(current),
              getDurablePathIdentity(initial)
            )
          )
            throw new Error('Native launch publication authorization changed');
        };
        // Native runtime owns its live status. Preserve prior snapshots and fence
        // their readers with this single atomically published authority record.
        await atomicWriteAsync(
          getTeamLaunchFreshnessPath(teamName, this.teamsRoot),
          JSON.stringify({ version: 1, teamName, kind: 'launch', runId, native: true }),
          { beforeCommit, durability: 'strict', syncDirectory: true }
        );
        return authorized();
      },
      this.teamsRoot
    );
  }

  async write(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: TeamLaunchStatePublicationOptions
  ): Promise<boolean> {
    const publicationIsCurrent = captureTeamLaunchPublicationAuthority(teamName, this.teamsRoot);
    return enqueuePublication(
      teamName,
      () =>
        this.writeNow(teamName, snapshot, {
          ...options,
          runId: options?.runId ?? snapshot.publicationRunId,
          isAuthorized: () => options?.isAuthorized?.() !== false && publicationIsCurrent(),
        }),
      this.teamsRoot
    );
  }

  private async writeNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options: TeamLaunchStatePublicationOptions,
    beginsLaunch = false
  ): Promise<boolean> {
    if (options.isAuthorized?.() === false) return false;
    const freshness = await readTeamLaunchFreshness(teamName, this.teamsRoot);
    if (options.isAuthorized?.() === false) return false;
    // Existing native launch flows publish their first active snapshot through the
    // boundary. Only their current, explicitly checked new run can begin here.
    beginsLaunch ||=
      snapshot.launchPhase === 'active' &&
      options.republishesExistingLaunch !== true &&
      !!options.runId &&
      options.authorizesNewRun?.() === true &&
      (freshness === null ||
        (freshness.kind === 'stop' ? freshness.stoppedRunId : freshness.runId) !== options.runId);
    if (!beginsLaunch && (await this.isStopped(teamName))) return false;
    if (!beginsLaunch && freshness?.kind === 'launch' && options.runId !== freshness.runId)
      return false;
    const statePath = getTeamLaunchStatePath(teamName, this.teamsRoot);
    const directory = path.dirname(statePath);
    const directoryIdentity = await fs.promises.stat(directory).catch(() => null);
    if (!directoryIdentity) return false;
    const directoryIsCurrent = async (): Promise<boolean> => {
      const current = await fs.promises.stat(directory).catch(() => null);
      return (
        current !== null &&
        isSameDurablePathIdentity(
          getDurablePathIdentity(current),
          getDurablePathIdentity(directoryIdentity)
        )
      );
    };
    const beforeCommit = async (): Promise<void> => {
      if (options.isAuthorized?.() === false || !(await directoryIsCurrent())) {
        throw new Error('Launch publication authorization changed');
      }
    };
    const summaryPath = getTeamLaunchSummaryPath(teamName, this.teamsRoot);
    const paths = beginsLaunch
      ? [
          statePath,
          summaryPath,
          getTeamLaunchFreshnessPath(teamName, this.teamsRoot),
          getTeamLaunchStoppedMarkerPath(teamName, this.teamsRoot),
        ]
      : [statePath, summaryPath];
    const previous = await Promise.all(
      paths.map(async (file) => {
        try {
          return await fs.promises.readFile(file, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      })
    );
    const rollback = async (): Promise<void> => {
      const beforeRollbackCommit = async (): Promise<void> => {
        if (!(await directoryIsCurrent())) throw new Error('Launch rollback directory changed');
      };
      for (let i = 0; i < paths.length; i++) {
        if (!(await directoryIsCurrent())) return;
        if (previous[i] === null) await fs.promises.rm(paths[i], { force: true });
        else await atomicWriteAsync(paths[i], previous[i]!, { beforeCommit: beforeRollbackCommit });
      }
    };
    if (options.isAuthorized?.() === false) return false;
    try {
      await atomicWriteAsync(
        statePath,
        `${JSON.stringify({ ...snapshot, publicationRunId: options.runId }, null, 2)}\n`,
        { beforeCommit }
      );
      await atomicWriteAsync(
        summaryPath,
        `${JSON.stringify({ ...createPersistedLaunchSummaryProjection(snapshot), publicationRunId: options.runId }, null, 2)}\n`,
        { beforeCommit }
      );
      if (beginsLaunch) {
        await atomicWriteAsync(
          getTeamLaunchFreshnessPath(teamName, this.teamsRoot),
          JSON.stringify({
            version: 1,
            teamName,
            kind: 'launch',
            runId: options.runId,
          }),
          { beforeCommit, durability: 'strict', syncDirectory: true }
        );
        if (options.isAuthorized?.() !== false)
          await removeStoppedMarkerIfPresent(teamName, this.teamsRoot);
      }
      if (options.isAuthorized?.() === false) {
        await rollback();
        return false;
      }
      return true;
    } catch (error) {
      if (await isMissingTeamDirectoryWriteRace(statePath, error)) return false;
      await rollback();
      if (options.isAuthorized?.() === false || !(await directoryIsCurrent())) return false;
      logger.warn(
        `[${teamName}] Failed to persist launch-state: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /** Admit before runtime/cleanup awaits, revoking pending earlier publications. */
  async beginStop(
    teamName: string,
    expectedRunId?: string | null
  ): Promise<TeamLaunchStopAuthority> {
    const scopeKey = publicationScopeKey(teamName, this.teamsRoot);
    const observed = readTeamLaunchFreshnessSync(teamName, this.teamsRoot);
    if (
      expectedRunId !== undefined &&
      (expectedRunId === null ||
        (observed?.kind === 'launch' ? observed.runId : observed?.stoppedRunId) !== expectedRunId)
    ) {
      throw new Error('Stop publication authority was superseded by a different run');
    }
    const stopIntent = (stopIntentByTeam.get(scopeKey) ?? 0) + 1;
    stopIntentByTeam.set(scopeKey, stopIntent);
    return await enqueuePublication(
      teamName,
      async () => {
        if (publicationScopeKey(teamName, this.teamsRoot) !== scopeKey) {
          throw new Error('Stop publication root was superseded');
        }
        const freshness = await readTeamLaunchFreshness(teamName, this.teamsRoot);
        if (
          JSON.stringify(freshness) !== JSON.stringify(observed) ||
          (expectedRunId !== undefined &&
            (expectedRunId === null ||
              (freshness?.kind === 'launch' ? freshness.runId : freshness?.stoppedRunId) !==
                expectedRunId))
        ) {
          throw new Error('Stop publication authority was superseded by a different run');
        }
        const publication = freshness?.kind === 'launch' ? await this.readResult(teamName) : null;
        const transcriptBindings =
          freshness?.kind === 'stop'
            ? freshness.transcriptBindings
            : publication?.status === 'snapshot' &&
                publication.snapshot.publicationRunId === freshness?.runId
              ? captureOpenCodeTranscriptBindings(publication.snapshot)
              : [];
        return { teamName, stopIntent, scopeKey, freshness, transcriptBindings };
      },
      this.teamsRoot
    );
  }

  /** Serialize cleanup with updated launch publishers and reject stale stop ownership. */
  async withStopAuthority<T>(
    teamName: string,
    authority: TeamLaunchStopAuthority,
    operation: () => Promise<T>
  ): Promise<{ current: false } | { current: true; value: T }> {
    return await enqueuePublication(
      teamName,
      async () => {
        const freshness = await readTeamLaunchFreshness(teamName, this.teamsRoot);
        if (!matchesStopAuthority(teamName, authority, freshness, this.teamsRoot))
          return { current: false };
        return { current: true, value: await operation() };
      },
      this.teamsRoot
    );
  }

  /** A cleanup tail retains its admission; it cannot stop a successor publication. */
  async markStopped(teamName: string, authority?: TeamLaunchStopAuthority): Promise<boolean> {
    const scopeKey = publicationScopeKey(teamName, this.teamsRoot);
    const stopIntent = authority?.stopIntent ?? (stopIntentByTeam.get(scopeKey) ?? 0) + 1;
    if (!authority) stopIntentByTeam.set(scopeKey, stopIntent);
    return await enqueuePublication(
      teamName,
      async () => {
        const previous = await readTeamLaunchFreshness(teamName, this.teamsRoot);
        const admitted: TeamLaunchStopAuthority = authority ?? {
          teamName,
          stopIntent,
          scopeKey,
          freshness: previous,
        };
        if (!matchesStopAuthority(teamName, admitted, previous, this.teamsRoot)) return false;
        return this.writeStopped(teamName, previous, admitted.transcriptBindings);
      },
      this.teamsRoot
    );
  }

  /** Retire only this native run; an admitted Stop or successor retains ownership. */
  async retireNativeLaunch(
    teamName: string,
    runId: string,
    isAuthorized: () => boolean
  ): Promise<boolean> {
    return await enqueuePublication(
      teamName,
      async () => {
        if (!isAuthorized()) return false;
        const freshness = await readTeamLaunchFreshness(teamName, this.teamsRoot);
        if (!isAuthorized() || freshness?.kind !== 'launch' || freshness.runId !== runId)
          return false;
        return this.writeStopped(teamName, freshness, undefined, isAuthorized);
      },
      this.teamsRoot
    );
  }

  private async writeStopped(
    teamName: string,
    previous: TeamLaunchFreshness | null,
    transcriptBindings?: OpenCodeTranscriptBindingIdentity[],
    isAuthorized?: () => boolean
  ): Promise<boolean> {
    if (isAuthorized?.() === false) return false;
    // Native ownership is separate from the legacy status files. They are
    // historical evidence and must not be partially deleted on stop failure.
    const revocations = previous?.native
      ? []
      : await Promise.allSettled([
          fs.promises.rm(getTeamLaunchStatePath(teamName, this.teamsRoot), { force: true }),
          fs.promises.rm(getTeamLaunchSummaryPath(teamName, this.teamsRoot), { force: true }),
        ]);
    const markerPath = getTeamLaunchStoppedMarkerPath(teamName, this.teamsRoot);
    const stopId = randomUUID();
    const beforeCommit = async (): Promise<void> => {
      if (isAuthorized?.() === false) throw new Error('Native launch retirement was superseded');
    };
    try {
      await atomicWriteAsync(
        getTeamLaunchFreshnessPath(teamName, this.teamsRoot),
        JSON.stringify({
          version: 1,
          teamName,
          kind: 'stop',
          stopId,
          ...(previous?.native ? { native: true } : {}),
          stoppedRunId: previous?.kind === 'launch' ? previous.runId : previous?.stoppedRunId,
          transcriptBindings:
            previous?.kind === 'stop' ? previous.transcriptBindings : transcriptBindings,
        }),
        { durability: 'strict', syncDirectory: true, beforeCommit }
      );
      await atomicWriteAsync(
        markerPath,
        `${JSON.stringify({ version: 1, teamName, stopId, stoppedAt: new Date().toISOString() }, null, 2)}\n`,
        { beforeCommit }
      );
    } catch (error) {
      if (await isMissingTeamDirectoryWriteRace(markerPath, error)) return false;
      throw error;
    }
    throwPublicationRevocationFailure(teamName, revocations);
    return true;
  }

  async isStopped(teamName: string): Promise<boolean> {
    const freshness = await readTeamLaunchFreshness(teamName, this.teamsRoot);
    if (freshness?.kind === 'launch' && freshness.native) return false;
    return (
      fs.existsSync(getTeamLaunchStoppedMarkerPath(teamName, this.teamsRoot)) ||
      freshness?.kind === 'stop'
    );
  }

  /**
   * Removes the launch publication only. The stop marker survives a clear:
   * stop flows and stale-write cleanups clear the publication after the team
   * was marked stopped, and only a real launch (an 'active' write) may lift
   * the marker again. Recovery clears additionally compare the persisted run and
   * live freshness inside the publication queue before deleting either file.
   */
  async clear(
    teamName: string,
    isAuthorized?: () => boolean,
    persistedRunId?: string
  ): Promise<void> {
    await enqueuePublication(
      teamName,
      async () => {
        if (isAuthorized?.() === false) return;
        if (persistedRunId !== undefined) {
          const current = await this.read(teamName);
          const freshness = await readTeamLaunchFreshness(teamName, this.teamsRoot);
          if (
            current?.publicationRunId !== persistedRunId ||
            (freshness !== null &&
              (freshness.kind !== 'launch' || freshness.runId !== persistedRunId)) ||
            isAuthorized?.() === false
          )
            return;
        }
        throwPublicationRevocationFailure(
          teamName,
          await Promise.allSettled([
            fs.promises.rm(getTeamLaunchStatePath(teamName, this.teamsRoot), { force: true }),
            fs.promises.rm(getTeamLaunchSummaryPath(teamName, this.teamsRoot), { force: true }),
          ])
        );
      },
      this.teamsRoot
    );
  }
}
