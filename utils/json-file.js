import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The one way Fenix keeps state in data/: small JSON files, written whole through a
// temporary file and a rename, so a crash or restart mid-write never leaves half a file.

/**
 * Read a JSON file, or `fallback` when it is missing or unreadable.
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {T}
 */
export function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON file atomically, creating its folder.
 * @param {string} path
 * @param {unknown} data
 * @param {{ mode?: number }} [options] - file mode, e.g. 0o600 for files holding secrets or hashes
 */
export function writeJsonFile(path, data, { mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), { encoding: 'utf-8', ...(mode ? { mode } : {}) });
  renameSync(`${path}.tmp`, path);
}
