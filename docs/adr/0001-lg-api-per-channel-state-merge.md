---
type: adr
id: 0001-lg-api-per-channel-state-merge
slug: lg-api-per-channel-state-merge
number: 0001
date: 2026-05-27
status: accepted
produced_by: adr-capturer
authors: [Zisis Flokas]
consumes:
  - /Users/zisisflokas/projects/agents/lg-api/artifacts/specs/lg-api-state-per-channel-merge.md
related:
  spec: /Users/zisisflokas/projects/agents/lg-api/artifacts/specs/lg-api-state-per-channel-merge.md
  code:
    - src/agents/request-composer.ts
    - src/modules/runs/runs.service.ts
    - src/modules/threads/threads.service.ts
  supersedes: none
  superseded_by: none
quality_gates:
  - real-alternative-documented: pass
  - consequences-split-both-directions: pass
  - reversibility-tax-named-with-rationale: pass
  - sequential-numbering-no-gaps: pass
pause_points_hit: []
reversibility_tax: low
---

# 0001 — Fix lg-api state-overwrite with a per-channel merge inside the nested state blob (Scenario B), not a flatten (Scenario A)

## Context

lg-api (a TypeScript reimplementation of the LangGraph Platform server) overwrites stored thread
state wholesale whenever a run carries `input.state`. `request-composer.ts` `extractState()` returns
`input.state` verbatim when present ("Explicit state from input takes priority… No merging"), so a
client that re-sends only a partial `input.state` — for example just `{ user_id }` — causes the
agent to receive a thin state object, seed defaults onto it, and return it as the full snapshot,
which `runs.service.ts` `updateThreadState` then persists over the prior `values.state` blob. Every
sibling field is silently wiped and the conversational agent regresses to an earlier step. The same
wholesale-overwrite shape exists on the manual `POST /threads/:id/state` path
(`threads.service.ts` `updateState`). This already caused a production regression in payments-agent.

This diverges from canonical LangGraph, which reduces each input key into its own channel (default
`LastValue`), appends `messages`, and **retains** keys absent from the input. Notably, lg-api already
hand-rolls exactly one reducer today: it reads `values.messages`, appends input + response messages,
and writes the concatenation — an `add_messages` reducer for a single channel. The fix is the direct
generalization of code that already exists.

The decision is being made now because the bug is live and shipping today matters. Two real forces
pull in opposite directions: the desire for full LangGraph SDK/wire parity (which argues for
flattening agent state to top-level channels — "Scenario A") versus the need for a small, reversible,
agent-release-free, migration-free fix that stops the production data loss immediately. Compounding
this, there is no recorded decision for why lg-api uses a nested opaque `state` blob in the first
place — it fell out of an "agent owns its state" framing in design-004, never a considered rejection
of channel-merging. Whoever reads the merge code in six months will reasonably ask why it merges
inside a nested blob rather than over flat top-level channels, and why the manual `POST /state` path
was touched at all. This ADR records that answer.

## Decision

Fix the state-overwrite bug with a **per-channel merge applied inside the existing nested `state`
blob (Scenario B)**, implemented as a single **pure, level-agnostic** util
`reduceChannels(prev, updates, reducers?)` in a new module `src/agents/state-reducer.ts`. The
convention is `{ messages: append, default: LastValue }`: for every key present in `updates`, apply
that key's reducer (default `LastValue` = replace); every key in `prev` absent from `updates` is
carried through unchanged; presence in `updates` (not truthiness) decides whether a key is reduced,
so an explicit `null` is a real update, not a skip.

Wire `reduceChannels` into all three current overwrite sites:

- `request-composer.ts` `extractState` — when `input.state` is present, return
  `reduceChannels(storedState ?? {}, input.state)` instead of the raw input; absent → unchanged.
- `runs.service.ts` `updateThreadState` — fold `agentResponse.state` into the prior `values.state`
  rather than wholesale-replacing the `state` key.
- `threads.service.ts` `updateState` — per-channel reduce the incoming `params.values.state` into
  the current `values.state` instead of wholesale replace.

The existing top-level `messages` append stays as-is for now; it is the documented seam where
Scenario A and Scenario B converge later. Flattening state to top-level channels (Scenario A) is
**deferred to a separate milestone**.

## Alternatives considered

