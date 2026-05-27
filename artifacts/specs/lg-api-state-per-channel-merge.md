---
type: spec
id: lg-api-state-per-channel-merge
slug: lg-api-state-per-channel-merge
date: 2026-05-27
status: draft
produced_by: spec-writer
consumes:
  - /Users/zisisflokas/projects/agents/lg-api/artifacts/research/2026-05-27-lg-api-flat-state-channels.md
related:
  adrs:
    - docs/adr/0001-lg-api-per-channel-state-merge.md
  glossary: none
quality_gates:
  - non-goals-listed: pass
  - two-designs-sketched: pass
  - design-concept-one-sentence: pass
  - nfr-posture-addressed-in-design: pass
  - reversibility-boundaries-present: pass
  - open-questions-explicit: pass
  - adr-worthy-surfaced: pass
pause_points_hit: []
mode: lite
---

# Tech Spec — lg-api per-channel state merge (Scenario B)

> **Artifact location note.** lg-api's house style for design docs is `docs/design/design-NNN-*.md`
> (a curated, numbered series). This workflow-plugin artifact is deliberately kept under
> `artifacts/specs/` to avoid colliding with that numbered system. It is a transient implementation
> spec, not a permanent design-NNN entry. If this decision warrants a lasting record, promote the
> chosen design into a `design-NNN` doc separately.

## Problem (restated)

When a client starts a turn on an existing thread and re-sends only a *partial* `input.state`
(for example just `{ user_id }`), lg-api throws away every other accumulated state field. The
cause is in the agent-integration layer, not storage: `request-composer.ts` `extractState()`
returns `input.state` verbatim whenever it is present ("Explicit state from input takes priority…
No merging"), so the agent receives a thin state object, seeds defaults onto it, returns it as the
full snapshot, and `runs.service.ts` `updateThreadState` overwrites the stored `values.state`
blob wholesale. The conversational agent therefore regresses to an earlier step because all sibling
fields were silently wiped. The same wholesale-overwrite shape exists on the manual
`POST /threads/:id/state` path (`threads.service.ts` `updateState`). This diverges from canonical
LangGraph, which reduces each input key into its own channel (default `LastValue`) and **retains**
keys that are absent from the input.

Scenario B is the surgical, ship-today fix: apply a **per-channel merge** so a partial input updates
only the named keys and keeps the rest — done *inside* the existing nested `state` blob, with no
flattening, no agent change, and no thread migration.

## Goals

- Stop the wipe: a partial `input.state` updates only its named keys and retains all sibling keys
  already stored in `values.state`.
- Apply the same per-key merge at all three current overwrite sites (run-input compose, run-output
  persist, and the manual `POST /threads/:id/state` path) so no overwrite path is left behind.
- Introduce a single **pure, level-agnostic** reducer engine (`reduceChannels`) that the three sites
  share, and that a future Scenario A (flatten to top-level channels) can reuse verbatim.
- Preserve the existing `messages` append semantics exactly as they are today.
- Keep the change fully reversible: revert the util plus three call sites; the persisted thread
  shape never changes.
- Preserve a full-state "reset" capability: sending every key (each defaulting to `LastValue`)
  replaces the whole state, so reset semantics survive.

## Non-goals

- **Scenario A (flatten agent state to top-level `values` channels)** — out of scope; a separate,
  coordinated milestone requiring connector-contract changes, an agent release, and a thread
  migration. This spec only paves the way for it via a reusable engine.
- **A declared reserved-key set / reducer registry in `agent-registry.yaml`** — not needed for the
  nested-blob merge; belongs to Scenario A.
- **Changing the `AgentRequest`/`AgentResponse` contract or the api-connector mapping** — untouched.
- **Persisting `metadata` back into `values`, or fixing the SSE `values` payload shape** — known
  adjacent gaps (research §7), explicitly deferred.
- **Any payments-agent backend change or thread data migration** — the fix is lg-api-only.

## Background

lg-api is a TypeScript reimplementation of the LangGraph Platform server. Thread state is persisted
as a single JSON blob in one `values` column (SQLite `"values" TEXT`, SQL Server `values
NVarChar(MAX)`, in-memory holds the object). Agent business state lives nested under one key inside
that blob: `values.state`, sibling to `values.messages`. The storage layer is agnostic to the
internal shape of `values`, so changing *merge logic* inside the blob needs no DDL and no migration.

The current behavior was a deliberate framing, not a considered rejection of channel-merging: the
`extractState` docstring and design-004 state "the lg-api does NOT modify the state object… the
agent owns it; pass it through as one opaque blob, no merging." That framing predates anyone
noticing the wipe. Meanwhile lg-api *already* hand-rolls one reducer: `runs.service.ts` reads
`values.messages`, appends input + response messages, and writes the concatenation — an
`add_messages` reducer for exactly one channel. Scenario B is the direct generalization of that
existing code: do the same fold for the other keys, with `LastValue` (replace that one key) as the
default and absent keys retained.

The upstream research (HIGH confidence on the code facts) confirms all three overwrite sites verbatim
with file:line citations, and confirms that the deployed payments-agent needs no change: it reads
`request.state` as the full prior blob and returns the full `turn.state`, so a merge applied purely
on lg-api's input and persist sides is behavior-equivalent for it today while fixing the data loss.

## Designs considered

### Design A — Shared, level-agnostic `reduceChannels` util wired at all three sites (RECOMMENDED, chosen)

Introduce one pure module, `src/agents/state-reducer.ts`, exporting:

```
reduceChannels(
  prev: Record<string, unknown>,
  updates: Record<string, unknown>,
  reducers?: ReducerMap,
): Record<string, unknown>
```

For each key in `updates`, apply that key's reducer (default `LastValue` = replace the key in
`prev`); every key present in `prev` but absent from `updates` is carried through unchanged. The
reducer map convention is `{ messages: append, default: LastValue }`. The function is *level-agnostic*:
it operates on any record + reducer map and is never inline-bound to `values.state`. That is the
load-bearing reuse property — Scenario A later calls the same function on the top-level `values`
object with no edit to the engine.

