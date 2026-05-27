---
kind: workflow-run
slug: lg-api-flat-state-channels
date: 2026-05-27
status: in-progress
classification: feature-design
chain:
  - deep-dive-investigator
  - need-framer
  - spec-writer
  - adr-capturer
consumes: []
produces:
  - artifacts/research/<ts>-lg-api-flat-state-channels.md
  - artifacts/needs/2026-05-27-lg-api-flat-state-channels.md
  - artifacts/specs/lg-api-flat-state-channels.md
  - docs/adr/NNNN-lg-api-flat-state-channels.md
---

# Workflow Run — lg-api flat state channels + per-channel merge

## Original request

> We are actively contributing to the lg-api project so we could resolve both issues
> on that level. We came across the issue with state key in the past but for some reason
> we didn't change the state to be moved flat.
>
> Please capture need and spec and ADR and capture also what would be the impact to apply
> both changes to lg-api and how it would affect the deployed agent, would those keys clash
> with keys that lg-api may use, review the state of the project in depth
> /Users/zisisflokas/projects/agents/lg-api

## Background (carried from prior investigation in payments-agent)

Two coupled issues in lg-api's thread-state model (vs canonical LangGraph per-channel reduction):

1. **Single nested `state` blob channel** — all agent state is crammed into one `state`
   object rather than flat top-level channels each with its own reducer.
   (`src/modules/runs/runs.service.ts` `updateThreadState`: `newValues = { ...stateValues,
   messages: allMessages, ...(agentResponse.state ? { state: agentResponse.state } : {}) }`.)
2. **Whole-object overwrite on input** — `src/agents/request-composer.ts` `extractState()`
   returns `input.state` as-is when present, replacing stored state. No merge.

Net effect: a client that re-sends a partial `input.state` (e.g. just `{user_id}`) every
turn wipes all sibling state → engine step regresses. Research artifact (canonical LangGraph
comparison, HIGH confidence) lives in the payments-agent repo at
`artifacts/research/2026-05-27-langgraph-state-overwrite-vs-merge-investigation.md`.

Target fix: mirror LangGraph — flatten state to top-level channels + apply per-channel
reducers (default LastValue) so partial input updates only named keys.

## Classification

- **Class:** feature-design (framework state-model change)
- **Chain:** deep-dive review of lg-api → need → spec → ADR.

## Sequence planned

1. `deep-dive-investigator` — in-depth lg-api review: state model end-to-end, reserved
   `input`/`values` keys, key-clash analysis for flattening, impact on deployed agents,
   why flat was previously avoided. → research artifact.
2. `need-framer` — frame the need. → need artifact.
3. `spec-writer` — two designs, impact, NFRs, reversibility, key-clash handling. → spec.
4. `adr-capturer` — capture the decision. → ADR.

## Run log per step

### Step 1 — deep-dive-investigator
- Status: complete (confidence: HIGH on code facts; MODERATE on "why-not-flat" motive)
- Artifact: `artifacts/research/2026-05-27-lg-api-flat-state-channels.md`
- Key findings:
  - Both bugs live in `src/agents/request-composer.ts` (`extractState` overwrite) +
    `src/modules/runs/runs.service.ts:743` (nested `state` blob). Storage is a single JSON
    blob column → flattening keys *inside* it needs no DDL migration.
  - **Change B (per-channel merge) is the safe surgical fix — ship FIRST.** lg-api-only,
    fixes the wipe, zero change to deployed payments-agent or other agents. It generalizes
    the `messages` append reducer lg-api already hand-rolls (`runs.service.ts:732-740`).
  - **Change A (flatten to top-level `values` channels)** needs: connector-contract change,
    payments-agent backend change (`agent.ts:536-595` reads `request.state`, returns full
    `turn.state`), and a dual-read/lazy migration of already-persisted `values.state`.
  - **Key-clash verdict:** flattening hard-collides on exactly ONE field — `messages` (both
    an agent field and lg-api's append channel). Soft-reserved: `documents`, `metadata`,
    `state`. All business fields (`organization_name`, `payment_code`, …, `_`-prefixed)
    are clash-free. Avoidance: declare reserved set `{messages, documents, state, metadata}`;
    interim, merge *inside* the `state` blob to dodge the clash entirely.
  - SDK compatibility is an intended project goal (`feat/langgraph-platform-compatibility`);
    real LangGraph SDKs send flat `input` / stream flat `values`, so nested `state` is itself
    a divergence — Change A moves toward parity.
  - **Sequencing: B-then-A.**

### Step 2 — need-framer
- Status: cancelled by user. User pivoted: instead of need→spec→ADR, asked for a concrete
  combined-A+B implementation plan + blast radius to make a go/no-go decision first.

### Step 3 — spec-writer
- Status: gated on go/no-go

### Step 4 — adr-capturer
- Status: gated on go/no-go

## Final summary

Run paused after Step 1 (research). Combined A+B plan presented in chat for go/no-go.
need/spec/ADR to follow if the user greenlights.

