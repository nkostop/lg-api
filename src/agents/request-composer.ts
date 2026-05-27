/**
 * Request Composer
 *
 * Builds an AgentRequest from the lg-api run context. Gathers conversation
 * history from thread state, new user messages from run input, and optional
 * documents. Returns a complete AgentRequest ready for the CLI connector.
 */

import type { AgentRequest, AgentMessage, AgentDocument } from './types.js';
import { reduceChannels } from './state-reducer.js';

/**
 * Parameters for composing an agent request.
 */
export interface ComposeRequestParams {
  threadId: string;
  runId: string;
  assistantId: string;
  input: Record<string, unknown>;
  threadState?: Record<string, unknown>;
  /**
   * The run's own metadata, forwarded to the agent as-is. Metadata is never
   * derived from `input` keys — under the canonical convention those keys are
   * graph state, not metadata.
   */
  metadata?: Record<string, unknown>;
}

export class RequestComposer {
  /**
   * Build an AgentRequest from a run's context.
   *
   * Message gathering logic:
   * 1. Extract conversation history from threadState.values.messages (if present)
   * 2. Extract new user messages from input.messages
   * 3. Combine history + new messages in chronological order
   * 4. Extract documents from input.documents (if present)
   */
  async composeRequest(params: ComposeRequestParams): Promise<AgentRequest> {
    const { threadId, runId, assistantId, input, threadState, metadata } = params;

    const messages: AgentMessage[] = [];

    // 1. Gather conversation history from thread state
    if (threadState) {
      const historyMessages = this.extractMessagesFromState(threadState);
      messages.push(...historyMessages);
    }

    // 2. Gather new messages from run input
    const inputMessages = this.extractMessagesFromInput(input);
    messages.push(...inputMessages);

    // 3. Gather documents from run input
    const documents = this.extractDocumentsFromInput(input);

    // 4. Gather graph state from thread state and input (canonical convention:
    //    every key other than messages/documents IS a graph-state channel).
    const state = this.extractState(input, threadState);

    const request: AgentRequest = {
      thread_id: threadId,
      run_id: runId,
      assistant_id: assistantId,
      messages,
    };

    if (documents.length > 0) {
      request.documents = documents;
    }

    if (state && Object.keys(state).length > 0) {
      request.state = state;
    }

    // 5. Forward the run's metadata as-is (supplied by the caller, never
    //    derived from input keys).
    if (metadata && Object.keys(metadata).length > 0) {
      request.metadata = metadata;
    }

    return request;
  }

  /**
   * Extract conversation history messages from thread state.
   *
   * Expects threadState.values.messages to be an array of objects with
   * at least a `type` (or `role`) and `content` field. Maps LangGraph
   * message types to the agent message role format.
   */
  private extractMessagesFromState(threadState: Record<string, unknown>): AgentMessage[] {
    const values = threadState['values'] as Record<string, unknown> | undefined;
    if (!values) {
      return [];
    }

    const rawMessages = values['messages'] as unknown[];
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    return rawMessages
      .map((msg) => this.normalizeMessage(msg))
      .filter((msg): msg is AgentMessage => msg !== null);
  }

  /**
   * Extract new messages from run input.
   *
   * Expects input.messages to be an array of message objects.
   */
  private extractMessagesFromInput(input: Record<string, unknown>): AgentMessage[] {
    const rawMessages = input['messages'] as unknown[];
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    return rawMessages
      .map((msg) => this.normalizeMessage(msg))
      .filter((msg): msg is AgentMessage => msg !== null);
  }

