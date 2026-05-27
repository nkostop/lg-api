# Issues - Pending Items

## Pending Items

### P1 - Repositories use local inline types instead of shared types from types/index.ts
- **Files**: `src/modules/assistants/assistants.repository.ts`, `src/modules/threads/threads.repository.ts`, `src/modules/runs/runs.repository.ts`, `src/modules/crons/crons.repository.ts`, `src/modules/store/store.repository.ts`
- **Description**: Each repository defines its own inline interface (e.g., `Assistant`, `Thread`, `Run`, `Cron`, `Item`) with comments saying "will be replaced with the shared type from types/index.ts". The shared types exist in `src/types/index.ts` but are not used by repositories or services. This creates a risk of type drift between the schema-derived types and the inline types.
- **Severity**: Medium
- **Recommendation**: Replace inline interfaces with imports from `src/types/index.ts`.

### P2 - Thread stream endpoint returns 501 instead of proper SSE
- **File**: `src/modules/threads/threads.routes.ts`, line 246
- **Description**: The `GET /threads/:thread_id/stream` endpoint returns a 501 (Not Implemented) with a message that "SSE streaming is handled by the runs module". While the runs module does handle run-based streaming, the LangGraph SDK's `client.threads.stream()` method expects this endpoint to work and return SSE events for the active thread.
- **Severity**: Medium
- **Recommendation**: Implement this endpoint to delegate to the stream manager to join the active run stream for the thread.

### P3 - Crons count endpoint returns `{ count: N }` instead of a plain integer
- **File**: `src/modules/crons/crons.routes.ts`, line 160
- **Description**: The assistants and threads count endpoints return a plain integer, but the crons count endpoint wraps it in `{ count: N }`. This is inconsistent and may cause SDK compatibility issues if the SDK expects a plain integer.
- **Severity**: Low-Medium
- **Recommendation**: Verify the LangGraph SDK expectation and make consistent across all count endpoints.

### P5 - Unused dependency: `better-sse`
- **File**: `package.json`
- **Description**: The `better-sse` package is listed as a dependency but is never imported in any source file. SSE streaming is implemented manually via `reply.raw`.
- **Severity**: Low
- **Recommendation**: Remove from dependencies.

### P6 - `enabled` and `on_run_completed` fields are missing from crons repository's Cron interface
- **File**: `src/modules/crons/crons.repository.ts`
- **Description**: The inline `Cron` type uses `[key: string]: any` as a catch-all which masks this, but `enabled` and `on_run_completed` should be explicitly declared for type safety.
- **Severity**: Low
- **Recommendation**: Add `enabled: boolean` and `on_run_completed?: string` to the inline Cron interface.

### P7 - Run `kwargs` field allows `any` via index signature in repository type
- **File**: `src/modules/runs/runs.repository.ts`
- **Description**: The `Run` interface has `[key: string]: any` which defeats type safety. This allows any property to be set without type checking.
- **Severity**: Low
- **Recommendation**: Remove the index signature and explicitly declare needed fields.

### P8 - `GET /threads/:thread_id/state/:checkpoint_id` endpoint not implemented
- **File**: Refined request FR-02 endpoint #9 mentions this variant
- **Description**: The refined request mentions `GET /threads/{thread_id}/state/{checkpoint_id}` as a variant of the state endpoint. The `GetStateWithCheckpointParamSchema` exists in `thread.schema.ts` but no route uses it.
- **Severity**: Low
- **Recommendation**: Add the route when needed for SDK compatibility testing.

### P11 - `POST /state` message append lacks `add_messages` id-dedup / RemoveMessages fidelity
- **Files**: `src/modules/threads/threads.service.ts` (`updateState`), `src/agents/state-reducer.ts` (`append`)
- **Description**: `POST /threads/:id/state` now appends `messages` via the `append` channel reducer (`DEFAULT_CHANNEL_REDUCERS`), matching LangGraph `update_state`'s reducer routing (state channels still `LastValue`, siblings retained). But `append` is a plain array concat — it does not dedupe/merge by message `id`, nor honor `RemoveMessages`, the way LangGraph's `add_messages` reducer does. A caller that re-sends a message with an existing `id` double-adds it instead of replacing in place. The run path's hand-rolled 3-way concat (`runs.service.updateThreadState`) has the same limitation.
- **Severity**: Low
- **Recommendation**: Only if clients edit/replay messages through `POST /state` or runs — upgrade `append` (or add a dedicated `add_messages`-style reducer) to merge-by-`id` and process `RemoveMessages`, and apply the same reducer to both the manual and run paths. Until then, append + sibling-retention is the documented, intentional behavior.

