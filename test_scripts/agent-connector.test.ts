/**
 * Integration test for the CLI Agent Connector.
 *
 * Tests that require LLM API keys are skipped when env vars are not set.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import { CliAgentConnector } from '../src/agents/cli-connector.js';
import { RequestComposer } from '../src/agents/request-composer.js';
import type { AgentRequest, StreamEvent } from '../src/agents/types.js';

const hasAzureKeys = !!(
    process.env['AZURE_OPENAI_API_KEY'] &&
    process.env['AZURE_OPENAI_ENDPOINT'] &&
    process.env['AZURE_OPENAI_DEPLOYMENT']
);

describe('Agent Registry', () => {
  it('should load the agent registry and find the passthrough agent', () => {
    const registry = new AgentRegistry();
    const config = registry.getAgentConfig('passthrough');
    expect(config).not.toBeNull();
    expect(config!.type).toBe('cli');
    if (config!.type === 'cli') {
      expect(config!.command).toBe('npx');
    }
  });

  it('should return null for unknown graph_id', () => {
    const registry = new AgentRegistry();
    const config = registry.getAgentConfig('nonexistent-agent');
    expect(config).toBeNull();
  });
});

describe('Request Composer', () => {
  it('should compose a request from input and thread state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      assistantId: 'asst-1',
      input: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'Previous message' },
            { role: 'assistant', content: 'Previous response' },
          ],
        },
      },
    });

    expect(request.thread_id).toBe('thread-1');
    expect(request.run_id).toBe('run-1');
    expect(request.messages.length).toBe(3);
    const contents = request.messages.map(m => m.content);
    expect(contents).toContain('Previous message');
    expect(contents).toContain('Previous response');
    expect(contents).toContain('Hello');
  });

  it('should handle input with documents', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      assistantId: 'asst-1',
      input: {
        messages: [{ role: 'user', content: 'About the doc?' }],
        documents: [
          { id: 'doc-1', title: 'Test', content: 'Test content' },
        ],
      },
    });

    expect(request.documents).toBeDefined();
    expect(request.documents!.length).toBe(1);
    expect(request.documents![0].id).toBe('doc-1');
  });
});

describe('Request Composer - Graph State (canonical convention)', () => {
  it('treats input keys (minus messages/documents) as graph state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      assistantId: 'asst-1',
      input: {
        messages: [{ role: 'user', content: 'Hello' }],
        step: 'kyc',
        attempts: 2,
      },
    });

    // messages are NOT state; every other input key is.
    expect(request.state).toEqual({ step: 'kyc', attempts: 2 });
  });

  it('returns undefined state when input carries only messages', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
    });

    expect(request.state).toBeUndefined();
  });

  it('inherits thread-state values (minus messages/documents) as state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      assistantId: 'asst-1',
      input: {
        messages: [{ role: 'user', content: 'Next turn' }],
      },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'I want a mortgage' },
            { role: 'assistant', content: 'What is your tax ID?' },
          ],
          language: 'en',
          tax_id: '123456789',
          memory: { collected: { name: 'John' } },
        },
        checkpoint: { thread_id: 'thread-1', checkpoint_ns: '', checkpoint_id: 'cp-1' },
      },
    });

    expect(request.state).toEqual({
      language: 'en',
      tax_id: '123456789',
      memory: { collected: { name: 'John' } },
    });
    expect(request.state).not.toHaveProperty('messages');
  });

  it('never includes documents in the inherited state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Previous' }],
          documents: [{ id: 'd1', content: 'doc' }],
          workflow_step: 3,
        },
      },
    });

    expect(request.state).toEqual({ workflow_step: 3 });
    expect(request.state).not.toHaveProperty('documents');
  });

  it('returns undefined state when thread values hold only messages', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Hello' }],
        },
      },
    });

    expect(request.state).toBeUndefined();
  });

  it('lets input keys override inherited thread-state keys (input wins)', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: {
        messages: [{ role: 'user', content: 'Hi' }],
        step: 'verification',
      },
      threadState: {
        values: {
          messages: [],
          step: 'kyc',
          language: 'en',
        },
      },
    });

    // `step` is overridden by input; `language` is inherited (retained).
    expect(request.state).toEqual({ step: 'verification', language: 'en' });
  });

  it('handles threadState with no values key', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {},
    });

    expect(request.state).toBeUndefined();
  });

  it('carries flat graph state across multiple turns', async () => {
    const composer = new RequestComposer();

    // Turn 2: thread values carry flat agent state from turn 1.
    const turn2 = await composer.composeRequest({
      threadId: 't1',
      runId: 'r2',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'My tax ID is 123' }] },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'Start mortgage' },
            { role: 'assistant', content: 'What is your tax ID?' },
          ],
          workflow_step: 1,
          collected_fields: ['language'],
        },
      },
    });

    expect(turn2.state).toEqual({
      workflow_step: 1,
      collected_fields: ['language'],
    });

    // Turn 3: thread values carry the updated flat state from turn 2.
    const turn3 = await composer.composeRequest({
      threadId: 't1',
      runId: 'r3',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Yes, confirm' }] },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'Start mortgage' },
            { role: 'assistant', content: 'What is your tax ID?' },
            { role: 'user', content: 'My tax ID is 123' },
            { role: 'assistant', content: 'Confirm?' },
          ],
          workflow_step: 2,
          collected_fields: ['language', 'tax_id'],
          tax_id: '123',
        },
      },
    });

    expect(turn3.state).toEqual({
      workflow_step: 2,
      collected_fields: ['language', 'tax_id'],
      tax_id: '123',
    });
  });

  it('treats a literal `state` key as a plain channel (legacy callers break loudly)', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: {
        messages: [{ role: 'user', content: 'Hi' }],
        state: { x: 1 },
      },
    });

    // No `input.state` special-casing: the nested object lands under a `state`
    // channel instead of being unwrapped — the documented hard-cut behavior.
    expect(request.state).toEqual({ state: { x: 1 } });
  });
});

describe('Request Composer - Metadata', () => {
  it('forwards the run metadata param as-is', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      metadata: { source: 'api', tenant: 'acme' },
    });

    expect(request.metadata).toEqual({ source: 'api', tenant: 'acme' });
  });

  it('never derives metadata from input keys', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      // `step` is a state channel now, NOT metadata.
      input: { messages: [{ role: 'user', content: 'Hi' }], step: 'kyc' },
    });

    expect(request.metadata).toBeUndefined();
    expect(request.state).toEqual({ step: 'kyc' });
  });

  it('omits metadata when the param is empty', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      metadata: {},
    });

    expect(request.metadata).toBeUndefined();
  });
});

/**
 * These tests verify the state boundary under the canonical convention: graph
 * state lives at the TOP LEVEL of `values` (every key except the framework-owned
 * `messages` / `documents` channels). Framework channels never leak into state,
 * and a root-level `state` outside `values` is ignored.
 */
