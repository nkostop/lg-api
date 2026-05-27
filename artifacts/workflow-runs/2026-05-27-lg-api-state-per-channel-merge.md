---
kind: workflow-run
slug: lg-api-state-per-channel-merge
date: 2026-05-27
status: complete
classification: change-implementation
chain:
  - spec-writer
  - adr-capturer
  - coder
  - pragmatic-reviewer
consumes:
  - artifacts/research/2026-05-27-lg-api-flat-state-channels.md
produces:
  - artifacts/specs/lg-api-state-per-channel-merge.md
  - docs/adr/NNNN-lg-api-state-per-channel-merge.md
  - (code) src/agents/state-reducer.ts + 3 call sites + tests
  - (review) artifacts/reviews/2026-05-27-...md
---

# Workflow Run — lg-api Scenario B: per-channel state merge (ship today)

## Original request

> Proceed to make the changes required for scenario B in order to ship this today,
> proceed with workflow artifacts required to be generated.

## Decision context (settled with user across prior turns)

- **Scenario B = per-channel merge**, lg-api-only, no agent change, no thread migration,
  reversible. Fixes the production wipe bug (partial `input.state` overwriting whole state).
- Build the merge as a **reusable, level-agnostic util** `reduceChannels(prev, updates, reducers)`
  so Scenario A (flatten) later reuses the engine verbatim. Reducer map: `{ messages: append,
  *: LastValue }`, retain keys absent from `updates`.
- Apply at the overwrite sites: PRIMARY `request-composer.extractState` (the bug);
  also `runs.service.updateThreadState` (:743) and `threads.service.updateState` (manual
  `POST /state`) for consistency.
- A (flatten + schema-driven routing) deferred to a separate milestone.

## Classification

- **Class:** change-implementation (bug fix + small framework change)
- **Chain:** spec (lite) → ADR → coder(patch) → pragmatic review. (need/requirements/
  split-work compressed — research artifact + agreed plan already cover them; B is a
  single-PR change.)

## Sequence planned

1. `spec-writer` (lite) — design for B incl. the reusable `reduceChannels` contract. → spec.
2. `adr-capturer` — decision: B-now / A-later, merge-as-util, LastValue-except-messages. → ADR.
3. `coder` (patch) — implement on a branch in lg-api; util + 3 call sites + vitest. → code + report.
4. `pragmatic-reviewer` — review the diff. → review artifact.

## Run log per step

### Step 1 — spec-writer
- Status: complete (lite). Grounded by reading the 3 cited code sites (confirmed verbatim).
- Artifact: `artifacts/specs/lg-api-state-per-channel-merge.md`
- Two designs contrasted: shared `reduceChannels` engine (chosen) vs inline shallow-merge
  (rejected — no reuse toward A, misses manual `POST /state`). Reversibility: all Low.
- Flagged optional `/adr` (doing it) and optional `/design-review` (skipping for ship-today).

### Step 2 — adr-capturer
- Status: complete. ADR-0001 (accepted). Reversibility: Low.
- Artifact: `docs/adr/0001-lg-api-per-channel-state-merge.md`
- Alternatives recorded: inline shallow-merge (rejected), Scenario A flatten (deferred),
  do-nothing (rejected). Spec `related.adrs` cross-referenced.

### Step 3 — coder (patch)
- Status: complete. Branch `feat/per-channel-state-merge`, commit `fb25a2c` (committed, NOT pushed).
- Files: NEW `src/agents/state-reducer.ts` (`reduceChannels` + `DEFAULT_CHANNEL_REDUCERS`);
  wired `request-composer.extractState` (PRIMARY bug fix), `runs.service.updateThreadState`,
  `threads.service.updateState`; +27 tests across 4 suites.
- Tests: 72 passed in the 4 touched suites; `tsc --noEmit` clean. The 8 full-suite failures
  are pre-existing & unrelated (`skill-agent.test.ts` missing `@anthropic-ai/sdk`, verified
  against `main`).
- Behavior change (intentional): manual `POST /threads/:id/state` now MERGES the `state`
  sub-object per-channel (matches LangGraph `update_state`); full reset still expressible by
  sending every key. `reduceChannels` is level-agnostic → ready for Scenario A reuse.

### Step 4 — pragmatic-reviewer
- Status: complete. **Verdict: SAFE TO SHIP TODAY, nothing blocking.** Ran the 4 changed
  suites (72 pass). 0 Critical. 2 Important (comment-only hardening): I1 — `updateState`
  records pre-merge `writes` while persisting merged `values` (mark divergence intentional);
  I2 — `DEFAULT_CHANNEL_REDUCERS` append wired into nothing yet (add call-site comments).
  3 nice-to-have (logger correlation, a messages-LastValue test, shallow-merge docstring).
- Artifact: `artifacts/reviews/2026-05-27-lg-api-state-per-channel-merge.md`

## Final summary

- **Outcome:** Scenario B implemented, tested, reviewed — safe to ship. Branch
  `feat/per-channel-state-merge` (commit `fb25a2c`) in the lg-api repo; not pushed.
- **What shipped:** reusable level-agnostic `reduceChannels` engine + per-channel merge at
  the three overwrite sites; fixes the partial-`input.state` wipe; no agent change, no thread
  migration, reversible (Low tax). One intentional behavior change: manual `POST /state`
  now merges (LangGraph `update_state` parity).
- **Artifacts:** research, spec, ADR-0001, code+tests, review (all in lg-api repo).
- **Open follow-ups:**
  - Optional comment-only hardening (review I1/I2) before PR.
  - Push branch + open PR (left to user).
  - **Deploy reality:** the running docker stack uses the *published* lg-api base image
    (`node /app/dist/index.js`), so this source fix reaches the deployed payments-agent only
    after an lg-api image release. Until then, the payments-agent workaround stands: inject
    `user_id` once per thread (don't re-send partial `input.state`).
  - Pre-existing unrelated red: `skill-agent.test.ts` needs `@anthropic-ai/sdk`.
  - Deferred (separate milestone): Scenario A (flatten + agent-engine-published state schema),
    `metadata` round-trip, SSE `values` payload shape.