Wire it at the three overwrite sites:
- **`request-composer.ts` `extractState()` (the bug):** when `input.state` is present, return
  `reduceChannels(threadState.values.state ?? {}, input.state)` instead of returning `input.state`
  raw. When `input.state` is absent, behavior is unchanged (return the stored state).
- **`runs.service.ts` `updateThreadState` (~:743):** fold `agentResponse.state` into the prior
  `values.state` via `reduceChannels` rather than wholesale-replacing the `state` key. (Agents return
  a full snapshot today, so this is behavior-equivalent now, but it makes the persist side
  partial-update-safe and reuses the one engine.)
- **`threads.service.ts` `updateState` (~:282-323):** the manual `POST /threads/:id/state` path —
  per-channel reduce against the current `values.state` instead of wholesale replace.

The existing `messages` top-level append in `updateThreadState` stays as-is for now. Under a future
Scenario A, that `messages` special-case and the `state`-blob merge collapse into a single
channel-reduce over `values`, with `reduceChannels` as the engine.

**Strengths**
- Fixes the bug at its true root and at every overwrite path, not just one.
- One pure, unit-testable function; logic lives in one place, easy to reason about and to revert.
- Level-agnostic design makes Scenario A a near-free follow-on (reuse the engine verbatim).
- Zero change to persisted shape, the agent, or the connector contract; fully reversible.
- Generalizes existing in-repo code (the `messages` append) rather than inventing a new pattern.

**Weaknesses**
- Slightly larger diff than a one-line patch (new module + three call sites + tests).
- Touches the manual `POST /state` path, which is not strictly required to fix the *reported*
  regression (run path) — broader blast radius, mitigated by tests.
- Introduces a reducer-map concept now that is only minimally exercised (only `messages` ever
  appends, and `messages` is not yet routed through it in B) — a small amount of forward-looking
  surface.

### Design B — Inline shallow-merge in `extractState` only (rejected)

Patch the single bug site: in `extractState`, when `input.state` is present, return
`{ ...storedState, ...input.state }` (a shallow spread merge) and leave `updateThreadState` and
`threads.service.ts` untouched. No shared util, no module.

**Strengths**
- Smallest possible diff; one function, one line of behavior change.
- Immediately stops the reported run-path regression.
- No new abstraction to maintain.

**Weaknesses**
- Bakes the merge at one call site; the manual `POST /threads/:id/state` overwrite is left unfixed,
  so a client editing state directly still wipes siblings.
- No reducer concept — a shallow spread cannot express `messages`-style append, so it does not
  generalize and cannot be the engine for Scenario A; that reuse is thrown away.
- Encodes the merge as an ad-hoc spread rather than a named, tested semantic (`LastValue` per key),
  making intent and the explicit-null behavior implicit and easy to regress.
- Duplicates merge logic the moment a second site needs it (which is now).

### Picked: Design A

**Design Concept (one sentence):** A single pure `reduceChannels(prev, updates, reducers)` util —
default `LastValue` per key, absent keys retained — applied at lg-api's three state-overwrite sites
inside the existing nested `state` blob.

**Why this, why not B:** Design B fixes only the run-path symptom at one call site, leaves the
manual `POST /state` overwrite broken, and — by using an anonymous shallow spread — discards the
one thing that makes the work compound: a named, tested, level-agnostic merge engine that Scenario A
reuses verbatim. Design A costs a few more lines and three wirings now, but it fixes every overwrite
path, expresses the semantics as a unit-testable contract (including explicit-null replacement and
the append channel), and turns the future flatten from a rewrite into a re-wire. Both are equally
reversible (no data-shape change in either), so the deciding factor is correctness coverage and
reuse, and Design A wins on both.

