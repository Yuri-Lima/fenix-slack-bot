/**
 * What a thread's agent session has cost so far. The SDK reports a resumed session's usage as the running
 * total of the whole thread, so the next reply's own usage is its total minus these.
 * @typedef {Pick<import('../utils/usage-store.js').UsageRecord, 'models' | 'costUsd'>} ThreadTotals
 */

/**
 * @typedef {Object} StoreEntry
 * @property {string} sessionId
 * @property {number} timestamp
 * @property {ThreadTotals | null} totals
 */

/**
 * Key identifying a Slack thread: one agent session and one in-flight run per thread.
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {string}
 */
export function threadKey(channelId, threadTs) {
  return `${channelId}:${threadTs}`;
}

/**
 * In-memory session ID store with TTL-based cleanup.
 */
export class SessionStore {
  /**
   * @param {number} [ttlSeconds=86400]
   * @param {number} [maxEntries=1000]
   */
  constructor(ttlSeconds = 86400, maxEntries = 1000) {
    /** @type {Map<string, StoreEntry>} */
    this._store = new Map();
    /** @private @type {number} */
    this._ttlSeconds = ttlSeconds;
    /** @private @type {number} */
    this._maxEntries = maxEntries;
  }

  /**
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {string | null}
   */
  getSession(channelId, threadTs) {
    return this._entry(channelId, threadTs)?.sessionId ?? null;
  }

  /**
   * The thread session's running usage totals after its last reply, or null.
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {ThreadTotals | null}
   */
  getTotals(channelId, threadTs) {
    return this._entry(channelId, threadTs)?.totals ?? null;
  }

  /**
   * @param {string} channelId
   * @param {string} threadTs
   * @param {string} sessionId
   * @param {ThreadTotals | null} [totals] - The session's running usage totals after this reply
   * @returns {void}
   */
  setSession(channelId, threadTs, sessionId, totals = null) {
    const key = threadKey(channelId, threadTs);
    this._store.set(key, {
      sessionId,
      timestamp: Date.now(),
      totals,
    });
    this._cleanup();
  }

  /**
   * @private
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {StoreEntry | null}
   */
  _entry(channelId, threadTs) {
    const key = threadKey(channelId, threadTs);
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._ttlSeconds * 1000) {
      this._store.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {void}
   */
  deleteSession(channelId, threadTs) {
    this._store.delete(threadKey(channelId, threadTs));
  }

  /**
   * @private
   * @returns {void}
   */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now - entry.timestamp > this._ttlSeconds * 1000) {
        this._store.delete(key);
      }
    }
    if (this._store.size > this._maxEntries) {
      const sorted = [...this._store.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = sorted.slice(0, this._store.size - this._maxEntries);
      for (const [key] of toRemove) {
        this._store.delete(key);
      }
    }
  }
}
