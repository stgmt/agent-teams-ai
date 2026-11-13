# Lead reporting (D-448)

Main-process slice following [the feature standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md). It owns human report operations, inspections, evidence admission and confirmed inbox delivery. It does not own member processes or invent a second lifecycle projection.

## Public surfaces

- `contracts/index.ts`: report scope, source stamps, member inspections, evidence, drafts and delivery identities.
- `main/index.ts`: `createNodeLeadReporting`, `registerLeadReportingHttp`, request/context instructions and focused test factories.
- `main/composition/createNodeLeadReporting.ts`: receives the existing lifecycle authority, snapshot and task-ledger ports. Returns `reports`, `acceptHumanRequest` and credential-bound `reply`.
- `core/application/LeadReporting.ts`: operation/receipt ownership, exact roster coverage, source revalidation, delivery idempotency and last-successful-report baseline.
- `main/application/LeadRequestReporting.ts`: reserves a genuine human request before asynchronous reads; separates its ordinary answer from an evidence-required report. A successor request is queued by its caller, not silently substituted.
- `main/adapters/output/NodeLeadReportSources.ts`: explicit selected profile, a controller board projection over the canonical team tasks the app supplies and the lifecycle's task-change reader. The app owns the registry read; the controller never calls the app's own control API from inside it, which would park the thread that serves that request. Task rows have individual revisions, so unrelated board changes do not invalidate a narrow report.
- `main/adapters/output/NodeLeadReportDelivery.ts`: the sole app-owned inbox append for these replies; exact request closure happens only after confirmed append.

`lead_briefing` returns `{kind: 'report', inspection}` for an admitted human report request, or `{kind: 'management', inspection}` for read-only management facts. Management facts reuse the same collector and carry the exact run, but no report operation or publication receipt; they do not create a human request or authorize unsolicited delivery. A report admitted during a management read invalidates that read. `message_send` submits either a structured report draft or an ordinary answer with the exact `requestMessageId`. An ordinary answer is rejected for an admitted report request. Agent-facing controller errors never continue to a filesystem append. Trusted app writes are a distinct boundary, not an error-recovery path.

## Integration requirements

The production composition must:

1. Supply the existing lifecycle credential resolver, context-fenced queries, the canonical team-task read and the exact task-ledger reader.
2. Call `acceptHumanRequest` only for the actual persisted human turn, preserving its ID and action mode. Coordinate turn queue ownership before sending the instructions through stdin.
3. Register reporting HTTP behind existing bound Host/Origin/context admission.
4. Register the persisted request/tracker before `acceptHumanRequest`: a failed initial roster read can deliver its source limitation during admission. Close the exact pending human request in `delivered`; never turn an acknowledgement into the final report.
5. Use `buildLeadReportContextRefresh` for service-origin context, without admitting it as a new human request.
6. Prevent a lead's native user-message writer from bypassing the app-owned publisher before it writes.

The existing `TeamProvisioningIdlePromptInjection.ts` and launch/hydration prompt endings now consume the shared evidence/service instructions; their synthetic stdin payload has `isMeta: true` and coordinator provenance. The app-owned reporting composition, human-turn admission, successful-delivery closure and native-writer exclusion are **not connected to production yet**. The installed app and real team have not been changed. Do not present the isolated integration tests as production acceptance.

## Evidence and current limits

Whole-team scope includes every canonical subordinate, including stopped members and members with no tasks. Process readiness, recorded board status, a member's claimed result and independently captured edits are different facts. The current result adapter verifies exact captured edits only; it does not independently establish tests, Git merges or completed work.

Draft validation checks coverage and evidence provenance, not the truth of arbitrary natural-language sentences. `reportRequestIntent.ts` recognizes a bounded set of request forms; it is not semantic intent classification and cannot establish coverage of arbitrary phrasing. Ordinary conversation does not read the roster. Operation/baseline state is currently in memory; a confirmed append with pending request closure cannot be evicted or replaced by a successor request. A report admitted during management collection invalidates that read even if its delivery completes before collection finishes. Inspection age includes all asynchronous source reads rather than starting after they finish. HTTP diagnostics and lifecycle failure strings exposed to the model use the shared bounded secret-redaction helper; source lifecycle snapshots are not mutated. Exact edit evidence requires differing captured contents; missing text or a no-op is not a verified edit, while a captured deletion remains visible. A task-ledger read failure preserves readable member claims and other task results, with a task/member-bound redacted diagnostic; unrelated member failures do not invalidate an explicitly narrow report. Whole-source lifecycle/board failures from the Node adapter carry a source-specific bounded, redacted cause into the inspection and delivered limitation; an arbitrary untyped port failure remains unavailable without exposing raw exception text. A failed initial roster read during human-request admission produces a bounded app-owned source-limitation reply for that exact request, not a made-up roster or progress report. The failure text is redacted, retained for idempotent retry and closes the request only after confirmed append/notification; recovery during a retry cannot turn it into a second answer. Report operations allow two inspection attempts and four publication attempts. Exhaustion delivers one app-owned limitation for the original request; it is not a verified report and d... (line truncated to 2000 chars)

## Tests

`test/features/lead-reporting/` covers core invariants, asynchronous request ownership, retry/closure, roster races, relevant source changes, narrow rendering and a real isolated Fastify/controller/filesystem path with existing Host/Origin/context guards. Temporary profiles are removed with retries. No model, live team, real project or second Electron instance is launched. MCP tool boundary tests live in `mcp-server/test/leadReportingTools.test.ts`.
