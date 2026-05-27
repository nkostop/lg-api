/**
 * RunsService - Business logic for run management.
 *
 * Handles run lifecycle: creation, status transitions, cancellation,
 * deletion, waiting, and streaming. Coordinates with ThreadsRepository
 * to manage thread status (busy/idle) during run execution.
 *
 * Wired to the agent execution pipeline: resolves assistants, composes
 * agent requests, executes agents via AgentExecutor, and updates thread
 * state with agent responses.
 */

import type { Static } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { RunsRepository, Run } from './runs.repository.js';
import { ThreadsRepository, Thread } from '../threads/threads.repository.js';
import { RunStreamEmitter } from './runs.streaming.js';
import { StreamManager } from '../../streaming/stream-manager.js';
import { AgentExecutor } from '../../agents/agent-executor.js';
import { AssistantResolver } from '../../agents/assistant-resolver.js';
import { RequestComposer } from '../../agents/request-composer.js';
import { reduceChannels } from '../../agents/state-reducer.js';
import type { AgentResponse, StreamEvent as AgentStreamEvent } from '../../agents/types.js';
import type { RunStatus, StreamMode } from '../../types/index.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';
import { ApiError } from '../../errors/api-error.js';
import type {
  RunCreateRequestSchema,
  ListRunsQuerySchema,
  CancelRunRequestSchema,
  BulkCancelRunsRequestSchema,
} from '../../schemas/run.schema.js';

type RunCreateRequest = Static<typeof RunCreateRequestSchema>;
type ListRunsQuery = Static<typeof ListRunsQuerySchema>;
type CancelRunRequest = Static<typeof CancelRunRequestSchema>;
type BulkCancelRunsRequest = Static<typeof BulkCancelRunsRequestSchema>;

export class RunsService {
  private streamManager: StreamManager;
  private streamEmitter: RunStreamEmitter;

  constructor(
    private runsRepository: RunsRepository,
    private threadsRepository: ThreadsRepository,
    private agentExecutor: AgentExecutor,
    private assistantResolver: AssistantResolver,
    private requestComposer: RequestComposer,
  ) {
    this.streamManager = new StreamManager();
    this.streamEmitter = new RunStreamEmitter(this.streamManager);
  }

