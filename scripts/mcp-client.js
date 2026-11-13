#!/usr/bin/env node
// Manage named MCP clients (Cursor, Grok, ...) and their tokens.
//
//   node scripts/mcp-client.js create <name> [--send] [--no-approval]
//   node scripts/mcp-client.js list
//   node scripts/mcp-client.js revoke <name>
//
// `create` prints only the token on stdout (everything else goes to stderr), so it
// can be written straight to a file without showing it: ... create grok > ~/.fenix_mcp_token_grok
// Without --send a client gets the read-only tools. With --send it can also post as Fenix;
// each message then waits for an owner's Send click in Slack unless --no-approval is given.
// Running `create` for an existing name replaces its token (rotation).

import { createClient, listClients, revokeClient } from '../mcp/clients.js';

const [command, name, ...flags] = process.argv.slice(2);
const usage = 'Usage: mcp-client.js create <name> [--send] [--no-approval] | list | revoke <name>';

try {
  if (command === 'create' && name) {
    const unknown = flags.filter((f) => f !== '--send' && f !== '--no-approval');
    if (unknown.length) throw new Error(`Unknown option ${unknown.join(' ')}. ${usage}`);
    const { token, client } = createClient(name, {
      send: flags.includes('--send'),
      sendApproval: flags.includes('--no-approval') ? 'none' : 'slack',
    });
    process.stdout.write(`${token}\n`);
    const sending = client.scopes.includes('send')
      ? `can send (${client.sendApproval === 'slack' ? 'each message approved in Slack' : 'without approval'})`
      : 'read-only';
    process.stderr.write(`Client "${client.name}" ready: ${sending}. Store the token now; it is not kept.\n`);
  } else if (command === 'list') {
    const clients = listClients();
    if (!clients.length) process.stderr.write('No clients yet.\n');
    for (const c of clients) {
      const created = new Date(c.createdAt * 1000).toISOString().slice(0, 10);
      process.stdout.write(
        `${c.name}\tscopes=${c.scopes.join(',')}\tsendApproval=${c.sendApproval}\tcreated=${created}\n`,
      );
    }
  } else if (command === 'revoke' && name) {
    process.stderr.write(revokeClient(name) ? `Revoked "${name}".\n` : `No client called "${name}".\n`);
  } else {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
}