### P9 - Configuration exception: STORAGE_CONFIG_PATH defaults to file-existence detection
- **File**: `src/storage/yaml-config-loader.ts`
- **Description**: Per project rules, no fallback values are permitted for configuration. However, the storage system needs a way to work without a config file (defaulting to in-memory provider). The approach is: if `STORAGE_CONFIG_PATH` env var is not set, the loader checks if `storage-config.yaml` exists at the project root. If the file exists, it is loaded. If neither the env var nor the file exist, the system defaults to the in-memory provider. This is file-existence detection, not a config fallback -- documented as a deliberate exception per the storage infrastructure design.
- **Severity**: Info (deliberate design decision)

---

---

## Completed Items

### P10 — Manual `POST /state` flattened to match the canonical convention (divergence closed)
- **Date**: 2026-05-27
- **Files**: `src/modules/threads/threads.service.ts` (`updateState`), `test_scripts/threads.test.ts`, `docs/design/project-design.md`
- **Issue**: After `LG-STATE-CANONICAL` flattened the run path, `threads.service.updateState` still special-cased a **nested** `values.state` blob (spread `params.values`, then per-channel merge an incoming `values.state` over the stored one). A legacy nested `POST /state` (`{ values: { state: {…} } }`) therefore wrote a literal `state` channel that the run composer surfaced to the agent as `{ state: {…} }` (double-nested) — inconsistent with the flat model. It also wiped sibling channels for flat top-level keys (it spread only `params.values`, not the stored values).
- **Fix**: `updateState` now does `reduceChannels(currentValues, params.values)` — a per-channel `LastValue` merge at the **top level** of `values`, matching `runs.service.updateThreadState`. A partial `POST /state` replaces only the channels it names and retains every sibling (including `messages`); the nested `values.state` special-case is gone. Rewrote the two `threads.test.ts` cases that asserted `body.values.state` to the flat shape (assert `body.values` via `toMatchObject` + `not.toHaveProperty('state')`). `npx tsc --noEmit` clean; full suite green except the pre-existing unrelated `skill-agent.test.ts` failures (missing `agents/skill-agent/node_modules`). Every write path (run input → agent, agent → storage, manual `POST /state`) is now consistent and flat. (ADR-0001 is left as the append-only historical record of the original nested per-channel decision; this flatten supersedes it and is recorded here + in `project-design.md`.)

### LG-STATE-CANONICAL — Aligned run state passing with LangGraph "input keys = graph state" convention
- **Date**: 2026-05-27
- **Files**: `src/agents/request-composer.ts`, `src/modules/runs/runs.service.ts`, `test_scripts/agent-connector.test.ts`, `test_scripts/request-composer.test.ts`, `test_scripts/runs.test.ts`, `docs/design/project-design.md`
- **Issue**: lg-api carried a proprietary `input.state` extension. `RequestComposer.extractState` unwrapped an explicit `input.state` (per-channel merging it over the nested `threadState.values.state` blob) and `extractMetadata` spilled every other `input` key into `metadata`; `runs.service.updateThreadState` persisted the agent's returned state nested under `values.state`. This diverged from the canonical LangGraph contract where the run **input itself is the graph state** (every key other than `messages`/`documents`), which broke drop-in parity for SDK clients that send state as flat top-level input keys.
- **Fix (hard cut)**: Removed the `input.state` special-case and `extractMetadata`. `extractState` now inherits the top-level keys of `threadState.values` (minus `messages`/`documents`), folds the input's top-level state keys on top per-channel via the shared `reduceChannels` engine (input wins, omitted siblings retained), and returns `undefined` when empty. `composeRequest` takes a `metadata` param forwarded as-is; all four call sites in `runs.service.ts` pass `metadata: request.metadata ?? {}`. `updateThreadState` now folds `agentResponse.state` into the **top level** of `values` (per-channel), so it round-trips as inherited state next run; `messages` stay a separate manual append. A literal `state` input key is now just a channel — legacy `input.state` callers break loudly, by design. Rewrote the state tests in `agent-connector.test.ts`, `request-composer.test.ts`, and `runs.test.ts` to the flat convention (input keys → state, inherited values → state, input override, top-level `metadata` forwarded). Updated the "Graph state" section of `project-design.md`. `npx tsc --noEmit` clean; full suite green except the pre-existing `skill-agent.test.ts` failures (missing `agents/skill-agent/node_modules`, unrelated). Follow-up divergence on the manual `POST /state` path tracked as P10.

