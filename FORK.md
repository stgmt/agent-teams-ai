# Fork notes

This repository is an unofficial fork of [777genius/agent-teams-ai](https://github.com/777genius/agent-teams-ai) (Agent Teams AI), maintained by [@stgmt](https://github.com/stgmt). It is not affiliated with or endorsed by the upstream author. License: AGPL-3.0, unchanged (see [LICENSE](LICENSE)).

The fork exists because some bugs that stop day-to-day work were not fixed upstream when we hit them. The rule is simple: take everything upstream ships, add a small set of fixes on top, keep that set easy to carry.

## Fork-only changes

Everything that differs from upstream `main`, so a merge never hides a fork change.

### Behaviour

| Change | Where |
|---|---|
| Member **Save + Restart**: waits for the real process exit, process inspection is asynchronous, a failed restart does not roll the roster back, a dead pid is not reported as online, a restarted member gets startup work once | `src/main/services/team/provisioning/TeamProvisioningMemberLifecycle*.ts`, `MemberRuntimeRestartReport.ts`, `TeamProvisioningRuntimeProjectionFactory.ts`, `TeamProvisioningStartupWorkDelivery.ts` |
| **"Team is not running" notice**: a dialog on every owner message to a stopped team and after the team process exits, with **Launch** opening the existing launch dialog | `src/features/team-downtime-notice/`, `src/renderer/components/team/messages/sendOwnerMessage.ts`, `TeamDetailView.tsx` |
| Progress of **HTTP-launched** runs reaches the window (so the notice also covers them) | `publishProvisioningProgress` in the provisioning service, `bindTeamHttpHandlerApis` |
| **Startup work after confirmation**: a native teammate's task queue is not put into the startup context (`deferTaskQueue`); the work arrives as messages once the launch is confirmed | `agent-teams-controller/src/internal/{taskBoard,tasks,deferredTaskQueue,startupWork,memberStatus,messageStore}.js` |
| Every launch attempt gets its own copy of the bootstrap check (`allowRepeatedDelivery`) | `agent-teams-controller/src/internal/messageStore.js`, `TeamProvisioningMessagePersistence.ts` |
| **File lock on Windows**: a path another process is still deleting answers `EPERM`/`EACCES`/`EBUSY`; while acquiring, that now means "try again" (bounded), not an error. Before, 8 processes writing one inbox lost about half of their acquisitions, and an inbox row could be lost with `EPERM open/rename/rmdir/scandir` | `agent-teams-controller/src/internal/fileLock.js`, `src/main/services/team/fileLock.ts` |
| **Inbox named like nothing a member can be called** (an agent addressed a message to `--------------------------`): the name no longer becomes a roster member, blocks **Launch team**, or gets a work-sync directory; the messages stay readable | `TeamInboxReader.listInboxNames`, `MemberWorkSyncTeamChangeRouter` |
| **Work-sync report journal on Windows**: proving an already stored report flushed it through a read-only handle, which Windows refuses (`EPERM` on fsync), so every repeated report ended as `commit_unknown` and the status mutation was `unavailable`; it now flushes through the same read-write handle as every other durable write | `JsonMemberWorkSyncReportJournal` (uses `syncFile` from `durableFileSync`) |
| **Chat focus mode**: a toggle in the messages panel that shows only your requests and the replies to them (a lead reply is linked to the message it answers, `replyToMessageIds`); on a busy team older pages load by themselves (up to 10) until a request of yours is visible | `src/features/chat-focus-mode/`, `src/shared/utils/userReplyLink.ts`, `src/renderer/store/team/teamMessagesHistoryCarryOver.ts`, `agent-teams-controller/src/internal/messageStore.js`, `docs/research/chat-focus-mode-spec.md` |

Tests for these changes sit next to the code (`__tests__/`) and in `test/main/...`. The `test/live/*.live.test.ts` suites drive the real app with real models in a sandbox team; they are billed and are not part of `pnpm test` (run them with `pnpm test:live`).

### Fork identity

| What | Change |
|---|---|
| `package.json` | version `<upstream base>-tokenplan.N`; `build.publish.owner` = `stgmt`, so the in-app updater reads this fork's Releases |
| `src/main/services/infrastructure/updaterReleaseMetadata.ts` | `REPO_OWNER` = `stgmt` (release notes and update manifests come from this fork); the two updater tests follow |
| `UpdateDialog.tsx`, `bugReportUtils.ts` | the "release page" and "report a bug" links point to this fork |
| `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/config.yml` | no upstream CLA checkbox, no upstream Discord link |
| `README.md`, `FORK.md` | fork notice, installation |

Everything else, including upstream's CI workflows under `.github/workflows/`, is left as upstream has it. GitHub Actions are not enabled on this fork.

## Syncing with upstream

```bash
git remote add upstream https://github.com/777genius/agent-teams-ai.git   # once
git fetch upstream
git merge upstream/main
```

Then:

1. Resolve conflicts. The files in the table above are where they happen (the provisioning member lifecycle, task and message stores of `agent-teams-controller`, `TeamDetailView.tsx`).
2. `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the size guard `node scripts/ci/check-source-file-size.mjs` (legacy file caps in `scripts/ci/source-file-size-baseline.json` may only go down; move code out rather than raising a cap).
3. Bump the version to the new upstream base plus `-tokenplan.1`, build, release.

If upstream ships a fix for something listed above, drop the fork's version of it in the same merge and remove the row from this file.

## Building the Windows installer

Node 24.15+ or 26, pnpm 11.22. From a clean checkout of the commit you release:

```bash
pnpm install
BUILD_ID=<12-char-sha>-tokenplan.<N> pnpm dist:win
```

Notes from earlier builds: set `BUILD_ID` so the Sentry artifact folder of an earlier build does not break the build; run `git checkout -- resources/pricing.json` after `pnpm build` (the build rewrites it); builds are made without Sentry and PostHog keys, so the installer sends no telemetry.

The installer, its `.blockmap` and `latest.yml` come out in `release/`. Publish all three as one GitHub Release tagged `v<version>`: the updater needs `latest.yml` and the installer from the same release.

## Known limits

- Windows x64 only. macOS and Linux builds are not produced.
- The installer is not code-signed (SmartScreen warns).
- Text of the "team is not running" dialog is English in all locales.
- `/stop` over HTTP does not refresh the dialog immediately.
- Release `v2.18.0-tokenplan.1` (runtime 0.0.138) cannot start a team on a Windows profile where `%LOCALAPPDATA%\claude-multimodel-nodejs\Data` was created by an older runtime: the runtime refuses it with `execution_owner_not_private:private_acl_foreign_allow`. Runtime 0.0.139 removed that check; use `v2.18.2-tokenplan.1` or later.

## Upstream

Issues and pull requests that are not about the changes above belong to upstream: <https://github.com/777genius/agent-teams-ai>. Thanks to its author and contributors for the app itself.
