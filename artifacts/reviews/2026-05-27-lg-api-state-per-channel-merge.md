---
type: review
id: 2026-05-27-lg-api-state-per-channel-merge
date: 2026-05-27
reviewer: pragmatic-code-reviewer
target: feat/per-channel-state-merge @ fb25a2c (diff main...HEAD)
consumes:
  - artifacts/specs/lg-api-state-per-channel-merge.md
  - docs/adr/0001-lg-api-per-channel-state-merge.md
  - artifacts/research/2026-05-27-lg-api-flat-state-channels.md
verdict: SAFE TO SHIP (with two recommended follow-ups; none blocking)
---

# Pragmatic review — lg-api per-channel state merge (Scenario B)

## Summary

The change is correct, well-tested, and matches the spec/ADR intent. `reduceChannels` is
pure, level-agnostic, handles explicit `null` as a replacement, retains absent keys, and logs
(rather than swallows) malformed input — every property the brief asked me to scrutinize holds.
The three call sites each merge at the right level, the `messages` append is left untouched, and
`extractState`'s absent-input passthrough is preserved. All 72 tests across the four files pass.
**Decision: ship today.** The only findings are nice-to-have hardening; nothing blocks.

## Critical (0)

None. The merge semantics, purity, and all three wirings are correct.

## Important (2)

### I1. `metadata.writes` in the manual path now records the raw input, not what was actually written — R5 (programming by coincidence) — `src/modules/threads/threads.service.ts:324`
**Finding:** `updateState` now persists `values: mergedValues` (lines 314, 336) but records the
state-history audit field as `metadata: { ..., writes: params.values }` (line 324) — the raw,
pre-merge input. After this change, `writes` no longer equals what landed in `values`: for a
partial update `{ values: { state: { amount: 75 } } }`, `writes` shows only `{ amount: 75 }`
while `values.state` is the full merged blob. In real LangGraph, `metadata.writes` is the delta
(the channel updates), so recording the raw input is arguably *more* correct than recording the
merge — but the divergence between `writes` and `values` is now silent and undocumented, and a
reader debugging state history will not know which one to trust.
**Why it matters:** History/audit consumers (`getHistory`, time-travel/checkpoint replay) read
`writes` to understand what each step changed. The mismatch is a latent confusion that will cost
debugging time the first time someone reconciles `writes` against `values`.
**Recommendation:** Keep `writes: params.values` (the delta is the right thing to record), but add
a one-line comment at line 324 stating that `writes` is the pre-merge delta while `values` is the
post-merge result — make the intentional divergence explicit so it doesn't read as a bug.

