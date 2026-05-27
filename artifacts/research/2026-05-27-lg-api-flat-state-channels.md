# lg-api thread-state: flatten channels (Change A) + per-channel merge (Change B) — need, spec, ADR, impact

_Investigation date: 2026-05-27. Repo: `/Users/zisisflokas/projects/agents/lg-api` (TypeScript reimplementation of the LangGraph Platform server). This is a codebase deep-dive; canonical LangGraph semantics taken from the prior HIGH-confidence investigation at `payments-agent/artifacts/research/2026-05-27-langgraph-state-overwrite-vs-merge-investigation.md`._

---

## 1. Bottom line (confidence: HIGH on the code facts; MODERATE on the "why-not-flat" historical motive)

Both bugs are real and both live entirely in lg-api's agent-integration layer, not in the storage layer. **Change B (per-channel merge) is the safe, surgical fix and should ship first: it can be done in `runs.service.ts` + `request-composer.ts` alone, fixes the wipe bug, and requires ZERO change to the deployed payments-agent or any other agent.** Change A (flatten agent state to top-level `values` channels) is a larger, SDK-alignment change that *does* require changing both the connector contract and the payments-agent backend, plus a backward-compat migration for already-persisted threads. On the key-clash question: if you flatten, **exactly one** payments-agent field collides with an lg-api-reserved name — `messages` — and three more (`documents`, `metadata`, `state`) are reserved at the `input` level and would be silently mis-routed if reused. None of the payments-agent's *business* field names (`organization_name`, `payment_code`, `amount`, the `_`-prefixed ones, etc.) collide. The recommended collision-avoidance is a declared reserved set + keep `messages` as the one append channel and forbid agents from putting a `messages`/`documents`/`state`/`metadata` business key at top level. The "why flat was avoided" is recorded only implicitly: the agent-integration design (design-004, `request-composer.ts` docstring) deliberately chose "lg-api does NOT modify state; the agent owns it; pass it through as one opaque blob, no merging." That decision predates noticing the wipe and was about agent-ownership simplicity, not a considered rejection of flat channels.

---

## 2. Why (the case, grounded in the code)

**The two bugs are confirmed verbatim.**

- Whole-object overwrite on input: `request-composer.ts:229-251` `extractState()` returns `input.state` as-is when present ("Explicit state from input takes priority (passed through untouched)") and otherwise returns `threadState.values.state` as-is. The docstring states the intent explicitly: *"The lg-api does NOT modify the state object… No merging, no field extraction, no transformation"* (`request-composer.ts:218-227`).
- Single nested `state` blob channel: `runs.service.ts:743` `const newValues = { ...stateValues, messages: allMessages, ...(agentResponse.state ? { state: agentResponse.state } : {}) }`. Agent state is stored under one `state` key inside `values`, sibling to `messages`. `request-composer.ts:241-244` reads it back from `threadState.values.state`.

**Net effect matches the reported regression.** When a client re-sends `input.state = { user_id }`, `extractState` returns just `{ user_id }` (overwriting), the agent (`payments-agent/agent/agent.ts:536-595` `lgApiHandler`) seeds defaults onto that thin object and returns it as the whole `turn.state`, and `runs.service.ts:743` overwrites the stored `state` blob wholesale — wiping every sibling field. This is exactly the divergence from canonical LangGraph documented in the prior investigation (per-channel reduction; absent keys retained).

**The storage layer is agnostic to flat-vs-nested.** Thread `values` is persisted as a single serialized JSON blob in one column: SQLite `"values" TEXT` (`sqlite-schema.ts:15,24`), written via `JSON.stringify(state.values)` (`sqlite-thread-storage.ts:170`); SQL Server `values NVarChar(MAX)` (`sqlserver-thread-storage.ts:167`); in-memory holds the object directly (`threads.repository.ts:46,99-103`). So flattening keys *inside* `values` changes no DDL, no migration of the storage schema — only the shape of the JSON inside the blob.

