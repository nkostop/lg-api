/**
 * Per-channel state reducer.
 *
 * A pure, level-agnostic generalization of LangGraph's default channel
 * reduction: each key in an update is folded into its own channel, and any
 * key present in the prior record but absent from the update is retained.
 *
 * This is the single merge engine shared by every lg-api state-overwrite
 * site (run-input compose, run-output persist, manual `POST /state`). It knows
 * nothing about `values`, `.state`, or any thread shape — callers pass whatever
 * record they want reduced. That level-agnosticism is load-bearing: a future
 * flatten (Scenario A) reuses this exact engine on the top-level `values`
 * object with no edit here.
 */

/**
 * A channel reducer folds a prior channel value and an incoming update value
 * into the new channel value. The default reducer is `LastValue` (replace).
 */
export type ChannelReducer = (prev: unknown, update: unknown) => unknown;

/**
 * Append reducer: concatenate the prior array with the update array.
 * Matches the hand-rolled `messages` append in runs.service. Tolerates a
 * non-array / absent prior or update by treating it as an empty array.
 */
const append: ChannelReducer = (prev, update) => {
  const prevArr = Array.isArray(prev) ? prev : [];
  const updateArr = Array.isArray(update) ? update : [];
  return [...prevArr, ...updateArr];
};

/**
 * Default reducer map. `messages` appends; every other key falls back to
 * `LastValue`. Forward-looking for Scenario A — Scenario B's call sites operate
 * on the `state` blob (which has no `messages` key), but the engine supports it.
 */
export const DEFAULT_CHANNEL_REDUCERS: Record<string, ChannelReducer> = {
  messages: append,
};

/**
 * Coerce a value that is expected to be a record into a plain object. A
 * non-object (null, undefined, array, primitive) is treated as an empty record
 * and logged — never silently swallowed (project rule: always log, never drop).
 */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (value !== undefined) {
    console.warn(
      `[state-reducer] expected ${label} to be a record, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}; treating as {}`,
    );
  }
  return {};
}

/**
 * Reduce `updates` into `prev`, channel by channel.
 *
 * - Starts from a shallow copy of `prev` (so absent keys are retained).
 * - For each key present in `updates`: applies that key's reducer if one is
 *   provided, else `LastValue` (the update value replaces the prior value).
 *   Presence in `updates` — not truthiness — decides whether a key is reduced,
 *   so an explicit `null` is a real replacement, not a skip.
 * - Pure: never mutates `prev` or `updates`.
 * - Non-object `prev` / `updates` are coerced to `{}` (with a warning).
 */
export function reduceChannels(
  prev: Record<string, unknown>,
  updates: Record<string, unknown>,
  reducers: Record<string, ChannelReducer> = {},
): Record<string, unknown> {
  const safePrev = asRecord(prev, 'prev');
  const safeUpdates = asRecord(updates, 'updates');

  const result: Record<string, unknown> = { ...safePrev };

  for (const key of Object.keys(safeUpdates)) {
    const reducer = reducers[key];
    if (reducer) {
      result[key] = reducer(safePrev[key], safeUpdates[key]);
    } else {
      // LastValue: the update replaces the prior value (including explicit null).
      result[key] = safeUpdates[key];
    }
  }

  return result;
}
