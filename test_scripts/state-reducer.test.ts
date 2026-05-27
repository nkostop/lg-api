/**
 * Unit tests for the per-channel state reducer.
 *
 * Pins the load-bearing contract: per-key LastValue reduction, retention of
 * keys absent from the update, explicit-null-as-replacement, the messages
 * append reducer, purity, and non-object input handling (warn, never throw).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  reduceChannels,
  DEFAULT_CHANNEL_REDUCERS,
} from '../src/agents/state-reducer.js';

describe('reduceChannels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges a partial update over prev, retaining sibling keys', () => {
    const prev = { user_id: 'u1', organization_name: 'DEH', amount: 50 };
    const result = reduceChannels(prev, { amount: 75 });
    expect(result).toEqual({ user_id: 'u1', organization_name: 'DEH', amount: 75 });
  });

  it('LastValue replaces a key when the update provides it', () => {
    const result = reduceChannels({ step: 'collect_amount' }, { step: 'confirm' });
    expect(result.step).toBe('confirm');
  });

  it('treats an explicit null in the update as a replacement, not a skip', () => {
    const prev = { payment_code: 'ABC123' };
    const result = reduceChannels(prev, { payment_code: null });
    expect(result).toHaveProperty('payment_code', null);
    expect(result.payment_code).toBeNull();
  });

  it('treats an explicit undefined in the update as a replacement (presence decides)', () => {
    const prev = { comment: 'old' };
    const result = reduceChannels(prev, { comment: undefined });
    // The key is present in updates, so it is reduced via LastValue → undefined.
    expect('comment' in result).toBe(true);
    expect(result.comment).toBeUndefined();
  });

  it('retains keys present in prev but absent from updates', () => {
    const prev = { a: 1, b: 2, c: 3 };
    const result = reduceChannels(prev, { b: 20 });
    expect(result).toEqual({ a: 1, b: 20, c: 3 });
  });

  it('adds new keys that exist only in updates', () => {
    const result = reduceChannels({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('is pure: does not mutate prev or updates', () => {
    const prev = { a: 1, b: 2 };
    const updates = { b: 20 };
    const prevSnapshot = { ...prev };
    const updatesSnapshot = { ...updates };
    reduceChannels(prev, updates);
    expect(prev).toEqual(prevSnapshot);
    expect(updates).toEqual(updatesSnapshot);
  });

  describe('with a reducer map', () => {
    it('messages reducer appends arrays (prev ++ update)', () => {
      const prev = { messages: [{ id: 1 }] };
      const updates = { messages: [{ id: 2 }, { id: 3 }] };
      const result = reduceChannels(prev, updates, DEFAULT_CHANNEL_REDUCERS);
      expect(result.messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    it('append tolerates a non-array / absent prior by treating it as empty', () => {
      const result = reduceChannels({}, { messages: [{ id: 1 }] }, DEFAULT_CHANNEL_REDUCERS);
      expect(result.messages).toEqual([{ id: 1 }]);
    });

    it('append tolerates a non-array update by treating it as empty', () => {
      const result = reduceChannels(
        { messages: [{ id: 1 }] },
        { messages: 'not-an-array' },
        DEFAULT_CHANNEL_REDUCERS,
      );
      expect(result.messages).toEqual([{ id: 1 }]);
    });

    it('keys without a custom reducer still use LastValue', () => {
      const result = reduceChannels(
        { messages: [{ id: 1 }], amount: 10 },
        { messages: [{ id: 2 }], amount: 20 },
        DEFAULT_CHANNEL_REDUCERS,
      );
      expect(result.messages).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.amount).toBe(20);
    });
  });

  describe('non-object inputs (warn, never throw)', () => {
    it('treats a null prev as {} and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = reduceChannels(null as unknown as Record<string, unknown>, { a: 1 });
      expect(result).toEqual({ a: 1 });
      expect(warn).toHaveBeenCalled();
    });

    it('treats a null update as {} and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = reduceChannels({ a: 1 }, null as unknown as Record<string, unknown>);
      expect(result).toEqual({ a: 1 });
      expect(warn).toHaveBeenCalled();
    });

    it('treats an array prev as {} and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = reduceChannels([1, 2] as unknown as Record<string, unknown>, { a: 1 });
      expect(result).toEqual({ a: 1 });
      expect(warn).toHaveBeenCalled();
    });

    it('treats a primitive update as {} and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = reduceChannels({ a: 1 }, 'oops' as unknown as Record<string, unknown>);
      expect(result).toEqual({ a: 1 });
      expect(warn).toHaveBeenCalled();
    });

    it('does not throw when both inputs are non-objects', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() =>
        reduceChannels(
          undefined as unknown as Record<string, unknown>,
          undefined as unknown as Record<string, unknown>,
        ),
      ).not.toThrow();
    });

    it('returns a fresh object even when both inputs are empty', () => {
      const prev = {};
      const result = reduceChannels(prev, {});
      expect(result).toEqual({});
      expect(result).not.toBe(prev);
    });
  });
});

describe('DEFAULT_CHANNEL_REDUCERS', () => {
  it('exposes a messages append reducer and nothing else', () => {
    expect(Object.keys(DEFAULT_CHANNEL_REDUCERS)).toEqual(['messages']);
    expect(typeof DEFAULT_CHANNEL_REDUCERS.messages).toBe('function');
  });
});