**lg-api already special-cases `messages` as an append channel, and that generalizes.** `runs.service.ts:732,740` reads `stateValues.messages`, appends `inputMessages` + `responseMessages`, writes the concatenation. That is a hand-rolled `add_messages` reducer for exactly one channel. Change B is "do this same fold for the other keys, default = LastValue (replace that one key), and retain keys absent from input" — a direct generalization of code that already exists.

**lg-api intends SDK/wire compatibility.** The branch `feat/langgraph-platform-compatibility` (`.git/logs/HEAD:10-13`, commit "feat: LangGraph Platform API compatibility", ~Apr 2026) and the pattern of fixing divergences from "real LangGraph" (Issues C7 `if_not_exists`, C6 SQLite `values` reserved word, P2/P3 SDK-shape fixes) show the project tracks the real Platform contract. The real LangGraph JS/Python SDKs send run `input` as **flat top-level channel values** and stream `values` as **flat top-level state** — lg-api's own docs show this (`investigation-conversation-flow.md:1072-1079,949-953`: messages append reducer, `values` = `{field1, field2}`). The nested `{state:{…}}` blob is therefore itself a compatibility divergence, and Change A moves *toward* SDK parity.

---

## 3. Counter-case / what would change the recommendation

- **If no real LangGraph SDK/Studio client ever talks to this deployment** (only the NBG agent-proxy + payments-agent, which both speak the nested-`state` shape), then Change A's SDK-compatibility benefit is moot and only Change B is worth doing. The compatibility branch suggests SDK clients *are* a goal, but I found no live proof that a stock LangGraph SDK client is in production against this server — treat "SDK clients are in use" as an assumption, not a confirmed fact. `[unverified]`
- **If the agent genuinely needs to send a full-state replace sometimes** (e.g., a "reset"), a blanket per-channel merge removes that capability. Canonical LangGraph handles this with explicit mechanisms (send all channels, `RemoveMessages`, fork). Change B should preserve an escape hatch (e.g., a per-key `LastValue` default already *is* a replace-that-key; full reset = send every key).
- **The "why-not-flat" motive is only weakly recorded.** The docstring and design-004 say "agent owns state, lg-api passes it through," which explains the *opaque-blob* choice but does not show anyone weighed flat-channels-with-reducers and rejected it. The user's memory ("for some reason we didn't change it") is consistent with "it was never actually considered, it just fell out of the agent-ownership framing." I could not find a doc that says "we chose nested over flat because X." `[MODERATE confidence — absence of evidence]`

---

## 4. Findings

### 4.1 Full state lifecycle map (Q1)

Request → execution → persistence → read-back, with citations:

1. **Ingestion.** Client `POST /threads/:id/runs[/wait|/stream]` with body validated by `RunCreateRequestSchema` (`run.schema.ts:24-62`). `input` is `Record<string,unknown> | null` (`run.schema.ts:26-29`). Routes delegate to `RunsService` (`runs.routes.ts`).
2. **Run record.** `createStateful`/`wait`/`streamRun` build a `Run` storing `kwargs.input = request.input` (`runs.service.ts:76, 419, 550`).
3. **Load prior state.** `threadsRepository.getState(threadId)` returns the latest `ThreadState` (`runs.service.ts:99-103, 445-447, 575-579`), shape `{ values, next, checkpoint, metadata, created_at, parent_checkpoint, tasks }` (`threads.repository.ts:23-42`, schema `thread.schema.ts:32-41`).
4. **Compose agent request.** `RequestComposer.composeRequest` (`request-composer.ts:32-76`):
   - history messages from `threadState.values.messages` (`:85-99`);
   - new messages from `input.messages` (`:106-115`);
   - documents from `input.documents` (`:194-216`);
   - **state** via `extractState(input, threadState)` — `input.state` if present else `threadState.values.state`, **as-is** (`:229-251`);
   - **metadata** = every `input` key except `messages|documents|state` (`:256-264`).
   Produces `AgentRequest { thread_id, run_id, assistant_id, messages, documents?, state?, metadata? }` (`types.ts:48-56`).