## Detailed design

### `reduceChannels` (new module `src/agents/state-reducer.ts`)

Contract (what is true, not how it loops):

- **Signature:** `reduceChannels(prev, updates, reducers?)` → a new record. Pure: never mutates
  `prev` or `updates`.
- **Per-key reduction:** for every key in `updates`, the result holds the reducer's output for that
  key. The default reducer is `LastValue` — the value from `updates` replaces the value in `prev`
  for that key.
- **Retention:** every key in `prev` that is **not** present in `updates` is carried into the result
  unchanged. This is the property that fixes the wipe.
- **Reducer map:** an optional `{ [key]: Reducer, default?: Reducer }` map. Convention for this repo:
  `{ messages: append, default: LastValue }`. A reducer is `(prevValue, updateValue) => value`.
  `append` concatenates arrays (matching the existing `messages` fold); `LastValue` returns
  `updateValue`.
- **Explicit null/undefined:** a key present in `updates` with value `null` is a real update under
  `LastValue` — it replaces (sets the key to `null`), it does **not** mean "skip". Presence in
  `updates`, not truthiness, decides whether a key is reduced. (This is the precise rule that lets a
  caller blank a field deliberately.)
- **Level-agnostic:** the function knows nothing about `values`, `state`, or thread shape. Callers
  pass whatever record they want reduced. Scenario A will call it on `values`; Scenario B calls it on
  `values.state`.

### Wiring (module boundaries — what changes at each site)

| Site | File ~line | Change | Behavior when `input`/update absent |
|---|---|---|---|
| Run-input compose | `request-composer.ts` `extractState` ~:229-251 | When `input.state` present → `reduceChannels(storedState ?? {}, input.state)`; pass result to agent | Absent → return stored state as-is (unchanged) |
| Run-output persist | `runs.service.ts` `updateThreadState` ~:743 | Replace `...(agentResponse.state ? { state: agentResponse.state } : {})` with `state: reduceChannels(stateValues.state ?? {}, agentResponse.state)` (only when response carries state) | No `agentResponse.state` → no `state` key written (unchanged) |
| Manual state edit | `threads.service.ts` `updateState` ~:282-323 | Reduce incoming `params.values.state` into current `values.state` via `reduceChannels` instead of wholesale-replacing | Behavior for non-`state` keys of `params.values` unchanged |

The `messages` top-level append in `updateThreadState:732-740` is **not** rerouted through
`reduceChannels` in Scenario B; it stays as the hand-rolled append. The spec records this as the
seam where A and B converge later.

### Data shapes (unchanged)

Persisted `values` remains `{ messages: AgentMessage[]-ish[], state: Record<string, unknown> }`.
`AgentRequest.state` / `AgentResponse.state` (`types.ts:54,65`) remain `Record<string, unknown>`.
No schema, DDL, or envelope (`ThreadState`) change.

### Not in scope of the implementation (Specification-Trap guard)

The spec does not prescribe loop structure, helper-variable names inside `reduceChannels`, or how
`append` detects arrays — those are implementation choices. The load-bearing contract is the four
bullets above (per-key reduce, retention, reducer-map convention, explicit-null-as-update) plus
level-agnosticism.

## NFR posture

| NFR | Target | How addressed |
|---|---|---|
| Behavior (correctness) | Partial `input.state` across N turns retains all prior keys; multi-turn flow completes with no step regression; full `input.state` still works; absent `input.state` unchanged; `messages` still appends | `reduceChannels` retention rule at all three sites; `messages` append left untouched; explicit unit + integration coverage (see Tests) |
| Backward compat | Persisted `values.{messages,state}` shape UNCHANGED; existing threads keep working; no migration | Merge logic lives inside the blob; no shape, DDL, or contract change |
| Observability | The merge must be debuggable when state behaves unexpectedly | `reduceChannels` is pure and unit-tested in isolation (deterministic, inspectable). At the run path, lg-api already logs run/thread context; no swallowed errors are introduced — if a site receives a non-object `state`, it must log (per project "no silent error swallowing" rule) and fall back to treating it as empty, not silently drop. No new metric is required for a behavior-equivalent persist-side change; the failure signal is the existing run logs plus the test suite. |
| Security | No new external input surface; same trust boundary | No new endpoints or inputs; `input.state`/`params.values` already validated upstream by `RunCreateRequestSchema` / the threads route schema. `reduceChannels` does not eval, clone via unsafe paths, or introduce prototype-pollution vectors — it copies own enumerable keys only. |
| Rollout | Big-bang (single lg-api deploy), low risk | One PR, lg-api-only, behavior-equivalent for the deployed agent on the persist side; the only intended behavior change is "stop wiping siblings on partial input." Ship today. |
| Availability | No change to SLO/redundancy | Pure in-process logic change; no new dependency, no failure mode added. |

