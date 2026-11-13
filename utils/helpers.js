/**
 * Wrap a message string in the standard MCP tool result shape.
 * @param {string} text
 * @param {boolean} [isError]
 * @returns {{ content: Array<{type: 'text', text: string}>, isError?: boolean }}
 */
export function textResult(text, isError = false) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

/**
 * Extract the short display name from a fully-qualified TC test name.
 * "suite: package: My Test Name" -> "My Test Name"
 * @param {string} name
 * @returns {string}
 */
export function shortTestName(name) {
  return (name || '').split(':').pop().trim();
}

/**
 * Return an overflow suffix line when `total` exceeds `shown`.
 * @param {number} total
 * @param {number} shown
 * @param {string} [indent]
 * @returns {string | null}
 */
export function andMore(total, shown, indent = '  ') {
  if (total <= shown) return null;
  return `${indent}… and ${total - shown} more`;
}

/**
 * Look up a custom field value on a YouTrack issue object.
 * @param {{ customFields?: Array<{name: string, value: any}> }} issue
 * @param {string} name - Field name (e.g. 'State', 'Assignee')
 * @returns {any} The field's `.value`, or undefined if not found.
 */
export function ytField(issue, name) {
  return issue.customFields?.find((f) => f.name === name)?.value;
}

/**
 * 845 -> `845`, 12345 -> `12.3k`, 1234567 -> `1.23M`
 * @param {number} n
 * @returns {string}
 */
export function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/**
 * @param {number} usd
 * @returns {string}
 */
export function money(usd) {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * A byte count for people: "24.0 MB", "380 KB".
 * @param {number} bytes
 * @returns {string}
 */
export const formatBytes = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