5. **Execute.** `AgentExecutor.execute(graph_id, request)` → `ConnectorFactory` → for `type:'api'` the `ApiAgentConnector` POSTs the whole `AgentRequest` as JSON (`api-connector.ts:48-56`) and parses `AgentResponse { thread_id, run_id, messages, state?, metadata? }` (`types.ts:61-67`, validated `api-connector.ts:91-96`).
6. **Persist.** `updateThreadState` (`runs.service.ts:725-765`): messages = `existingMessages ++ inputMessages ++ responseMessages` (`:732-740`); `newValues = { ...stateValues, messages, ...(agentResponse.state ? {state} : {}) }` (`:743`); written to state history via `addState` (`:746-758`) and to the thread entity `values` (`:761-764`).
7. **Storage.** `addState`/`update` serialize `values` to one JSON blob — in-memory (`threads.repository.ts:99-103`), SQLite (`sqlite-thread-storage.ts:163-179`, column `"values"` `sqlite-schema.ts:24`), SQL Server (`sqlserver-thread-storage.ts:163-179`).
8. **Read-back next turn.** Next run's step 3 reloads `threadState.values.{messages,state}`; `getState` falls back to `thread.values` if no state row (`threads.service.ts:251-277`).
9. **Manual edits.** `POST /threads/:id/state` → `ThreadsService.updateState` **replaces** `values` wholesale (`threads.service.ts:282-323`) — same overwrite shape as the run path, also a Change-B candidate.

### 4.2 Reserved-key inventory (Q2) — the crux of the clash question

There are TWO levels. Agent state is carried *inside* `input.state` and *inside* `values.state` today; flattening would lift agent keys to the top level of `input` and `values`, so the relevant reserved sets are the top-level keys of those two objects.

**(a) Run `input` object — top-level keys lg-api reads specially (`request-composer.ts`):**

| `input` key | lg-api behavior | Citation |
|---|---|---|
| `messages` | history/new messages, normalized, drives the append channel | `request-composer.ts:106-115` |
| `documents` | extracted to `AgentRequest.documents` | `request-composer.ts:194-216` |
| `state` | passed through to `AgentRequest.state` (the nested blob) | `request-composer.ts:234-237` |
| _everything else_ | swept into `AgentRequest.metadata` | `request-composer.ts:256-264` |