### I2. `reduceChannels` is invoked at all three sites WITHOUT the reducer map, so `DEFAULT_CHANNEL_REDUCERS` (the append channel) is dead in Scenario B — R4 (evil-wizard) / R5 — `src/agents/request-composer.ts:246`, `src/modules/runs/runs.service.ts:753`, `src/modules/threads/threads.service.ts:309`
**Finding:** Every call site passes only `(prev, updates)` — the third `reducers` arg defaults to
`{}`. `DEFAULT_CHANNEL_REDUCERS` (the `messages` append) is exported, unit-tested, and wired into
nothing in `src/`. This is intentional per the spec (messages stays a hand-rolled append in
`updateThreadState`, and `state` has no `messages` key), but as written, a future reader sees an
exported, tested append reducer and a function that takes a reducer map, and will reasonably assume
append is active somewhere — it is not.
**Why it matters:** A maintainer could put `messages` *inside* `state` expecting it to append (open
question §"Is messages ever sent inside input.state?" in the spec) and instead get a silent
`LastValue` overwrite of message history — exactly the class of bug this change fixes, reintroduced
one level down. The forward-looking surface is acceptable, but its inertness is not signposted at
the call sites.
**Recommendation:** Add a short comment at each call site stating *why* the map is omitted ("state
blob has no append channels in B; messages is appended separately in updateThreadState"). No code
change needed — this is purely making the deliberate omission legible so it isn't mistaken for a
wiring miss.

## Nice-to-have (3)

### N1. `console.warn` for malformed state diverges from the run path's structured logger — R2 (observability) — `src/agents/state-reducer.ts:52`
**Finding:** The non-object guard logs via `console.warn`. That satisfies the "log, never swallow"
project rule (good), and matches existing `console.*` usage in `app.ts`/`auto-register.ts`, but the
run path it serves uses Fastify's structured/pino logger. A malformed `state` warning will land in
stdout without the run/thread correlation that surrounds it.
**Why it matters:** When a malformed-state warning fires in prod, it will be hard to correlate to a
specific thread/run because `reduceChannels` (correctly, for level-agnosticism) has no request
context. Low impact — this path is "should never happen" — but the signal is weaker than it could be.
**Recommendation:** Leave `reduceChannels` pure and context-free (don't inject a logger — that would
break the level-agnostic contract that is the whole point). Acceptable as-is. If you want the
correlation later, have the *call sites* coerce-and-log with their logger and pass a guaranteed
record in, keeping the engine itself silent. Not worth doing before shipping.

### N2. `messages`-via-LastValue collision risk is untested at the state level — R6a (knowledge duplication of the append rule) — `test_scripts/state-reducer.test.ts`
**Finding:** The spec flags as an open question whether a client could ever send `messages` inside
`state`. Today it cannot (messages is a sibling), but there is no test pinning the *current* truth
that `state.messages`, if it appeared, would be `LastValue`-replaced (because the call sites pass no
reducer map). The append rule for messages now lives in two places conceptually — the hand-rolled
fold in `runs.service.ts:741` and `DEFAULT_CHANNEL_REDUCERS` — and nothing asserts they don't
silently diverge at the `state` level.
**Recommendation:** Add one test asserting `reduceChannels({messages:[a]}, {messages:[b]})` (no map)
returns `{messages:[b]}` (LastValue), documenting that append is *not* active without the map. Pins
the open question as a known, intentional behavior rather than an accident.

### N3. Aliasing: retained nested values are shared by reference between `prev` and result — R3-adjacent / R5 — `src/agents/state-reducer.ts:78`
**Finding:** `result = { ...safePrev }` is a shallow copy. A retained key whose value is an object
(e.g. `_user_accounts: [...]`) is the *same reference* in both the stored blob and the returned
state. The function is pure w.r.t. its own inputs (it never mutates them — verified by test), so
this is correct and matches canonical LangGraph's shallow-by-key semantics. The risk is only if a
*downstream* consumer mutates a retained nested value in place, it would also mutate the stored
blob.
**Why it matters:** Very low — the agent receives the state and returns a fresh snapshot; no current
caller mutates retained sub-objects in place. Worth a one-line docstring note so a future caller
doesn't assume a deep clone.
**Recommendation:** Add to the `reduceChannels` docstring: "shallow copy — retained object values
are shared by reference with `prev`; do not mutate them in place." Documentation only.

## Answers to the five scrutiny points

1. **`reduceChannels` correctness & purity — PASS.** No input mutation (asserted by the purity
   test and the request-composer "does not mutate" test). Explicit `null` replaces under LastValue
   (line 86, tested). Explicit `undefined` also replaces (presence decides — tested). Absent keys
   retained via `{...safePrev}` (line 78). Non-object `prev`/`updates` coerced to `{}` and **warned,
   not swallowed** (`asRecord`, lines 47-57) — note it correctly stays silent on `undefined`
   (the legitimate "no prior state" case) and only warns on null/array/primitive. The `append`
   reducer tolerates non-array/absent on both sides (lines 27-31, tested). No Demeter violation in
   the engine — it touches only its own args.

2. **The three call sites — PASS.** All merge at the `values.state` level (request-composer:246,
   runs.service:753, threads.service:309). `extractState` passes stored state through unchanged when
   `input.state` is absent (request-composer:251-253) and the empty-`{}` merge result is correctly
   suppressed downstream by the `Object.keys(state).length > 0` guard at composeRequest:68, so no
   spurious empty `state` is sent. `updateThreadState` leaves the top-level `messages` append fully
   untouched (runs.service:733-741,752) and only changed the `state` fold. The manual `POST /state`
   merge is the documented, intended behavior change (ADR Consequences "What we now must accept");
   non-`state` top-level `values` keys pass through via `...params.values` (threads.service:307) —
   no accidental semantic shift to messages or other keys.

3. **Reuse claim — PASS.** `state-reducer.ts` references no `values`, `.state`, or thread shape; it
   operates on `Record<string, unknown>` + a reducer map. The lg-api-specific knowledge ("state
   lives at values.state") stays entirely in the call sites. Scenario A can call
   `reduceChannels(values, updates, DEFAULT_CHANNEL_REDUCERS)` on the top-level object verbatim. No
   leaked coupling.

4. **Edge cases — PASS.** Merge is shallow per-channel: a nested object value is replaced wholesale,
   NOT deep-merged (line 86; matches LangGraph, deep-merge correctly avoided). `agentResponse.state
   === undefined` → no `state` key written (runs.service:753 guard preserved). Aliasing of retained
   nested values is by reference (N3) — correct and matching LangGraph, documented as a nit.

5. **Test adequacy — STRONG.** The regression the old code caused is directly asserted:
   request-composer.test "retaining siblings", runs.test "retains prior keys when a later turn sends
   only a partial input.state" (the integration-level wipe fix across compose+persist), and
   threads.test "merges the state sub-object per-channel, retaining siblings". Explicit-null replace
   is tested (state-reducer.test). Absent-input passthrough is tested (request-composer.test "passes
   stored state through unchanged"). Manual full-reset path is tested (threads.test "still supports a
   full reset by sending every key"). Purity, non-object guards (null/array/primitive/both),
   empty-input freshness, and the append reducer are all covered. Only high-value gap: N2 (pin
   `state.messages` is LastValue without a map).

## Rubrics with no findings

- **R1 (Design by Contract):** `reduceChannels`'s contract is documented in the docstring and
  enforced by `asRecord`; pre/postconditions match what callers assume. Clean.
- **R6b/c/d (non-orthogonality, outdated knowledge, performance):** The change *reduces*
  non-orthogonality (one engine replaces three ad-hoc spreads). No stale domain fact. Complexity is
  O(keys) over a small state object — no hot-path concern. Clean.

## Out-of-scope note

`updateThreadState` (runs.service.ts:732) still does NOT persist `agentResponse.metadata` back into
`values` — flagged in research §7 as a known adjacent gap and explicitly a non-goal here. Not
introduced by this change; mentioning only so it isn't mistaken for something this PR regressed.
