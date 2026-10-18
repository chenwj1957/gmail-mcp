import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
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
test('no send endpoint, no permanent delete, no arbitrary methods', async () => {
  assert.equal(tools({}).length, 9);
  assert.ok(tools({}).every(t => !t.name.includes('send')));
  for (const [method, path] of [['POST', '/messages/send'], ['POST', '/drafts/send'], ['DELETE', '/messages/a'],
    ['DELETE', '/messages/a/trash'], ['POST', '/threads/a/modify'], ['GET', '/messages/../drafts']]) assert.equal(allowedRoute(method, path), false);
  const { gmail, calls } = mock(() => assert.fail());
  await assert.rejects(gmail.request('/messages/send', { method: 'POST' }), /not permitted/);
  assert.equal(calls.length, 0);
  assert.throws(() => validId('../drafts'), /Invalid/);
});
test('the write allowlist is exactly archive/label/trash/untrash plus drafts', () => {
  for (const path of ['/messages/a/modify', '/messages/batchModify', '/messages/a/trash', '/messages/a/untrash', '/drafts']) assert.equal(allowedRoute('POST', path), true, path);
  for (const path of ['/messages', '/messages/a', '/messages/a/attachments/b', '/labels']) assert.equal(allowedRoute('GET', path), true, path);
  for (const path of ['/messages/send', '/drafts/send', '/messages/a/attachments/b/delete']) assert.equal(allowedRoute('POST', path), false, path);
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
    assert.equal(dirname(one.path).toLowerCase(), (await realpath(root)).toLowerCase()); assert.notEqual(one.path, two.path); assert.equal(await readFile(one.path, 'utf8'), 'one');
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
  const byName = Object.fromEntries(tools({}).map(t => [t.name, t]));
  assert.equal(byName.gmail_draft_email.schema.safeParse({ to: ['x@example.com'], subject: 'a\r\nBcc: b', text: '' }).success, false);
  assert.equal(byName.gmail_download_attachment.schema.safeParse({ messageId: 'm1' }).success, false);
  assert.equal(byName.gmail_label_email.schema.safeParse({ messageIds: ['m1'] }).success, false);
  assert.equal(byName.gmail_archive_email.schema.safeParse({ messageIds: [] }).success, false);
});

test('archive removes INBOX in one batchModify call', async () => {
  const { gmail, calls } = mock(() => Response.json({}));
  assert.deepEqual(await gmail.archive({ messageIds: ['m1', 'm2'] }), { archived: 2 });
  const write = calls.find(c => c.options.method === 'POST' && c.url.includes('/gmail/v1/'));
  assert.equal(new URL(write.url).pathname, '/gmail/v1/users/me/messages/batchModify');
  assert.deepEqual(JSON.parse(write.options.body), { ids: ['m1', 'm2'], removeLabelIds: ['INBOX'] });
});

test('labels resolve by name or id and unknown names are refused', async () => {
  const { gmail } = mock(url => url.pathname.endsWith('/labels')
    ? Response.json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_7', name: 'Tax', type: 'user' }] })
    : Response.json({}));
  assert.deepEqual(await gmail.listLabels(), { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_7', name: 'Tax', type: 'user' }] });
  const r = await gmail.modify({ messageIds: ['m1'], addLabelIds: ['Tax'], removeLabelIds: ['INBOX'] });
  assert.deepEqual(r, { modified: 1, added: ['Label_7'], removed: ['INBOX'] });
  await assert.rejects(gmail.modify({ messageIds: ['m1'], addLabelIds: ['Nope'] }), /Unknown Gmail label/);
});

test('batchModify answers 204 with no body and is not treated as a parse error', async () => {
  const { gmail } = mock(() => new Response(null, { status: 204 }));
  assert.deepEqual(await gmail.modify({ messageIds: ['m1'], removeLabelIds: ['INBOX'] }), { modified: 1, added: [], removed: ['INBOX'] });
});
test('trash and untrash hit the per-message endpoints, never DELETE', async () => {
  const { gmail, calls } = mock(() => Response.json({}));
  assert.deepEqual(await gmail.trash({ messageIds: ['m1'] }), { trashed: 1, recoverable: true });
  assert.deepEqual(await gmail.trash({ messageIds: ['m1'], restore: true }), { restored: 1 });
  assert.deepEqual(calls.slice(-2).map(c => new URL(c.url).pathname), ['/gmail/v1/users/me/messages/m1/trash', '/gmail/v1/users/me/messages/m1/untrash']);
  assert.ok(calls.every(c => c.options.method !== 'DELETE'));
});

test('search summaries carry subject/from/date/labels without fetching bodies', async () => {
  const { gmail, calls } = mock(url => url.searchParams.get('format') === 'metadata'
    ? Response.json({ id: 'm1', threadId: 'm1', internalDate: '1700000000000', labelIds: ['INBOX'],
      payload: { headers: [{ name: 'Subject', value: 'Hello' }, { name: 'From', value: 'A <a@b.c>' }] }, snippet: 'hi' })
    : Response.json({ messages: [{ id: 'm1' }] }));
  const r = await gmail.search({ query: 'q', limit: 5, summaries: true });
  assert.equal(r.messages[0].subject, 'Hello');
  assert.equal(r.messages[0].from, 'A <a@b.c>');
  assert.deepEqual(r.messages[0].labels, ['INBOX']);
  assert.equal(new Date(r.messages[0].receivedAt).toISOString(), '2023-11-14T22:13:20.000Z');
  assert.ok(calls.some(c => new URL(c.url).searchParams.get('format') === 'metadata'));
  assert.ok(!calls.some(c => new URL(c.url).searchParams.get('format') === 'full'));
  const headers = new URL(calls.find(c => new URL(c.url).searchParams.get('format') === 'metadata').url).searchParams.getAll('metadataHeaders');
  assert.deepEqual(headers, ['From', 'Subject', 'Date']);
});
