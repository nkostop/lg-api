/**
 * Deterministic smoke for LG-STATE-CANONICAL.
 *
 * Drives RequestComposer.composeRequest through every row of the behavior
 * matrix in the change plan and asserts the produced `state`. No network / no
 * LLM keys required — this exercises the state-passing logic in isolation.
 *
 * Run: npx tsx test_scripts/smoke-state-canonical.ts
 */
import { RequestComposer } from '../src/agents/request-composer.js';

const composer = new RequestComposer();
const base = { threadId: 't', runId: 'r', assistantId: 'a' };

type Row = {
  label: string;
  input: Record<string, unknown>;
  threadState?: Record<string, unknown>;
  expected: Record<string, unknown> | undefined;
};

const rows: Row[] = [
  {
    label: 'input messages only -> undefined',
    input: { messages: [{ role: 'user', content: 'hi' }] },
    expected: undefined,
  },
  {
    label: 'input { messages, step } -> { step }',
    input: { messages: [{ role: 'user', content: 'hi' }], step: 'kyc' },
    expected: { step: 'kyc' },
  },
  {
    label: 'input { messages, state:{x:1} } -> { state:{x:1} } (legacy breaks loudly)',
    input: { messages: [{ role: 'user', content: 'hi' }], state: { x: 1 } },
    expected: { state: { x: 1 } },
  },
  {
    label: 'thread values { messages, step } + new messages -> inherited { step }',
    input: { messages: [{ role: 'user', content: 'new' }] },
    threadState: { values: { messages: [{ role: 'user', content: 'old' }], step: 'kyc' } },
    expected: { step: 'kyc' },
  },
  {
    label: 'thread values { step } + input { step } -> input wins',
    input: { messages: [{ role: 'user', content: 'hi' }], step: 'verification' },
    threadState: { values: { step: 'kyc' } },
    expected: { step: 'verification' },
  },
];

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let failures = 0;
for (const row of rows) {
  const req = await composer.composeRequest({ ...base, input: row.input, threadState: row.threadState });
  const ok = eq(req.state, row.expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${row.label}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(row.expected)}`);
    console.log(`      actual:   ${JSON.stringify(req.state)}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
if (failures > 0) throw new Error(`${failures} smoke row(s) failed`);