Observability is designed here: the merge is isolated in a pure, unit-tested function (the primary
signal), non-object state is logged rather than swallowed, and existing run logs carry the
thread/run correlation. The design is not marked incomplete.

## Reversibility boundaries

| Decision | Reversibility tax | Mitigation / abstraction |
|---|---|---|
| Per-channel merge inside the nested `state` blob (Scenario B over A) | **Low (1–2 days)** | Revert one module + three call sites; persisted data shape never changed, so no rollback migration is possible to need. Old behavior returns exactly. |
| `reduceChannels` placed in its own module `src/agents/state-reducer.ts`, level-agnostic | **Low** | Pure function, no state, importable from anywhere; moving or renaming is a mechanical refactor. The level-agnostic contract is what makes Scenario A cheap, but adopting A is itself a separate, deliberate decision — not locked in here. |
| Reducer-map convention `{ messages: append, default: LastValue }` | **Low** | Convention lives in code, not config; changing the default or adding a per-key reducer is a one-line map edit plus a test. No agent or wire contract depends on it in Scenario B. |
| Keeping `messages` as a separate hand-rolled append (not yet through `reduceChannels`) | **Low** | Deliberately deferred to Scenario A; documented as the convergence seam. Re-routing it later is additive. |

Every entry is Low by design — Scenario B was chosen *because* it is the reversible, no-migration
path. The genuinely high-tax decisions (flatten, contract change, migration) are explicitly the
non-goal Scenario A and are not taken here. This is an intentional "stop the bleeding, keep options
open" change, not an absence of architectural decisions.

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `reduceChannels` mis-handles explicit `null`/`undefined` (treats a deliberate blank as "skip", or vice versa) | Medium | Medium — silent data correctness bug | Contract pins "presence in `updates` decides"; dedicated unit test asserts explicit-null replaces |
| Touching the manual `POST /state` path changes a behavior some caller relied on (wholesale replace) | Low | Medium | Reset is still expressible (send every key); test the manual path for both partial-merge and full-replace; note in PR |
| A future state value is a *nested object* a caller expects to deep-merge | Low | Low | `LastValue` is shallow-by-key by design and matches canonical LangGraph; deep-merge is explicitly not a goal — documented so callers send the full sub-object |
| Non-object `state` arrives (malformed client) and the merge throws or silently empties | Low | Low | Sites coerce a non-object to `{}` and **log** (no silent swallow); covered by a guard test |
| Scenario A reuse assumption proves wrong (engine needs reshaping for top-level) | Low | Low | Engine is level-agnostic by contract; if A still needs changes, the Low tax means cheap rework — no lock-in cost incurred now |

(Risks are not "none" — the correctness-of-merge-semantics risks are the real ones and are pinned by
the contract + tests.)

## Open questions

- **Should the manual `POST /threads/:id/state` path merge, or stay wholesale-replace?** The brief
  mandates merge for consistency and to reuse the engine. Resolution: it merges in B as specified;
  if an external client genuinely depends on wholesale-replace via that endpoint, surface it before
  release — *would resolve by:* checking whether any caller uses `POST /state` for a hard reset, or
  confirming reset-via-send-all-keys is acceptable. No evidence today that any client uses it for
  reset.
- **Is `messages` ever sent inside `input.state`?** If a client put `messages` inside `state`, the
  reducer map's `messages: append` would matter at the `state` level too. Today `messages` is a
  sibling of `state`, not inside it (research §4.3), so the convention is harmless. *Would resolve
  by:* a test asserting `state.messages` (if ever present) is not silently treated specially in B
  unless intended.
- **Does any consumer rely on the SSE `values` payload reflecting full state?** Out of scope here
  (research §7), tracked separately. Not load-bearing for this change.

## Extracted ADRs

The reviewer was asked, for each non-obvious decision, "would a reader six months from now wonder
why this was chosen?" Assessment:

- "Per-channel merge inside the nested blob, not flatten" and "introduce a level-agnostic reducer
  engine now" are the candidate non-obvious decisions. They have a real alternative (Design B /
  Scenario A) and a reader may ask why. **However, this lite spec already records the why-this /
  why-not-B rationale and the Reversibility Boundaries inline, and the upstream research (§6) already
  documents the B-then-A sequencing decision with citations.** Given the ship-today constraint and
  that the rationale is captured, the recommended resolution is to document inline (done) and
  optionally promote to a `design-NNN` / ADR after shipping if the team wants a permanent record.

Because the orchestrator runs this step autonomously and the rationale is fully captured here, no
blocking ADR pause is raised. If you want a standalone, durable decision record, run `/adr` for
"per-channel merge over flatten (Scenario B before A)" as a follow-up — it is recommended but not
required to ship.