### C7 - Run creation ignored `if_not_exists` and always 404'd on missing thread
- **Files**: `src/modules/runs/runs.service.ts`, `test_scripts/runs.test.ts`
- **Issue**: The `RunCreateRequestSchema` declared `if_not_exists: "create" | "reject"` (`src/schemas/run.schema.ts:54`) and the project docs cited the real LangGraph semantics (`docs/reference/langgraph-api-concepts.md:848`), but `RunsService` never read the field. `createStateful` (line 61), `wait` (line 439), and `streamRun` (line 570) each contained an inline `getById` + `throw new ApiError(404, ...)` block that unconditionally rejected missing threads. Real LangGraph honors `if_not_exists: "create"` and auto-creates the thread, which is why the NBG `agent-proxy` (`Nbg.NetCore.AI.Agents.Common/Models/LangGraph/ChatModels.cs:30-33`, default `"create"`) works against cloud LangGraph but got `{"detail":"Thread <id> not found"}` against lg-api.
- **Fix**: Added a private `RunsService.ensureThread(threadId, ifNotExists)` helper that returns the existing thread, auto-creates it when `ifNotExists === "create"`, or throws 404 otherwise (default — matches real LangGraph). Replaced all three inline 404 sites with calls to the helper threading `request.if_not_exists` through. Added six vitest cases in `test_scripts/runs.test.ts` covering both branches for `createStateful`, `wait`, and `streamRun`.

### C6 - SQLite schema uses unquoted `values` column name (reserved keyword)
- **Files**: `src/storage/providers/sqlite/sqlite-schema.ts`, `src/storage/providers/sqlite/sqlite-thread-storage.ts`
- **Description**: The Thread and ThreadState table DDL and INSERT/UPDATE queries used `values` as a column name without quoting. `VALUES` is a reserved keyword in SQLite, causing "near values: syntax error" on table creation and all queries referencing this column.
- **Fix**: Quoted the column name as `"values"` in the schema DDL (`sqlite-schema.ts`) and in all SQL statements in `sqlite-thread-storage.ts` (INSERT INTO Thread, UPDATE Thread, INSERT INTO ThreadState).

### C4 - TypeBox `$id` fields causing Fastify serializer conflicts
- **Files**: All files in `src/schemas/`
- **Description**: TypeBox schemas with `$id` fields (especially `CheckpointSchema`, `InterruptSchema`, and enum schemas) caused Fastify's `fast-json-stringify` to throw "resolves to more than one schema" when the same schema was embedded inline in multiple response schemas.
- **Fix**: Removed all `$id` fields from TypeBox schemas. They are not needed since schemas are used inline (not via `$ref`).

### C5 - Repository singletons not shared across route modules
- **Files**: All `*.routes.ts` files
- **Description**: Each route module created its own repository instances as module-level singletons. This meant threads created via `POST /threads` were invisible to the runs module which had its own `ThreadsRepository`.
- **Fix**: Created `src/repositories/registry.ts` with a centralized `RepositoryRegistry` singleton. All route modules now use `getRepositoryRegistry()` to get shared instances.



### C1 - Stateless runs used empty string for thread_id instead of null
- **Files**: `src/modules/runs/runs.service.ts`, `src/modules/runs/runs.repository.ts`
- **Description**: The `RunSchema` defines `thread_id` as `string | null`, but the service was setting `thread_id: ''` for stateless runs. The repository's `Run` interface had `thread_id: string` (not nullable).
- **Fix**: Changed repository interface to `thread_id: string | null` and service to use `null`.

### C2 - Store SearchItem schema `score` field changed from required to optional
- **File**: `src/schemas/store.schema.ts`
- **Description**: The `SearchItemSchema` defined `score: Type.Number()` (required), but the repository only assigns `score` when a text query is provided. This would cause runtime serialization failures.
- **Fix**: Changed to `score: Type.Optional(Type.Number())`.

### C3 - Unused imports cleaned up across multiple files
- **Files**: `src/schemas/common.schema.ts`, `src/schemas/assistant.schema.ts`, `src/schemas/thread.schema.ts`, `src/schemas/run.schema.ts`, `src/schemas/cron.schema.ts`, `src/schemas/store.schema.ts`, `src/modules/runs/runs.routes.ts`
- **Description**: Removed unused `Static` imports from all schema files, unused `MetadataSchema`, `GraphSchemaSchema`, `ErrorResponseSchema` from assistant schema, unused `ConfigSchema`, `MetadataSchema` from thread schema, unused `CheckpointSchema` from cron schema, and unused `FastifyRequest`/`FastifyReply` from runs routes.
