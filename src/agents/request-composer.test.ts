import { describe, it, expect } from 'vitest';
import { RequestComposer } from './request-composer.js';

describe('RequestComposer', () => {
  const composer = new RequestComposer();

  const baseParams = {
    threadId: 'thread-1',
    runId: 'run-1',
    assistantId: 'assistant-1',
  };

  describe('message content normalization', () => {
    it('handles string content', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [{ role: 'user', content: 'hello' }],
        },
      });
      expect(result.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('handles array content with text blocks', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [
            {
              type: 'human',
              content: [{ type: 'text', text: 'hello there' }],
            },
          ],
        },
      });
      expect(result.messages).toEqual([{ role: 'user', content: 'hello there' }]);
    });

    it('handles array content with multiple text blocks', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [
            {
              type: 'human',
              content: [
                { type: 'text', text: 'first line' },
                { type: 'text', text: 'second line' },
              ],
            },
          ],
        },
      });
      expect(result.messages).toEqual([
        { role: 'user', content: 'first line\nsecond line' },
      ]);
    });

    it('extracts only text blocks from mixed content', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [
            {
              type: 'human',
              content: [
                { type: 'image_url', image_url: 'http://example.com/img.png' },
                { type: 'text', text: 'describe this image' },
              ],
            },
          ],
        },
      });
      expect(result.messages).toEqual([
        { role: 'user', content: 'describe this image' },
      ]);
    });

    it('drops messages with empty array content', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [{ type: 'human', content: [] }],
        },
      });
      expect(result.messages).toEqual([]);
    });

    it('drops messages with array content containing no text blocks', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [
            {
              type: 'human',
              content: [
                { type: 'image_url', image_url: 'http://example.com/img.png' },
              ],
            },
          ],
        },
      });
      expect(result.messages).toEqual([]);
    });

    it('drops messages with non-string non-array content', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [{ role: 'user', content: 123 }],
        },
      });
      expect(result.messages).toEqual([]);
    });
  });

  describe('message type mapping', () => {
    it('maps role-based format (user/assistant/system)', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'system', content: 'be helpful' },
          ],
        },
      });
      expect(result.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'system', content: 'be helpful' },
      ]);
    });

    it('maps LangGraph type-based format', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [
            { type: 'human', content: 'hello' },
            { type: 'ai', content: 'hi' },
            { type: 'system', content: 'be helpful' },
          ],
        },
      });
      expect(result.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'system', content: 'be helpful' },
      ]);
    });

    it('maps LangGraph chunk types', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [
            { type: 'HumanMessageChunk', content: 'hello' },
            { type: 'AIMessageChunk', content: 'hi' },
          ],
        },
      });
      expect(result.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);
    });

    it('drops messages with unknown type', async () => {
      const result = await composer.composeRequest({
        ...baseParams,
        input: {
          messages: [{ type: 'unknown', content: 'hello' }],
        },
      });
      expect(result.messages).toEqual([]);
    });
  });
});
