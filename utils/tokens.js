import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Create a cached token reader that checks an env var first, then a dotfile.
 * @param {string} envVar - Environment variable name (e.g. 'TEAMCITY_TOKEN')
 * @param {string} fileName - Dotfile name under $HOME (e.g. '.teamcity_token')
 * @returns {() => string | null}
 */
export function createTokenReader(envVar, fileName) {
  let cached = null;
  return function getToken() {
    if (cached) return cached;
    try {
      cached = process.env[envVar] || readFileSync(`${homedir()}/${fileName}`, 'utf-8').trim();
    } catch {
      cached = null;
    }
    return cached;
  };
}
