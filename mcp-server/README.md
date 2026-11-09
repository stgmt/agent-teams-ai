# Desktop-bound MCP

The app-owned child receives `AGENT_TEAMS_BOUND_CONTROL_URL`,
`AGENT_TEAMS_BOUND_CONTEXT_JSON`, and `AGENT_TEAMS_MCP_CLAUDE_DIR` at startup.
The controller captures this binding once, rejects different URL/root overrides,
attaches `x-agent-teams-app-context` to every runtime/work-sync HTTP request, and
rejects redirects. Bound requests never use legacy state-file or environment URL
fallback, and work-sync failures cannot queue filesystem reports. Standalone
stdio keeps its existing lookup behavior for non-task operations only.

`app_get_connection_info` takes no arguments and reads `/api/app/connection`.
`team_create` with `runtimeSelectionVersion: 1` requires `expectedContext` with
the app instance, root fingerprint, and connection generation. It must match the
child binding; the app independently validates it before admitting the mutation.

## Canonical tasks

Every team's canonical tasks live in the spec registry. Task tools require the
desktop-injected binding above; an unbound process fails with
`APP_BINDING_REQUIRED`. Malformed or foreign bindings fail with
`APP_CONTEXT_MISMATCH`. There is no file-backed mode, legacy control-URL
discovery, empty-board fallback, or adoption of existing `~/.claude/tasks` files.
Existing user files are left untouched.

The app can bind a team to multiple registry project/specification pairs.
`team_spec_bindings` lists the authenticated runtime's bindings, and
`team_link_spec` links another pair without accepting a model-selected team id.
For an app-scoped runtime, the normal `omp-spec-kit` `spec_patch` createSpec
call is forwarded through the desktop using the runtime capability. After an
`APPLIED` create, the app links the returned project's specification to that
runtime's team before reporting success. A dry run never links anything.
If the result is `TEAM_SPEC_BINDING_FAILED`, the spec was created but binding
was not confirmed: retry only `team_link_spec` using the returned project and
spec, not createSpec. If creation is `UNKNOWN`, inspect the registry before
retrying either operation. Direct registry `team_specs` calls are refused on
this scoped connection; use the app-scoped team binding tools instead.
Task operations use the selected pair; an ambiguous request must identify it.
Tasks must name existing requirements in that specification. Missing
requirements, binding errors, registry failures, and status conflicts are
returned explicitly.

Reads and mutations use the app's `/api/teams/:teamName/tasks` HTTP endpoints.
Canonical fields are persisted in the registry; execution-only comments,
attachments, review state, intervals, and creation-command provenance remain in
the app's existing `ExecutionTaskStore`, reached through the same HTTP boundary.
Registry-allocated task ids are independent from MCP command UUIDs. Retried
keyed creation sends the same `creationCommand` and payload hash to the app;
reusing a command for different content fails instead of creating another task.
After the app commits its creation receipt, an identical retry returns the
existing task. If the registry write may have succeeded but the app could not
commit that receipt, the outcome is unknown; the app does not safely infer that
another create is warranted.

## HTTP transport admission

Pinned FastMCP 3.35.0 delegates to mcp-proxy 6.4.1. Their default HTTP transport
does not validate Host/Origin and enables wildcard CORS. The tracked dependency
patches expose a request gate before CORS, OPTIONS, and session processing. The
desktop-bound server accepts the exact listener Host and either absent Origin
(native clients) or the exact listener origin; other values receive HTTP 403.
With this gate enabled, CORS headers are disabled. This is browser/rebinding
protection, not authentication of local processes.

Both dependency patches must be installed before building the self-contained
MCP bundle. After updating either dependency, revalidate the patch and run the
real HTTP contract in `test/http.e2e.test.ts` against the rebuilt bundle.
