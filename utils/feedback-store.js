import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, resolvePath } from '../config.js';

const DATA_DIR = resolvePath(config.dataDir);
const FEEDBACK_FILE = join(DATA_DIR, 'feedback.json');
const MAX_ENTRIES = 500;

/** Feedback categories, used by the agent's feedback tools and their schemas. */
export const FEEDBACK_CATEGORIES = /** @type {const} */ (['bug', 'feature', 'ux', 'accuracy', 'praise', 'other']);
/** Feedback sentiments. */
export const FEEDBACK_SENTIMENTS = /** @type {const} */ (['positive', 'negative', 'neutral']);
/** @typedef {(typeof FEEDBACK_CATEGORIES)[number]} FeedbackCategory */
/** @typedef {(typeof FEEDBACK_SENTIMENTS)[number]} FeedbackSentiment */

mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try {
    return JSON.parse(readFileSync(FEEDBACK_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function save(entries) {
  writeFileSync(FEEDBACK_FILE, JSON.stringify(entries, null, 2));
}

/**
 * @typedef {Object} FeedbackEntry
 * @property {string} id
 * @property {string} userId
 * @property {string} userName
 * @property {string} originalText
 * @property {string} summary
 * @property {FeedbackCategory} category
 * @property {FeedbackSentiment} sentiment
 * @property {string} actionable
 * @property {string} ts
 * @property {'button' | 'conversation'} source
 */

/**
 * Save a feedback entry.
 * @param {Omit<FeedbackEntry, 'id' | 'ts'>} entry
 * @returns {FeedbackEntry}
 */
export function addFeedback(entry) {
  const entries = load();
  const record = {
    id: `fb_${Date.now().toString(36)}`,
    ts: new Date().toISOString(),
    ...entry,
  };
  entries.push(record);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  save(entries);
  return record;
}

/**
 * List feedback entries with optional filters.
 * @param {{ category?: string, sentiment?: string, userId?: string, limit?: number }} [filters]
 * @returns {FeedbackEntry[]}
 */
export function listFeedback(filters = {}) {
  let entries = load();
  if (filters.category) entries = entries.filter((e) => e.category === filters.category);
  if (filters.sentiment) entries = entries.filter((e) => e.sentiment === filters.sentiment);
  if (filters.userId) entries = entries.filter((e) => e.userId === filters.userId);
  entries.reverse();
  return entries.slice(0, filters.limit || 50);
}

/**
 * Get summary stats.
 * @returns {{ total: number, byCategory: Record<string, number>, bySentiment: Record<string, number>, recent: FeedbackEntry[] }}
 */
export function feedbackStats() {
  const entries = load();
  const byCategory = {};
  const bySentiment = {};
  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    bySentiment[e.sentiment] = (bySentiment[e.sentiment] || 0) + 1;
  }
  return {
    total: entries.length,
    byCategory,
    bySentiment,
    recent: entries.slice(-5).reverse(),
  };
}