  /**
   * Create a stateful run (associated with a thread).
   * Resolves the assistant, composes the agent request, executes the agent,
   * and updates thread state with the response.
   */
  async createStateful(threadId: string, request: RunCreateRequest): Promise<Run> {
    // Verify thread exists (or create on the fly if `if_not_exists: "create"`).
    await this.ensureThread(threadId, request.if_not_exists);

    // Resolve assistant early so the run record stores the real UUID
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const run: Run = {
      run_id: generateId(),
      thread_id: threadId,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    const created = await this.runsRepository.create(run.run_id, run);

    // Set thread to busy
    await this.threadsRepository.update(threadId, {
      status: 'busy',
      updated_at: nowISO(),
    });

    // Execute agent in background (non-blocking)
    setImmediate(async () => {
      try {
        // Get thread state for conversation history
        let currentState: Record<string, unknown> = { values: {} };
        try {
          const threadState = await this.threadsRepository.getState(threadId);
          if (threadState) {
            currentState = threadState as unknown as Record<string, unknown>;
          }
        } catch {
          // Default to empty state if no state exists
        }

        // Compose agent request
        const agentRequest = await this.requestComposer.composeRequest({
          threadId,
          runId: run.run_id,
          assistantId: assistant.assistant_id,
          input: (request.input as Record<string, unknown>) ?? {},
          threadState: currentState,
          metadata: request.metadata ?? {},
        });

        // Set run to running
        await this.runsRepository.update(run.run_id, {
          status: 'running',
          updated_at: nowISO(),
        });

        // Execute agent
        const agentResponse = await this.agentExecutor.execute(assistant.graph_id, agentRequest);

        // Update thread state with response messages
        await this.updateThreadState(threadId, request, agentResponse, currentState);

        // Set run to success
        await this.runsRepository.update(run.run_id, {
          status: 'success',
          updated_at: nowISO(),
        });

        // Set thread to idle
        await this.threadsRepository.update(threadId, {
          status: 'idle',
          updated_at: nowISO(),
        });
      } catch (error: unknown) {
        // Set run to error
        try {
          await this.runsRepository.update(run.run_id, {
            status: 'error',
            updated_at: nowISO(),
          });
          await this.threadsRepository.update(threadId, {
            status: 'idle',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }
    });

    return created;
  }

  /**
   * Create a stateless run (no thread association).
   * Resolves the assistant, composes the request, and executes the agent.
   */
  async createStateless(request: RunCreateRequest): Promise<Run> {
    // Resolve assistant early so the run record stores the real UUID
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const run: Run = {
      run_id: generateId(),
      thread_id: null,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    const created = await this.runsRepository.create(run.run_id, run);

    // Execute agent in background (non-blocking)
    setImmediate(async () => {
      try {
        const agentRequest = await this.requestComposer.composeRequest({
          threadId: run.run_id, // Use run_id as pseudo thread_id for stateless
          runId: run.run_id,
          assistantId: assistant.assistant_id,
          input: (request.input as Record<string, unknown>) ?? {},
          metadata: request.metadata ?? {},
        });

        await this.runsRepository.update(run.run_id, {
          status: 'running',
          updated_at: nowISO(),
        });

        await this.agentExecutor.execute(assistant.graph_id, agentRequest);

        await this.runsRepository.update(run.run_id, {
          status: 'success',
          updated_at: nowISO(),
        });
      } catch {
        try {
          await this.runsRepository.update(run.run_id, {
            status: 'error',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }
    });

    return created;
  }

  /**
   * Batch create multiple stateless runs.
   */
  async createBatch(requests: RunCreateRequest[]): Promise<Run[]> {
    const runs: Run[] = [];
    for (const request of requests) {
      const run = await this.createStateless(request);
      runs.push(run);
    }
    return runs;
  }

  /**
   * Get a specific run by thread ID and run ID.
   */
  async get(threadId: string, runId: string): Promise<Run> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }
    return run;
  }

  /**
   * List runs for a thread with pagination and optional status filtering.
   */
  async list(
    threadId: string,
    query: ListRunsQuery,
  ): Promise<{ items: Run[]; total: number; offset: number; limit: number }> {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;

    const filters: Record<string, unknown> = {};
    if (query.status) {
      filters.status = query.status;
    }

    const result = await this.runsRepository.listByThreadId(threadId, {
      limit,
      offset,
      sortBy: 'created_at',
      sortOrder: 'desc',
      ...filters,
    });

    return {
      items: result.items,
      total: result.total,
      offset,
      limit,
    };
  }

  /**
   * Cancel a specific run.
   */
  async cancel(
    threadId: string,
    runId: string,
    _request: CancelRunRequest,
  ): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    if (run.status === 'success' || run.status === 'error') {
      throw new ApiError(409, `Run ${runId} is already in terminal state: ${run.status}`);
    }

    await this.runsRepository.update(runId, {
      status: 'interrupted',
      updated_at: nowISO(),
    });

    // Restore thread to idle
    await this.threadsRepository.update(threadId, {
      status: 'idle',
      updated_at: nowISO(),
    });
  }

  /**
   * Bulk cancel runs matching the given criteria.
   */
  async bulkCancel(request: BulkCancelRunsRequest): Promise<void> {
    const filters: Record<string, unknown> = {};
    if (request.thread_id) filters.thread_id = request.thread_id;
    if (request.status) filters.status = request.status;

    // If specific run IDs are provided, cancel those
    if (request.run_ids && request.run_ids.length > 0) {
      for (const runId of request.run_ids) {
        const run = await this.runsRepository.getById(runId);
        if (run && run.status !== 'success' && run.status !== 'error') {
          await this.runsRepository.update(runId, {
            status: 'interrupted',
            updated_at: nowISO(),
          });
        }
      }
      return;
    }

    // Otherwise, search by filters and cancel matching runs
    const result = await this.runsRepository.search(
      { limit: 1000, offset: 0 },
      filters,
    );

    for (const run of result.items) {
      if (run.status !== 'success' && run.status !== 'error') {
        await this.runsRepository.update(run.run_id, {
          status: 'interrupted',
          updated_at: nowISO(),
        });
      }
    }
  }

  /**
   * Join a run: wait for it to reach a terminal state and return it.
   */
  async join(threadId: string, runId: string): Promise<Run> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    // Poll for completion if still in progress
    if (run.status === 'pending' || run.status === 'running') {
      const maxWait = 120_000; // 2 minutes max
      const pollInterval = 500;
      let waited = 0;

      while (waited < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        waited += pollInterval;

        const updated = await this.runsRepository.getById(runId);
        if (updated && updated.status !== 'pending' && updated.status !== 'running') {
          return updated;
        }
      }

      // Return whatever state we have after timeout
      const finalCheck = await this.runsRepository.getById(runId);
      if (finalCheck) return finalCheck;
    }

    return run;
  }

  /**
   * Delete a run.
   */
  async delete(threadId: string, runId: string): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    const deleted = await this.runsRepository.delete(runId);
    if (!deleted) {
      throw new ApiError(404, `Run ${runId} not found`);
    }
  }

  /**
   * Wait for a run: creates a run, executes the agent synchronously,
   * and returns the result with agent response messages.
   */
  async wait(
    threadId: string | null,
    request: RunCreateRequest,
  ): Promise<{ run_id: string; thread_id: string | null; status: RunStatus; result: Record<string, unknown> }> {
    // Resolve assistant
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const runId = generateId();

    // Create run record with resolved assistant UUID
    const run: Run = {
      run_id: runId,
      thread_id: threadId,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    await this.runsRepository.create(run.run_id, run);

    try {
      // Get thread state if stateful
      let currentState: Record<string, unknown> = { values: {} };
      if (threadId) {
        // Verify thread exists (or create on the fly if `if_not_exists: "create"`).
        await this.ensureThread(threadId, request.if_not_exists);

        // Set thread to busy
        await this.threadsRepository.update(threadId, {
          status: 'busy',
          updated_at: nowISO(),
        });

        try {
          const threadState = await this.threadsRepository.getState(threadId);
          if (threadState) {
            currentState = threadState as unknown as Record<string, unknown>;
          }
        } catch {
          // Default to empty state
        }
      }

      // Compose agent request
      const agentRequest = await this.requestComposer.composeRequest({
        threadId: threadId ?? runId,
        runId,
        assistantId: assistant.assistant_id,
        input: (request.input as Record<string, unknown>) ?? {},
        threadState: threadId ? currentState : undefined,
        metadata: request.metadata ?? {},
      });

      // Set run to running
      await this.runsRepository.update(runId, {
        status: 'running',
        updated_at: nowISO(),
      });

      // Execute agent synchronously
      const agentResponse = await this.agentExecutor.execute(assistant.graph_id, agentRequest);

      // Update thread state if stateful
      if (threadId) {
        await this.updateThreadState(threadId, request, agentResponse, currentState);

        // Set thread to idle
        await this.threadsRepository.update(threadId, {
          status: 'idle',
          updated_at: nowISO(),
        });
      }

      // Set run to success
      await this.runsRepository.update(runId, {
        status: 'success',
        updated_at: nowISO(),
      });

      return {
        run_id: runId,
        thread_id: threadId,
        status: 'success' as RunStatus,
        result: {
          messages: agentResponse.messages.map((m) => ({
            type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
            content: m.content,
            id: generateId(),
            ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
          })),
        },
      };
    } catch (error: unknown) {
      // Set run to error
      await this.runsRepository.update(runId, {
        status: 'error',
        updated_at: nowISO(),
      });

      // Restore thread to idle if stateful
      if (threadId) {
        try {
          await this.threadsRepository.update(threadId, {
            status: 'idle',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }

      throw error;
    }
  }

  /**
   * Stream a run: creates a run and streams SSE events to the client
   * using real agent execution via the AgentExecutor.
   */
  async streamRun(
    threadId: string | null,
    request: RunCreateRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Resolve assistant
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const runId = generateId();

    // Create run record with resolved assistant UUID
    const run: Run = {
      run_id: runId,
      thread_id: threadId,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    await this.runsRepository.create(run.run_id, run);

    // Set thread to busy if stateful (auto-create if `if_not_exists: "create"`).
    if (threadId) {
      await this.ensureThread(threadId, request.if_not_exists);
      await this.threadsRepository.update(threadId, {
        status: 'busy',
        updated_at: nowISO(),
      });
    }

    try {
      // Get thread state if stateful
      let currentState: Record<string, unknown> = { values: {} };
      if (threadId) {
        try {
          const threadState = await this.threadsRepository.getState(threadId);
          if (threadState) {
            currentState = threadState as unknown as Record<string, unknown>;
          }
        } catch {
          // Default to empty state
        }
      }

      // Compose agent request
      const agentRequest = await this.requestComposer.composeRequest({
        threadId: threadId ?? runId,
        runId,
        assistantId: assistant.assistant_id,
        input: (request.input as Record<string, unknown>) ?? {},
        threadState: threadId ? currentState : undefined,
        metadata: request.metadata ?? {},
      });

      // Set run to running
      await this.runsRepository.update(run.run_id, {
        status: 'running',
        updated_at: nowISO(),
      });

      // Execute agent once, update thread state, then emit SSE events from the response.
      // This avoids the double-execution problem and ensures /history is available
      // immediately after the stream completes.
      const agentResponse = await this.agentExecutor.execute(assistant.graph_id, agentRequest);

      // Update thread state before streaming so /history is ready when the UI queries it
      if (threadId) {
        await this.updateThreadState(threadId, request, agentResponse, currentState);
      }

      // Read the full thread state (updated above) for the values event
      const updatedState = threadId
        ? await this.threadsRepository.getState(threadId)
        : null;
      const allMessages = (updatedState?.['values'] as Record<string, unknown>)?.['messages'] as unknown[] ?? [];

      // Emit SSE events: values has full thread state
      async function* responseToStream(): AsyncGenerator<AgentStreamEvent> {
        yield { event: 'metadata', data: { run_id: runId, thread_id: threadId } };
        yield {
          event: 'values',
          data: { messages: allMessages },
        };
        yield { event: 'end', data: null };
      }
      await this.streamEmitter.streamFromAgent(reply, run, responseToStream());

      // Set run to success
      await this.runsRepository.update(run.run_id, {
        status: 'success',
        updated_at: nowISO(),
      });

      // Set thread to idle if stateful
      if (threadId) {
        await this.threadsRepository.update(threadId, {
          status: 'idle',
          updated_at: nowISO(),
        });
      }
    } catch (error: unknown) {
      // Set run to error
      try {
        await this.runsRepository.update(run.run_id, {
          status: 'error',
          updated_at: nowISO(),
        });
      } catch {
        // Swallow cleanup errors
      }

      // Set thread to idle if stateful
      if (threadId) {
        try {
          await this.threadsRepository.update(threadId, {
            status: 'idle',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }

      throw error;
    }
  }

  /**
   * Join a run's stream: reconnect to an existing run's SSE stream.
   */
  async joinStream(
    threadId: string,
    runId: string,
    reply: FastifyReply,
    streamModes?: StreamMode[],
    lastEventId?: string,
  ): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    // Check if there is an existing session for replay
    if (lastEventId) {
      const existingSession = this.streamManager.getSession(runId);
      if (existingSession) {
        // Replay missed events via PassThrough so Fastify CORS plugin applies
        const { PassThrough } = await import('node:stream');
        const sseStream = new PassThrough();
        reply
          .code(200)
          .header('Content-Type', 'text/event-stream')
          .header('Cache-Control', 'no-cache')
          .header('Connection', 'keep-alive')
          .header('X-Accel-Buffering', 'no')
          .header('Content-Location', `/threads/${threadId}/runs/${runId}`)
          .send(sseStream);

        const missed = this.streamManager.getEventsAfter(runId, lastEventId);
        for (const event of missed) {
          sseStream.write(`event: ${event.event}\ndata: ${event.data}\nid: ${event.id}\n\n`);
        }
        sseStream.end();
        return;
      }
    }

    // No existing session: the run already completed and the session expired.
    // Emit the final state from thread history so the client gets the result.
    const currentState = await this.threadsRepository.getState(threadId);
    const stateValues = (currentState?.['values'] as Record<string, unknown>) ?? {};
    const messages = (stateValues['messages'] as unknown[]) ?? [];

    async function* completedRunStream(): AsyncGenerator<AgentStreamEvent> {
      yield { event: 'metadata', data: { run_id: runId, thread_id: threadId } };
      yield { event: 'values', data: { messages } };
      yield { event: 'end', data: null };
    }
    await this.streamEmitter.streamFromAgent(reply, run, completedRunStream());
  }

  /**
   * Update thread state with agent response messages.
   * Appends input messages and response messages to the existing conversation history.
   */
  private async updateThreadState(
    threadId: string,
    request: RunCreateRequest,
    agentResponse: AgentResponse,
    currentState: Record<string, unknown>,
  ): Promise<void> {
    const stateValues = (currentState?.['values'] as Record<string, unknown>) ?? {};
    const existingMessages = (stateValues['messages'] as unknown[]) || [];
    const inputMessages = ((request.input as Record<string, unknown>)?.['messages'] as unknown[]) || [];
    const responseMessages = agentResponse.messages.map((m) => ({
      type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
      content: m.content,
      id: generateId(),
      ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
    }));
    const allMessages = [...existingMessages, ...inputMessages, ...responseMessages];

    const now = nowISO();
    // Persist the agent's returned state at the **top level** of `values`
    // (LangGraph's canonical "input keys = graph state" convention), so it
    // round-trips as inherited state on the next run's compose. The agent
    // returns a full snapshot today; folding it into the prior top-level
    // `values` per-channel (default LastValue) keeps the persist side
    // partial-update-safe — a key the response omits is retained, not wiped.
    // `messages` stay a separate manual append (above) and overwrite last;
    // they are never routed through the state reduce.
    const reducedValues = agentResponse.state
      ? reduceChannels(stateValues, agentResponse.state)
      : { ...stateValues };
    const newValues = {
      ...reducedValues,
      messages: allMessages,
    };

    // Write to state history (used by getState for next run's context)
    await this.threadsRepository.addState(threadId, {
      values: newValues,
      next: [],
      checkpoint: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: generateId(),
      },
      metadata: { source: 'run' },
      created_at: now,
      parent_checkpoint: (currentState?.['checkpoint'] as { thread_id: string; checkpoint_ns: string; checkpoint_id: string } | null) ?? null,
      tasks: [],
    });

    // Also update the thread entity's values
    await this.threadsRepository.update(threadId, {
      values: newValues,
      updated_at: now,
    });
  }

  /**
   * Look up the thread referenced by a run request. If the thread does not
   * exist, honor the run body's `if_not_exists` field — matching the real
   * LangGraph Platform contract:
   *   - "create"  → create the thread on the fly with the given id and return it.
   *   - "reject"  → throw 404 (default; matches real LangGraph).
   *   - undefined → treated as "reject".
   *
   * Centralized here so createStateful / wait / streamRun all share the same
   * semantics. See Issues - Pending Items.md (LG-IF-NOT-EXISTS) for context.
   */
  private async ensureThread(
    threadId: string,
    ifNotExists: 'create' | 'reject' | undefined,
  ): Promise<Thread> {
    const existing = await this.threadsRepository.getById(threadId);
    if (existing) {
      return existing;
    }
    if (ifNotExists === 'create') {
      const now = nowISO();
      const thread: Thread = {
        thread_id: threadId,
        created_at: now,
        updated_at: now,
        metadata: {},
        status: 'idle',
        values: {},
      };
      return this.threadsRepository.create(threadId, thread);
    }
    throw new ApiError(404, `Thread ${threadId} not found`);
  }
}