> Note: `command`, `stream_mode`, `config`, `checkpoint`, `interrupt_*`, `multitask_strategy`, `if_not_exists`, etc. are **siblings of `input` in the run body** (`run.schema.ts:30-62`), not keys *inside* `input`. They are not consulted by `extractMetadata`. So for a flatten that puts agent channels inside `input`, only `messages|documents|state` are reserved; any other key inside `input` today is treated as metadata (a soft reservation — it won't reach the agent as a channel, it lands in `metadata`).

**(b) Thread `values` object — top-level keys lg-api reads/writes:**

| `values` key | lg-api behavior | Citation |
|---|---|---|
| `messages` | read for history; written as the concatenated append channel | `request-composer.ts:91`; `runs.service.ts:614,711,732,740` |
| `state` | read back as the agent blob; written from `agentResponse.state` | `request-composer.ts:243-244`; `runs.service.ts:743` |

**(c) Wrapper-level reserved names (NOT agent-state keys, but worth knowing):** the `ThreadState` envelope keys `values, next, checkpoint, metadata, created_at, parent_checkpoint, tasks, interrupts` (`thread.schema.ts:32-41`); the SQL column name `values` is a reserved keyword, already quoted (`sqlite-schema.ts:15,24`, Issues C6). These are around the blob, not inside it, so flat agent keys don't touch them.

### 4.3 Key-clash verdict (Q3) + collision-avoidance

Cross-checking the payments-agent `state_variables` against the reserved sets above:

| Payments-agent field | Clashes with reserved? | Where / why |
|---|---|---|
| `messages` | **YES — hard clash** | Both an agent field AND lg-api's append channel in `values` and `input` (`runs.service.ts:740`, `request-composer.ts:91,106`). Flattening would merge the two meanings. |
| `documents` | Soft clash (only if reused) | Reserved at `input` level (`request-composer.ts:195`). Payments-agent does not use it today; do not introduce it. |
| `metadata` | Soft clash (only if reused) | `AgentRequest.metadata` / `AgentResponse.metadata` (`types.ts:55,66`). Don't use as a top-level business channel. |
| `state` | Soft clash (only if reused) | The current blob key (`request-composer.ts:234`, `runs.service.ts:743`). Under Change A it disappears as a wrapper; don't reintroduce it as a business field. |
| `organization_name`, `payment_code`, `amount`, `payment_method`, `card_number`, `debit_account_iban`, `commission`, `comment`, `execute_type`, `deferred_date`, `is_recurring`, `deferred_frequency`, `deferred_total_payments`, `payment_confirmed`, `payment_initiated`, `otp_code`, `user_id`, `customer_code`, `customer_id`, `user_cra`, `language`, `memory` | **No clash** | None match a reserved name at `input` or `values` level. |
| `_roles`, `_org_full`, `_available_orgs`, `_thread_id`, `_run_id`, `_user_accounts`, `_user_cards`, `_org_name` | **No clash** | `_`-prefixed; no overlap. `_thread_id`/`_run_id` shadow the envelope `thread_id`/`run_id` only by resemblance, not by collision (different names, and they live inside the blob/channels, not the envelope). |

**Verdict: one true collision (`messages`), three soft reservations (`documents`, `metadata`, `state`). All business fields are clash-free.**

**Recommended collision-avoidance strategy (in priority order):**
1. **Treat `messages` as the single shared append channel** — the agent's `messages` and lg-api's `messages` are the *same* channel; don't carry conversational messages inside business state. (Payments-agent already keeps `messages` separate from the rest of its state, so this is naturally satisfied.)
2. **Declare a reserved set** in lg-api: `{ messages, documents, state, metadata }` at top level of `input`/`values`, plus the envelope names. Forbid agents from using these as business channels; document it in `agent-registry.yaml` / connector contract.
3. **Optional, lowest-friction interim: keep agent business state in a namespaced sub-object** (e.g., the existing `state` blob) but apply per-channel merge *inside* it. This is Change B without Change A and avoids the clash question entirely. If full SDK parity (Change A) is wanted later, lift the keys then.

### 4.4 Why "flatten" was avoided before (Q4)

The closest thing to a recorded reason is the agent-integration design's framing, not an explicit "flat-vs-nested" trade study:

- `request-composer.ts:218-251` (the `extractState` docstring): *"The lg-api does NOT modify the state object. Only the agent is responsible for maintaining and changing it… No merging, no field extraction, no transformation."* — agent-as-owner, state-as-opaque-blob.
- `custom-agent-integration-concepts.md:96-106` design principle #1 "Stateless Agents": *"Agents should not maintain conversation state. The lg-api provides full context with each request,"* and §8.4 recommends "lg-api manages history" — but for *messages*, while business state was treated as the agent's opaque payload.
- `design-004-agent-assistant-integration.md:232-238` lists `AgentRequest`/`AgentResponse` as "existing types that remain unchanged" and §5.5 shows `updateThreadState` building `values: { messages, ...(state? {state}) }` — i.e., the nested blob was baked into the design from day one, never debated against flat.
- Git: the whole agent integration (incl. `request-composer.ts` and the nested-`state` write) landed on `feat/langgraph-platform-compatibility` (`.git/logs/HEAD:10-13`). The compatibility goal was about endpoints/SDK shape (threads, runs, `if_not_exists`, SSE), and state was modeled as a pass-through blob owned by the agent — flat channels were simply out of scope of that effort.

So: flat wasn't rejected on technical grounds; the nested opaque-blob fell out of the "agent owns its state" principle, and nobody revisited it once the wipe surfaced. `[MODERATE — inferred from docstrings/design, no explicit ADR]`

### 4.5 Impact on the deployed agent (Q5)

The payments-agent backend (`payments-agent/agent/agent.ts:536-595` `lgApiHandler`): reads `request.state` as the whole prior state (`:538,549,551-553`), `seedDefaults(state)` (`:555`), computes `runAgentTurn`, returns `{ messages:[…], state: turn.state, metadata }` (`:588-594`) — i.e., it consumes the full nested blob and returns the full nested blob.

- **(a) Does Change B alone fix the wipe with no agent change?** **YES.** If lg-api merges `input.state` into `threadState.values.state` per-key (retain absent keys) in `extractState`/`updateThreadState`, then a partial `input.state = {user_id}` updates only `user_id` and the agent still receives the *full* merged blob in `request.state`, seeds defaults, and returns the full blob — exactly its current contract. No payments-agent edit. (Subtlety: the agent returns the *whole* `turn.state`, so the response side is already a full snapshot; the fix is purely on the *input* side and the input→stored merge.)
- **(b) Does Change A require contract + backend changes?** **YES, both.** Flattening means lg-api would (i) read flat channels from `values` instead of `values.state`, (ii) send the agent flat channels (or keep sending `state` but now reconstructed), and (iii) ideally accept *partial channel updates* back rather than a full `state`. The payments-agent currently reads `request.state` (`:538,549,552`) and returns full `turn.state` (`:592`); to be a good flat-channel citizen it would need to read top-level channels and return only changed channels. At minimum the `AgentRequest`/`AgentResponse` `state` field (`types.ts:54,65`) and the connector mapping change → a coordinated lg-api + agent + `lg-agent-sdk-ts` release.
- **(c) Backward-compat of persisted threads.** Existing threads have `values.state = {…}` (nested). After Change A, code reading flat `values.*` would not find the old fields. **A dual-read/migration is required**: on read, if `values.state` exists, spread it up to top level (lazy migration) and stop writing the nested key; or a one-shot migration over the blob (no DDL, just rewrite the JSON). Change B has **no** backward-compat issue — the shape is unchanged, only the merge logic differs.
- **(d) Other agents.** `agent-registry.yaml` registers `passthrough` (CLI) and `skill-code-reviewer` (CLI). The `passthrough` agent does not round-trip business `state` (it forwards to an LLM), so it's unaffected by either change. Any *other* `api`-type agent that uses the nested-`state` contract would be affected by Change A exactly like payments-agent; none such are in the registry today. Change B affects no agent.

### 4.6 Agent-contract & reducer-registry feasibility (Q6)

For Change A to mirror LangGraph fully, lg-api must know each channel's reducer. Sources available:
- **A `/schema` endpoint already exists in the type system but is unused for this:** `GraphSchemaSchema` (`common.schema.ts:44-52`) has `input_schema`/`state_schema`/`output_schema`. No connector populates it; the `AgentConfig` union (`types.ts:93-123`) carries no reducer/schema info, and `agent-registry.yaml` has no schema fields. So a backend `/schema` endpoint is *possible* but not wired.
- **Convention is the pragmatic path:** lg-api already hard-codes the one reducer it needs — `messages` = append (`runs.service.ts:732-740`). The simplest faithful model is "**everything is LastValue (replace that one key) except `messages`, which appends**," which matches how 95% of LangGraph state behaves and exactly matches payments-agent's needs (all scalar/object business fields are LastValue; `messages` appends).
- **Registry-declared reducers** (add an optional `reducers: { field: 'append'|'last' }` to `agent-registry.yaml` per graph) is the clean extension if a non-`messages` append channel ever appears. Feasible but unnecessary for payments-agent.

Verdict: Change A is feasible with a **convention** (LastValue-except-messages); a full reducer registry is not required for the current agents, and the `messages` special-case already generalizes.

### 4.7 LangGraph-platform compatibility (Q7)

Confirmed direction-of-travel: lg-api aims to be wire-compatible with the real Platform/SDK (`feat/langgraph-platform-compatibility` branch `.git/logs/HEAD:10-13`; Issues C7/C6/P2/P3 all "match real LangGraph"/"SDK compatibility"). The real LangGraph JS/Python SDKs send `input` as **flat top-level channel values** and `values`/`updates` stream **flat top-level state** — lg-api's own docs describe this (`investigation-conversation-flow.md:486-503,949-953,1072-1079`). Therefore the nested `{state:{…}}` blob **is** a compatibility divergence, and **Change A moves toward SDK compatibility**, while Change B fixes the data-loss bug without changing the shape. (Caveat: one lg-api concept doc shows a nested example `event: values data:{"state":{…}}` at `langgraph-api-concepts.md:1530,1685,1699` — internal docs are inconsistent; the authoritative SDK behavior is flat, per the conversation-flow investigation and the prior canonical investigation.) `[compatibility intent: HIGH; that a stock SDK client is actually deployed against this server: unverified]`

---

## 5. Impact matrix

Layers: **lg-api server** (request-composer + runs.service) · **agent connector contract** (`types.ts` `AgentRequest/Response`, api-connector) · **deployed payments-agent backend** (`agent.ts lgApiHandler`) · **persisted-thread backward-compat** · **other agents** (passthrough, skill-code-reviewer).

| | lg-api server | connector contract | payments-agent backend | persisted threads | other agents |
|---|---|---|---|---|---|
| **Change B only** (per-channel merge, keep nested `state`) | Edit `extractState` (`request-composer.ts:229-251`) + `updateThreadState` (`runs.service.ts:743`) + `ThreadsService.updateState` (`threads.service.ts:282-323`) to merge per-key | **No change** | **No change** (still receives/returns full blob) | **No change** (same shape) | **No change** |
| **Change A only** (flatten, keep whole-object semantics) | Read/write flat `values.*` instead of `values.state`; map metadata carefully | **Change** (`AgentRequest/Response` lose/redefine `state`; api-connector mapping) | **Change** (read top-level channels; return partial/flat) | **Migration/dual-read needed** (old `values.state` → top level) | passthrough unaffected; any nested-`state` api agent affected |
| **Both** (flat channels + per-channel reducers = full LangGraph parity) | Largest: flat keys + reducer convention (`messages` append, rest LastValue) + retain-absent | **Change** (contract returns partial channel updates) | **Change** (read flat, return only changed channels) | **Migration/dual-read needed** | passthrough unaffected; future api agents must adopt contract |

---

## 6. Recommended sequencing

1. **Ship Change B first (low risk, no coordination).** It is the minimal fix for the production wipe, touches only lg-api (`request-composer.ts`, `runs.service.ts`, `threads.service.ts`), keeps the nested `state` blob, and needs **no** payments-agent release and **no** thread migration. Implement per-channel merge *inside* the `state` blob: for each key in incoming `input.state`, replace that key in stored `values.state` (LastValue), retain keys absent from input; keep `messages` appending as today. Add unit tests mirroring `test_scripts/threads.test.ts` / state-updater tests.
2. **Then evaluate Change A as a separate, opt-in compatibility milestone.** Only pursue it if a real LangGraph SDK/Studio client is (or will be) a first-class consumer. It needs a coordinated lg-api + `lg-agent-sdk-ts` + payments-agent change, a reducer convention (LastValue-except-`messages`), a reserved-key declaration (`messages|documents|state|metadata`), and a lazy dual-read migration (`values.state` → top-level). Gate it behind the reserved-key strategy in §4.3 so `messages` stays the single append channel.

B-then-A is the low-risk path: B stops the bleeding immediately and is reversible; A is a deliberate parity upgrade that can be designed without time pressure once B is in.

---

## 7. Uncertainties & open questions

- **Is a stock LangGraph SDK client actually in production against this lg-api?** The compatibility *intent* is clear from git + Issues, but I found no deployed-client proof. If only the NBG agent-proxy + payments-agent talk to it (both nested-`state` speakers), Change A's payoff is mostly future-proofing. `[unverified]`
- **No explicit ADR for nested-vs-flat.** The motive in §4.4 is inferred from docstrings/design-004, not a decision record. A human who was in the room could confirm whether flat was ever weighed.
- **`metadata` round-trip.** `extractMetadata` sweeps all non-`messages/documents/state` `input` keys into `AgentRequest.metadata` (`request-composer.ts:256-264`), but `updateThreadState` does not persist `metadata` back into `values` (only `messages` + `state`, `runs.service.ts:743`). Under Change A, decide whether flat channels arriving as "metadata" should be persisted — today they are not, which could surprise a flat client. Worth a test.
- **SSE `values` payload shape.** `streamRun` emits `values` with only `{ messages }` (`runs.service.ts:619-623`), not the full state. Independent of A/B, but a real `stream_mode:["values"]` client expects full flat state — a separate compatibility gap to track.
- **Internal doc inconsistency** on nested vs flat `values` (`langgraph-api-concepts.md` shows nested `{state:{…}}`; `investigation-conversation-flow.md` shows flat). Authoritative behavior is flat per the canonical investigation; the lg-api concept doc should be corrected if Change A lands.

## 8. Assumptions relied on

- Canonical LangGraph semantics (per-channel reduction, LastValue default, absent-keys-retained, `add_messages` append) are taken from the prior HIGH-confidence investigation, not re-derived here.
- Payments-agent `state_variables` list is taken from the task brief / `agent_config.json` header as given.
- "Deployed agent" = the `api`-type payments-agent backend reached via `ApiAgentConnector`; CLI agents (passthrough, skill-code-reviewer) are in-repo test agents.
- Stakes = real engineering decision feeding a contribution to lg-api; hence file:line precision and a falsification pass on the "why-not-flat" motive and the SDK-client assumption.

## 9. Key sources (lg-api code, primary)

- `src/agents/request-composer.ts:218-264` — `extractState` (overwrite, no merge) + `extractMetadata` (reserved `input` keys). [primary]
- `src/modules/runs/runs.service.ts:725-765` — `updateThreadState`, nested `state` write, `messages` append. [primary]
- `src/agents/types.ts:48-67,93-123` — `AgentRequest`/`AgentResponse`/`AgentConfig` contract. [primary]
- `src/agents/connectors/api-connector.ts:37-99` — full-request POST, response validation. [primary]
- `src/modules/threads/threads.service.ts:251-323`, `threads.repository.ts:23-103` — state read/write, single `values` object. [primary]
- `src/schemas/run.schema.ts:24-62`, `thread.schema.ts:32-41`, `common.schema.ts:44-52` — run-body keys, `ThreadState` envelope, unused `GraphSchema`. [primary]
- `src/storage/providers/sqlite/sqlite-schema.ts:8-34`, `sqlite-thread-storage.ts:163-179`, `sqlserver-thread-storage.ts:167` — `values` as one JSON blob (flat-agnostic). [primary]
- `docs/design/design-004-agent-assistant-integration.md:232-238,977-1026`, `docs/reference/custom-agent-integration-concepts.md:96-106,1594-1612` — agent-owns-state framing (why-not-flat, inferred). [primary, internal design]
- `docs/reference/investigation-conversation-flow.md:486-503,949-953,1072-1079` — flat `values`, messages append reducer (SDK behavior). [internal reference]
- `.git/logs/HEAD:10-13` — `feat/langgraph-platform-compatibility` branch + commit. [primary, git]
- `Issues - Pending Items.md:58-66` (C7, C6) — pattern of matching real LangGraph / SDK compatibility. [primary, internal]
- `payments-agent/agent/agent.ts:536-595` — `lgApiHandler` reads `request.state`, returns full `turn.state`. [primary]