### A. Inline shallow-merge at the one bug site only (rejected)
Patch just `extractState` to return `{ ...storedState, ...input.state }` — smallest possible diff,
no shared util, no module. Rejected because it leaves the manual `POST /threads/:id/state` overwrite
unfixed (a client editing state directly would still wipe siblings), and because an anonymous shallow
spread cannot express `messages`-style append, encodes the merge as an ad-hoc operation rather than a
named, tested `LastValue`-per-key semantic, and throws away the one thing that makes the work
compound: a reusable engine for Scenario A. It would also duplicate merge logic the moment a second
site needs it — which is now.

### B. Scenario A now — flatten agent state to top-level channels with schema-driven routing (deferred, not rejected on merit)
The full LangGraph-parity fix: lift agent business keys to top-level `values` channels, route by a
per-agent declared state schema with reducers, and reduce each channel canonically. Deferred for now
because it requires a coordinated lg-api + agent-engine + payments-agent change, a per-agent state
schema, a reserved-key strategy (`messages` is a hard collision; `documents`/`metadata`/`state` are
soft reservations), and a dual-read migration of already-persisted nested-`state` threads — far too
much to ship under today's time pressure. Its headline payoff, true LangGraph SDK/Studio wire
compatibility, is currently an unverified live need: no stock SDK client is confirmed in production
against this server. Scenario B is deliberately designed to make Scenario A cheap later by leaving
behind the reusable, level-agnostic engine.

### C. Do nothing — document that the client must always send full state (rejected)
Treat the wipe as a contract requirement ("always re-send the complete `input.state`"). Rejected:
brittle, places a correctness burden on every caller, and has already caused a production regression.

## Consequences

**Easier:**
- The production state-wipe is fixed with an lg-api-only change — no agent release, no connector
  contract change, no thread migration.
- Every overwrite path is fixed at once (run-input compose, run-output persist, manual `POST /state`),
  not just the reported symptom.
- The merge semantics become a single pure, unit-testable function (`LastValue`-per-key, retention,
  append channel, explicit-null-as-update) instead of ad-hoc spreads scattered across call sites.
- Scenario A becomes a re-wire rather than a rewrite: the level-agnostic `reduceChannels` engine is
  the exact piece A reuses verbatim; the `messages` special-case and the state-blob merge collapse
  into a single channel-reduce over `values` under A.

**Harder:**
- The nested `state` blob is retained, so lg-api still diverges from canonical LangGraph's flat
  top-level channels and the SDK wire shape; full parity is deferred, not achieved.
- The reducer convention is hard-coded in code (`LastValue`-except-`messages`) rather than declared
  by a per-agent schema/registry; adding a non-`messages` append channel later means editing the map.
- The diff is larger than a one-line patch (new module + three call sites + tests), and it touches
  the manual `POST /state` path, which is not strictly required to fix the reported run-path
  regression — a broader blast radius, mitigated by tests.

**What we now must accept:**
- A reducer-map concept exists from now on while being only minimally exercised in Scenario B
  (`messages` is not yet routed through it) — a small amount of forward-looking surface.
- `LastValue` is shallow-by-key: a caller who wants to update a nested object must send the full
  sub-object (deep-merge is explicitly not a goal, matching canonical LangGraph).
- Full-state reset is now expressed as "send every key" rather than "replace the whole blob"; any
  caller that relied on `POST /state` for a hard wholesale replace must adopt that idiom.

## Reversibility tax

**Cost of undoing:** Low

Reverting means deleting one module (`src/agents/state-reducer.ts`) and restoring three call sites in
`request-composer.ts`, `runs.service.ts`, and `threads.service.ts`. The persisted thread shape
(`values = { messages, state }`) never changes, so there is no rollback migration that could even be
needed — the old wholesale-overwrite behavior returns exactly. This was the deciding property: Scenario
B was chosen *because* it is the reversible, no-migration "stop the bleeding, keep options open" path.
The genuinely high-tax decisions (flatten, connector-contract change, thread migration) belong to the
deferred Scenario A and are deliberately not taken here.

## References

- Linked spec: /Users/zisisflokas/projects/agents/lg-api/artifacts/specs/lg-api-state-per-channel-merge.md
- Linked research: /Users/zisisflokas/projects/agents/lg-api/artifacts/research/2026-05-27-lg-api-flat-state-channels.md
- Linked code: src/agents/request-composer.ts (extractState ~:229-251), src/modules/runs/runs.service.ts (updateThreadState ~:743), src/modules/threads/threads.service.ts (updateState ~:282-323)
- Related ADRs: none (this is 0001; the deferred Scenario A is a future ADR/milestone)
