import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { simpleParser } from 'mailparser';
import { Gmail, allowedRoute, validId } from '../src/gmail.mjs';
import { tools } from '../src/tools.mjs';
import { validCallback } from '../src/oauth.mjs';

const creds = { client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh' };
function mock(handler) {
  const calls = [];
  const gmail = new Gmail(creds, tmpdir(), async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
    return handler(new URL(url), options);
  });
  return { gmail, calls };
}
test('only five generic tools; no send endpoint, aliases or arbitrary methods', async () => {
  assert.equal(tools({}).length, 5);
  assert.ok(tools({}).every(t => !t.name.includes('send')));
  for (const [method, path] of [['POST', '/messages/send'], ['POST', '/drafts/send'], ['DELETE', '/messages/a'], ['POST', '/messages/a/modify'], ['GET', '/messages/../drafts']]) assert.equal(allowedRoute(method, path), false);
  const { gmail, calls } = mock(() => assert.fail());
  await assert.rejects(gmail.request('/messages/send', { method: 'POST' }), /not permitted/);
  assert.equal(calls.length, 0);
  assert.throws(() => validId('../drafts'), /Invalid/);
});
test('search paginates and returns continuation at the requested limit', async () => {
  const { gmail, calls } = mock(url => Response.json(url.searchParams.has('pageToken') ? { messages: [{ id: 'b' }], nextPageToken: 'remaining' } : { messages: [{ id: 'a' }], nextPageToken: 'second' }));
  const result = await gmail.search({ query: 'subject:example', limit: 2 });
  assert.deepEqual(result.messages.map(m => m.id), ['a', 'b']);
  assert.equal(result.nextPageToken, 'remaining');
  assert.equal(new URL(calls[2].url).searchParams.get('pageToken'), 'second');
});
test('draft creates MIME with Unicode and BCC, posts only drafts', async () => {
  let payload;
  const { gmail, calls } = mock((url, options) => { assert.equal(url.pathname.endsWith('/drafts'), true); assert.equal(options.method, 'POST'); payload = JSON.parse(options.body); return Response.json({ id: 'draft1', message: { id: 'm1' } }); });
  const result = await gmail.draft({ to: ['recipient@example.com'], bcc: ['hidden@example.com'], subject: 'Hello 世界', text: 'Body café', html: '<p>Body café</p>' });
  const parsed = await simpleParser(Buffer.from(payload.message.raw, 'base64url'));
  assert.equal(parsed.subject, 'Hello 世界'); assert.match(parsed.text, /café/); assert.equal(parsed.bcc.value[0].address, 'hidden@example.com');
  assert.equal(result.sent, false); assert.equal(calls.length, 2);
  await assert.rejects(gmail.draft({ to: ['x@example.com'], subject: 'bad\r\nBcc: x@example.com', text: '' }), /control/);
});
test('downloads preserve EML bytes and avoid collisions and traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gmail-mcp-test-'));
  try {
    const raw = Buffer.from('Subject: Example\r\n\r\nOriginal body\r\n');
    const { gmail } = mock(() => Response.json({ raw: raw.toString('base64url') })); gmail.downloadDir = root;
    const exported = await gmail.downloadEmail({ messageId: 'm1' }); assert.deepEqual(await readFile(exported.path), raw);
    const one = await gmail.save('../../same.pdf', Buffer.from('one')); const two = await gmail.save('../../same.pdf', Buffer.from('two'));
    assert.equal(dirname(one.path).toLowerCase(), root.toLowerCase()); assert.notEqual(one.path, two.path); assert.equal(await readFile(one.path, 'utf8'), 'one');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('read decodes MIME and exposes attachment identifiers', async () => {
  const { gmail } = mock(url => Response.json(url.searchParams.get('format') === 'raw' ? { id: 'm1', raw: Buffer.from('Subject: Example\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello').toString('base64url') } : { payload: { parts: [{ partId: '1', filename: 'example.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 4 } }] } }));
  const result = await gmail.read({ messageId: 'm1' }); assert.equal(result.text, 'Hello'); assert.equal(result.attachments[0].attachmentId, 'att1');
});
test('download handles attachmentId and inline partId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gmail-mcp-test-'));
  try {
    const { gmail } = mock(url => Response.json(url.pathname.includes('/attachments/') ? { data: Buffer.from('PDF').toString('base64url') } : { payload: { parts: [{ partId: '1', filename: '../file.pdf', body: { attachmentId: 'att1' } }, { partId: '2', filename: 'inline.txt', body: { data: Buffer.from('inline').toString('base64url') } }] } })); gmail.downloadDir = root;
    assert.equal(await readFile((await gmail.downloadAttachment({ messageId: 'm1', attachmentId: 'att1' })).path, 'utf8'), 'PDF');
    assert.equal(await readFile((await gmail.downloadAttachment({ messageId: 'm1', partId: '2' })).path, 'utf8'), 'inline');
    await assert.rejects(gmail.downloadAttachment({ messageId: 'm1', attachmentId: 'missing' }), /not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('OAuth rejects stale state even on an error callback', () => {
  assert.equal(validCallback(new URL('http://127.0.0.1/?state=wrong&error=denied'), 'expected'), false);
  assert.equal(validCallback(new URL('http://127.0.0.1/?state=expected&code=example'), 'expected'), true);
});
test('schema rejects header injection and invalid attachment arguments', () => {
  const definitions = tools({});
  assert.equal(definitions[4].schema.safeParse({ to: ['x@example.com'], subject: 'a\r\nBcc: b', text: '' }).success, false);
  assert.equal(definitions[3].schema.safeParse({ messageId: 'm1' }).success, false);
});
