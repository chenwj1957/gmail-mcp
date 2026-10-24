import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const idPattern = /^[A-Za-z0-9_-]+$/;
export function validId(value) {
  if (typeof value !== 'string' || !idPattern.test(value) || value.length > 2048) throw new Error('Invalid Gmail identifier.');
  return value;
}
export function safeFilename(value) {
  const result = String(value || 'attachment').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  return result && result !== '.' && result !== '..' ? result : 'attachment';
}

// No arbitrary HTTP: the allowlist is read routes plus the four mailbox writes
// below. Deliberately absent: POST /messages/send, POST /drafts/send and
// DELETE /messages/{id} (permanent deletion needs the full-mailbox scope; this
// server only trashes, which is recoverable). Keep it that way.
const SYSTEM_LABELS = new Set(['CHAT', 'SENT', 'INBOX', 'IMPORTANT', 'TRASH', 'DRAFT', 'SPAM', 'UNREAD', 'STARRED',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
const MESSAGE_PATH = /^\/messages\/[A-Za-z0-9_-]+(?:\/attachments\/[A-Za-z0-9_-]+)?$/;
const MESSAGE_WRITE = /^\/messages\/[A-Za-z0-9_-]+\/(?:modify|trash|untrash)$/;
const FILTER_PATH = /^\/settings\/filters\/[A-Za-z0-9_-]+$/;
export function allowedRoute(method, path) {
  if (method === 'POST') return path === '/drafts' || path === '/labels' || path === '/messages/batchModify' || path === '/settings/filters' || MESSAGE_WRITE.test(path);
  // The only DELETE this server performs is removing a filter rule it could
  // create; message deletion stays refused (see above).
  if (method === 'DELETE') return FILTER_PATH.test(path);
  return method === 'GET' && (path === '/messages' || path === '/labels' || path === '/settings/filters' || MESSAGE_PATH.test(path));
}

export class Gmail {
  constructor(creds, downloadDir, fetchImpl = fetch) {
    this.creds = creds; this.downloadDir = downloadDir; this.fetch = fetchImpl;
    this.token = null; this.expires = 0; this.pendingToken = null;
  }
  async accessToken() {
    if (this.token && Date.now() < this.expires) return this.token;
    if (!this.pendingToken) this.pendingToken = this.refresh().finally(() => { this.pendingToken = null; });
    return this.pendingToken;
  }
  async refresh() {
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', ...this.creds }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`OAuth refresh failed (HTTP ${res.status}); reauthorize if credentials expired.`);
    const data = await res.json();
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('OAuth response did not contain an access token.');
    this.token = data.access_token;
    this.expires = Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000;
    return this.token;
  }
  async request(path, { method = 'GET', query = {}, body } = {}) {
    if (!allowedRoute(method, path)) throw new Error('Gmail operation is not permitted by this draft-only server.');
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      // Gmail repeats `metadataHeaders` once per header; an array must append.
      if (Array.isArray(value)) { for (const item of value) url.searchParams.append(key, String(item)); }
      else url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetch(url, {
        method, headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401 && attempt === 0) { this.token = null; continue; }
      // batchModify answers 204 with no body; res.json() would throw on it.
      const text = await res.text();
      if (!res.ok) {
        // Surface Google's own reason ("User-rate limit exceeded", "Invalid label")
        // but nothing else: it is the only way a caller can tell a quota problem
        // from a bug.
        let reason = '';
        try { reason = JSON.parse(text)?.error?.message || ''; } catch { /* non-JSON body */ }
        throw new Error(`Gmail operation failed (HTTP ${res.status})` + (reason ? `: ${String(reason).slice(0, 200)}` : '.'));
      }
      return text === '' ? {} : JSON.parse(text);
    }
  }
  async search({ query, limit = 50, pageToken, includeSpamTrash = false, summaries = false }) {
    const messages = []; let next = pageToken;
    do {
      const page = await this.request('/messages', { query: { q: query, maxResults: Math.min(500, limit - messages.length), pageToken: next, includeSpamTrash } });
      messages.push(...(page.messages || [])); next = page.nextPageToken;
    } while (next && messages.length < limit);
    if (!summaries) return { messages, nextPageToken: next || null, count: messages.length };
    // One metadata GET per id (no bodies): the shape a list/dashboard needs.
    const detailed = new Array(messages.length); let cursor = 0;
    const lane = async () => { for (;;) { const i = cursor++; if (i >= messages.length) return;
      try { detailed[i] = await this.summary(messages[i].id); } catch { detailed[i] = null; } } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(6, messages.length)) }, lane));
    const kept = detailed.filter(Boolean);
    return { messages: kept, nextPageToken: next || null, count: kept.length };
  }
  async summary(id) {
    const m = await this.request(`/messages/${validId(id)}`, { query: {
      format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] } });
    const heads = Object.fromEntries((m.payload?.headers || []).map(h => [String(h.name).toLowerCase(), h.value]));
    const ms = m.internalDate === undefined ? NaN : Number(m.internalDate);
    return { id: m.id, threadId: m.threadId || m.id, subject: heads.subject || '(no subject)',
      from: heads.from || '', receivedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      date: Number.isFinite(ms) ? ms : undefined, labels: m.labelIds || [], snippet: m.snippet || '' };
  }
  /** id -> id, or label name -> id (case-insensitive); unknown names are refused.
   *  System ids (INBOX, UNREAD, ...) are returned as-is, so archiving never needs
   *  a /labels round trip. */
  async resolveLabels(names) {
    if (!names || names.length === 0) return [];
    const system = name => { const upper = String(name).toUpperCase(); return SYSTEM_LABELS.has(upper) ? upper : null; };
    const unresolved = names.filter(name => system(name) === null);
    const labels = unresolved.length > 0 ? ((await this.request('/labels')).labels || []) : [];
    return names.map(name => {
      const sys = system(name);
      if (sys !== null) return sys;
      const hit = labels.find(l => l.id === name) || labels.find(l => String(l.name).toLowerCase() === String(name).toLowerCase());
      if (!hit) throw new Error(`Unknown Gmail label: ${name}`);
      return hit.id;
    });
  }
  async listLabels() {
    const data = await this.request('/labels');
    return { labels: (data.labels || []).map(({ id, name, type, color }) => ({ id, name, type, ...(color ? { color } : {}) })) };
  }
  /** Create a user label. Gmail refuses a duplicate name, which is the useful
   *  signal here: the caller should reuse the existing id instead. */
  async createLabel({ name, labelListVisibility = 'labelShow', messageListVisibility = 'show' }) {
    const clean = String(name ?? '').trim();
    if (clean === '' || clean.length > 225) throw new Error('Label name must be 1-225 characters.');
    if (/[\r\n\x00]/.test(clean)) throw new Error('Label name must not contain control characters.');
    const label = await this.request('/labels', { method: 'POST', body: { name: clean, labelListVisibility, messageListVisibility } });
    return { id: label.id, name: label.name, type: label.type };
  }

  /** The account's server-side filters (Gmail Settings -> Filters). Creating or
   *  deleting one needs the gmail.settings.basic scope; reading needs it too. */
  async listFilters() {
    const data = await this.request('/settings/filters');
    return { filters: (data.filter || []).map(({ id, criteria, action }) => ({ id, criteria, action })) };
  }
  async createFilter({ criteria, action }) {
    const CRITERIA = ['from', 'to', 'subject', 'query', 'negatedQuery', 'hasAttachment', 'excludeChats', 'size', 'sizeComparison'];
    const kept = {};
    for (const key of CRITERIA) if (criteria?.[key] !== undefined && criteria[key] !== '') kept[key] = criteria[key];
    if (Object.keys(kept).length === 0) throw new Error('Provide at least one filter criterion.');
    const add = await this.resolveLabels(action?.addLabelIds || []);
    const remove = await this.resolveLabels(action?.removeLabelIds || []);
    if (add.length === 0 && remove.length === 0) throw new Error('Provide addLabelIds or removeLabelIds for the filter action.');
    const body = { criteria: kept, action: { addLabelIds: add, removeLabelIds: remove } };
    const filter = await this.request('/settings/filters', { method: 'POST', body });
    return { id: filter.id, criteria: filter.criteria, action: filter.action };
  }
  async deleteFilter({ filterId }) {
    await this.request('/settings/filters/' + validId(filterId), { method: 'DELETE' });
    return { deleted: filterId };
  }
  async modify({ messageIds, addLabelIds = [], removeLabelIds = [] }) {
    if (messageIds.length === 0) throw new Error('messageIds must not be empty.');
    const add = await this.resolveLabels(addLabelIds);
    const remove = await this.resolveLabels(removeLabelIds);
    if (add.length === 0 && remove.length === 0) throw new Error('Provide addLabelIds or removeLabelIds.');
    const body = { ids: messageIds.map(validId) };
    if (add.length) body.addLabelIds = add;
    if (remove.length) body.removeLabelIds = remove;
    await this.request('/messages/batchModify', { method: 'POST', body });
    return { modified: messageIds.length, added: add, removed: remove };
  }
  async archive({ messageIds }) {
    const r = await this.modify({ messageIds, removeLabelIds: ['INBOX'] });
    return { archived: r.modified };
  }
  async trash({ messageIds, restore = false }) {
    if (messageIds.length === 0) throw new Error('messageIds must not be empty.');
    const verb = restore ? 'untrash' : 'trash';
    for (const id of messageIds) await this.request(`/messages/${validId(id)}/${verb}`, { method: 'POST' });
    return restore ? { restored: messageIds.length } : { trashed: messageIds.length, recoverable: true };
  }
  async raw(messageId) {
    const data = await this.request(`/messages/${validId(messageId)}`, { query: { format: 'raw' } });
    if (typeof data.raw !== 'string') throw new Error('Gmail response did not include raw email.');
    return { data, bytes: Buffer.from(data.raw, 'base64url') };
  }
  async read({ messageId }) {
    const { data, bytes } = await this.raw(messageId);
    const parsed = await simpleParser(bytes, { skipHtmlToText: true, skipTextToHtml: true });
    const full = await this.request(`/messages/${validId(messageId)}`, { query: { format: 'full' } });
    const attachments = [];
    const walk = (part) => {
      if (!part) return;
      if (part.filename || part.body?.attachmentId) attachments.push({
        partId: part.partId, attachmentId: part.body?.attachmentId || null, filename: part.filename || '',
        mimeType: part.mimeType, size: part.body?.size,
      });
      for (const child of part.parts || []) walk(child);
    };
    walk(full.payload);
    return { id: data.id, threadId: data.threadId, labels: data.labelIds || [], subject: parsed.subject || '',
      from: parsed.from?.text || '', to: parsed.to?.text || '', cc: parsed.cc?.text || '',
      date: parsed.date?.toISOString() || null, text: parsed.text || '', html: parsed.html || null, attachments };
  }
  async save(name, bytes) {
    await mkdir(this.downloadDir, { recursive: true });
    const root = await realpath(this.downloadDir);
    const path = join(root, randomUUID() + '--' + safeFilename(name));
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { path, bytes: bytes.length };
  }
  async downloadEmail({ messageId }) {
    const { bytes } = await this.raw(messageId);
    return this.save(validId(messageId) + '.eml', bytes);
  }
  async downloadAttachment({ messageId, attachmentId, partId }) {
    validId(messageId);
    if (!attachmentId && partId === undefined) throw new Error('Provide attachmentId or partId.');
    const message = await this.request(`/messages/${messageId}`, { query: { format: 'full' } });
    const parts = []; const walk = p => { if (p) { parts.push(p); for (const child of p.parts || []) walk(child); } }; walk(message.payload);
    const part = parts.find(p => attachmentId ? p.body?.attachmentId === attachmentId : p.partId === partId);
    if (!part) throw new Error('Attachment or MIME part not found in this message.');
    let encoded = part.body?.data;
    if (part.body?.attachmentId) {
      const data = await this.request(`/messages/${messageId}/attachments/${validId(part.body.attachmentId)}`);
      encoded = data.data;
    }
    if (typeof encoded !== 'string') throw new Error('Attachment has no downloadable content.');
    return { ...(await this.save(part.filename || 'attachment', Buffer.from(encoded, 'base64url'))), filename: part.filename || 'attachment', mimeType: part.mimeType };
  }
  async draft({ to, cc, bcc, subject, text, html }) {
    for (const value of [...to, ...(cc || []), ...(bcc || []), subject]) {
      if (/[\r\n\x00]/.test(value)) throw new Error('Email headers must not contain control characters.');
    }
    const composed = new MailComposer({ to, cc, bcc, subject, text, html, disableFileAccess: true, disableUrlAccess: true }).compile();
    composed.keepBcc = true;
    const raw = await composed.build();
    const draft = await this.request('/drafts', { method: 'POST', body: { message: { raw: raw.toString('base64url') } } });
    return { draftId: draft.id, messageId: draft.message?.id, status: 'draft', sent: false };
  }
}