  /**
   * Normalize a raw message object into an AgentMessage.
   *
   * Handles both LangGraph-style messages (type: 'human'/'ai'/'system')
   * and standard role-based messages (role: 'user'/'assistant'/'system').
   */
  private normalizeMessage(raw: unknown): AgentMessage | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const msg = raw as Record<string, unknown>;
    const rawContent = msg['content'];
    let content: string;
    if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      // LangGraph content blocks: [{"type": "text", "text": "hello"}, ...]
      content = rawContent
        .filter(
          (block): block is Record<string, unknown> =>
            block !== null &&
            typeof block === 'object' &&
            typeof (block as Record<string, unknown>)['text'] === 'string',
        )
        .map((block) => block['text'] as string)
        .join('\n');
      if (!content) return null;
    } else {
      return null;
    }

    // Try role-based format first
    const role = msg['role'] as string | undefined;
    if (role === 'user' || role === 'assistant' || role === 'system') {
      return { role, content };
    }

    // Try LangGraph type-based format
    const type = msg['type'] as string | undefined;
    if (type) {
      const mappedRole = this.mapTypeToRole(type);
      if (mappedRole) {
        return { role: mappedRole, content };
      }
    }

    return null;
  }

  /**
   * Map a LangGraph message type to an agent message role.
   */
  private mapTypeToRole(type: string): AgentMessage['role'] | null {
    switch (type.toLowerCase()) {
      case 'human':
      case 'humanmessage':
      case 'humanmessagechunk':
        return 'user';
      case 'ai':
      case 'aimessage':
      case 'aimessagechunk':
        return 'assistant';
      case 'system':
      case 'systemmessage':
        return 'system';
      default:
        return null;
    }
  }

  /**
   * Extract documents from run input.
   *
   * Expects input.documents to be an array of document objects,
   * each with at least an `id` and `content` field.
   */
  private extractDocumentsFromInput(input: Record<string, unknown>): AgentDocument[] {
    const rawDocs = input['documents'] as unknown[];
    if (!Array.isArray(rawDocs)) {
      return [];
    }

    return rawDocs
      .filter((doc): doc is Record<string, unknown> => doc !== null && typeof doc === 'object')
      .filter((doc) => typeof doc['id'] === 'string' && typeof doc['content'] === 'string')
      .map((doc) => {
        const document: AgentDocument = {
          id: doc['id'] as string,
          content: doc['content'] as string,
        };
        if (typeof doc['title'] === 'string') {
          document.title = doc['title'] as string;
        }
        if (doc['metadata'] && typeof doc['metadata'] === 'object') {
          document.metadata = doc['metadata'] as Record<string, unknown>;
        }
        return document;
      });
  }

  /**
   * Extract the graph state to pass to the agent, following LangGraph's
   * canonical "the input *is* the state" convention.
   *
   * The graph state lives at the **top level** of `threadState.values` (minus
   * the framework-owned `messages` and `documents` channels). A run's `input`
   * carries state updates the same way — any key other than `messages` /
   * `documents` is a state channel.
   *
   * Resolution (per-channel `LastValue`, via the shared reduce engine):
   * 1. Inherit the stored state = `values` minus `messages`/`documents`.
   * 2. Fold the input's state keys on top — each input key replaces that
   *    channel; every inherited key the input omits is retained (the
   *    sibling-wipe fix, now at the flattened top level).
   * 3. Return `undefined` when the merged state is empty.
   *
   * There is no `input.state` special-casing: a literal `state` key is just
   * another channel, so a legacy caller that nested under `input.state` now
   * sees `{ state: {...} }` and breaks loudly — by design.
   */
  private extractState(
    input: Record<string, unknown>,
    threadState?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const values = (threadState?.['values'] as Record<string, unknown>) ?? {};
    const inheritedState = this.stripReservedChannels(values);
    const inputState = this.stripReservedChannels(input);

    const merged = reduceChannels(inheritedState, inputState);
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Strip the framework-owned channels (`messages`, `documents`) from a record,
   * leaving only graph-state channels. Returns a shallow copy — never mutates
   * the input.
   */
  private stripReservedChannels(
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'messages' && key !== 'documents') {
        result[key] = value;
      }
    }
    return result;
  }
}
