/**
 * RunStreamEmitter - SSE event generation for run streaming.
 *
 * Generates and emits realistic stub SSE events for each supported
 * stream mode, writing directly to the raw HTTP response.
 */

import { PassThrough, type Writable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { StreamManager, StreamEvent, StreamSession } from '../../streaming/stream-manager.js';
import type { StreamMode } from '../../types/index.js';
import type { Run } from './runs.repository.js';
import type { StreamEvent as AgentStreamEvent } from '../../agents/types.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';

/**
 * Small delay helper to simulate real-time streaming (50ms between events).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RunStreamEmitter {
  constructor(private streamManager: StreamManager) {}

  /**
   * Stream SSE events for a run to the client.
   *
   * Sets SSE headers, emits metadata, mode-specific events, and an end event.
   * Writes directly to reply.raw (Node.js http.ServerResponse).
   */
  async streamRun(
    reply: FastifyReply,
    run: Run,
    streamModes: StreamMode[],
    lastEventId?: string,
  ): Promise<void> {
    // Set SSE headers via Fastify so CORS plugin headers are included,
    // then send a PassThrough stream to keep the connection open.
    const contentLocation = run.thread_id
      ? `/threads/${run.thread_id}/runs/${run.run_id}`
      : `/runs/${run.run_id}`;
    const sseStream = new PassThrough();
    reply
      .code(200)
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .header('Content-Location', contentLocation)
      .send(sseStream);

    const session = this.streamManager.createSession(
      run.run_id,
      run.thread_id,
      streamModes,
    );

    // Handle reconnection: replay missed events
    if (lastEventId) {
      const missed = this.streamManager.getEventsAfter(
        run.run_id,
        lastEventId,
      );
      for (const event of missed) {
        this.writeEvent(sseStream, event);
      }
      sseStream.end();
      return;
    }

    try {
      // 1. Emit metadata event
      await this.emit(sseStream, session, 'metadata', {
        run_id: run.run_id,
        thread_id: run.thread_id,
      });

      await delay(50);

      // 2. Emit mode-specific stub events
      for (const mode of streamModes) {
        await this.emitModeEvent(sseStream, session, mode, run);
        await delay(50);
      }

      // 3. Emit end event
      await this.emit(sseStream, session, 'end', null);
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unknown streaming error';
      await this.emit(sseStream, session, 'error', { message });
    } finally {
      this.streamManager.closeSession(run.run_id);
      sseStream.end();
    }
  }

  /**
   * Emit a mode-specific stub event based on the requested stream mode.
   */
  private async emitModeEvent(
    stream: Writable,
    session: StreamSession,
    mode: StreamMode,
    run: Run,
  ): Promise<void> {
    switch (mode) {
      case 'values':
        await this.emit(stream, session, 'values', {
          messages: [
            {
              type: 'ai',
              content: 'This is a stub response from the LG-API server.',
              id: generateId(),
            },
          ],
        });
        break;

      case 'updates':
        await this.emit(stream, session, 'updates', {
          agent: {
            messages: [
              {
                type: 'ai',
                content: 'Stub update from agent node.',
                id: generateId(),
              },
            ],
          },
        });
        break;

      case 'messages':
        await this.emit(stream, session, 'messages', [
          {
            type: 'AIMessageChunk',
            content: 'Stub message chunk.',
            id: generateId(),
          },
        ]);
        break;

      case 'messages-tuple':
        await this.emit(stream, session, 'messages/partial', [
          ['ai', { content: 'Stub tuple message.', id: generateId() }],
        ]);
        break;

      case 'events':
        await this.emit(stream, session, 'events', {
          event: 'on_chain_end',
          name: 'agent',
          run_id: run.run_id,
          data: { output: {} },
        });
        break;

      case 'debug':
        await this.emit(stream, session, 'debug', {
          type: 'task_result',
          timestamp: nowISO(),
          step: 1,
          payload: {},
        });
        break;

      case 'custom':
        await this.emit(stream, session, 'custom', {
          type: 'stub_custom_event',
          data: {},
        });
        break;

      case 'tasks':
        await this.emit(stream, session, 'tasks', {
          task_id: generateId(),
          name: 'agent',
          status: 'completed',
          result: {},
        });
        break;

      case 'checkpoints':
        await this.emit(stream, session, 'checkpoints', {
          thread_id: run.thread_id,
          checkpoint_ns: '',
          checkpoint_id: generateId(),
        });
        break;
    }
  }

  /**
   * Emit a single SSE event: buffer it in the session and write to the response.
   */
  private async emit(
    stream: Writable,
    session: StreamSession,
    event: string,
    data: unknown,
  ): Promise<void> {
    session.lastEventId++;
    const streamEvent: StreamEvent = {
      event,
      data: JSON.stringify(data),
      id: String(session.lastEventId),
    };
    session.eventBuffer.push(streamEvent);
    this.writeEvent(stream, streamEvent);
  }

  /**
   * Stream real agent events from an AsyncGenerator to the client via SSE.
   *
   * Sets SSE headers, creates a stream session, iterates over agent events,
   * buffers them for replay support, and writes them to the raw response.
   *
   * @param reply - The Fastify reply to write SSE events to
   * @param run - The run associated with this stream
   * @param agentStream - AsyncGenerator of StreamEvents from the agent executor
   */
  async streamFromAgent(
    reply: FastifyReply,
    run: Run,
    agentStream: AsyncGenerator<AgentStreamEvent>,
  ): Promise<void> {
    // Set SSE headers via Fastify so CORS plugin headers are included,
    // then send a PassThrough stream to keep the connection open.
    const contentLocation = run.thread_id
      ? `/threads/${run.thread_id}/runs/${run.run_id}`
      : `/runs/${run.run_id}`;
    const sseStream = new PassThrough();
    reply
      .code(200)
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .header('Content-Location', contentLocation)
      .send(sseStream);

    const session = this.streamManager.createSession(run.run_id, run.thread_id, []);

    try {
      for await (const agentEvent of agentStream) {
        session.lastEventId++;
        const streamEvent: StreamEvent = {
          event: agentEvent.event,
          data: JSON.stringify(agentEvent.data),
          id: String(session.lastEventId),
        };
        session.eventBuffer.push(streamEvent);
        this.writeEvent(sseStream, streamEvent);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown streaming error';
      session.lastEventId++;
      const errorEvent: StreamEvent = {
        event: 'error',
        data: JSON.stringify({ message }),
        id: String(session.lastEventId),
      };
      session.eventBuffer.push(errorEvent);
      this.writeEvent(sseStream, errorEvent);
    } finally {
      this.streamManager.closeSession(run.run_id);
      sseStream.end();
    }
  }

  /**
   * Get the underlying StreamManager instance (for joinStream replay).
   */
  getStreamManager(): StreamManager {
    return this.streamManager;
  }

  /**
   * Write a single SSE event to the raw HTTP response in standard SSE format.
   */
  private writeEvent(stream: Writable, event: StreamEvent): void {
    stream.write(`event: ${event.event}\ndata: ${event.data}\nid: ${event.id}\n\n`);
  }
}