describe('Request Composer - State Boundary Assumptions', () => {
  it('reads all top-level value keys as state, stripping only messages/documents', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Previous' }],  // framework — stripped
          documents: [{ id: 'd1', content: 'doc' }],          // framework — stripped
          workflow_step: 2,                                    // graph state
          language: 'en',                                      // graph state
        },
      },
    });

    expect(request.state).toEqual({ workflow_step: 2, language: 'en' });
    expect(request.state).not.toHaveProperty('messages');
    expect(request.state).not.toHaveProperty('documents');
  });

  it('returns undefined state when values hold only framework channels', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Previous' }],
          documents: [{ id: 'd1', content: 'doc' }],
        },
      },
    });

    expect(request.state).toBeUndefined();
  });

  it('ignores a root-level `state` outside `values`', async () => {
    // Graph state is read only from threadState.values; a sibling `state` at the
    // root of threadState is not a value channel and must be ignored.
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        state: { workflow_step: 5 },          // root-level — ignored
        values: {
          messages: [],
          workflow_step: 10,                   // values channel — authoritative
        },
      },
    });

    expect(request.state).toEqual({ workflow_step: 10 });
  });
});

describe('CLI Agent Connector', () => {
  let registry: AgentRegistry;
  let connector: CliAgentConnector;

  beforeAll(() => {
    registry = new AgentRegistry();
    connector = new CliAgentConnector();
  });

  it.skipIf(!hasAzureKeys)(
      'should execute the passthrough agent and get a response',
      async () => {
        const config = registry.getAgentConfig('passthrough')!;
        const request: AgentRequest = {
          thread_id: 'test-thread',
          run_id: 'test-run',
          assistant_id: 'test-asst',
          messages: [
            { role: 'user', content: 'What is 1+1? Reply with just the number.' },
          ],
        };

        const response = await connector.execute(config, request);

        expect(response).toBeDefined();
        expect(response.thread_id).toBe('test-thread');
        expect(response.run_id).toBe('test-run');
        expect(response.messages).toBeDefined();
        expect(response.messages.length).toBeGreaterThan(0);
        expect(response.messages[0].role).toBe('assistant');
        expect(response.messages[0].content).toBeTruthy();
      },
      30000,
  );

  it.skipIf(!hasAzureKeys)(
      'should stream events from the passthrough agent',
      async () => {
        const config = registry.getAgentConfig('passthrough')!;
        const request: AgentRequest = {
          thread_id: 'test-thread',
          run_id: 'test-run',
          assistant_id: 'test-asst',
          messages: [
            { role: 'user', content: 'Say hello in one word.' },
          ],
        };

        const events: StreamEvent[] = [];
        for await (const event of connector.stream(config, request)) {
          events.push(event);
        }

        expect(events.length).toBeGreaterThan(0);
        const eventTypes = events.map(e => e.event);
        expect(eventTypes).toContain('metadata');
        expect(eventTypes).toContain('end');
      },
      30000,
  );

  it('should throw for unknown agent', async () => {
    const fakeConfig = { type: 'cli' as const, command: 'nonexistent-cmd-xyz', args: [], cwd: '.', timeout: 5000 };
    const request: AgentRequest = {
      thread_id: 'test',
      run_id: 'test',
      assistant_id: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(
        connector.execute(fakeConfig, request),
    ).rejects.toThrow();
  });
});
