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
