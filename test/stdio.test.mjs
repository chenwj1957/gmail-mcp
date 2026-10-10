import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

test('real stdio server initializes and advertises exactly five draft-only tools', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, GMAIL_CLIENT_ID: 'synthetic-client', GMAIL_CLIENT_SECRET: 'synthetic-secret', GMAIL_REFRESH_TOKEN: 'synthetic-refresh' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let next = 1;
  lines.on('line', line => { const msg = JSON.parse(line); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const request = (method, params) => new Promise(resolve => { const id = next++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'gmail-draft-mcp');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await request('tools/list', {}); assert.equal(list.result.tools.length, 5);
    assert.ok(list.result.tools.every(tool => !tool.name.includes('send')));
    const unknown = await request('tools/call', { name: 'gmail_send_email', arguments: {} }); assert.ok(unknown.error || unknown.result?.isError);
    const invalid = await request('tools/call', { name: 'gmail_read_email', arguments: { messageId: '../drafts' } }); assert.ok(invalid.error || invalid.result?.isError);
  } finally { lines.close(); child.kill(); }
});
