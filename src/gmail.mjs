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

// No arbitrary HTTP tool: only these read routes and draft creation are allowed.
export function allowedRoute(method, path) {
  if (method === 'POST') return path === '/drafts';
  return method === 'GET' && (path === '/messages' || /^\/messages\/[A-Za-z0-9_-]+(?:\/attachments\/[A-Za-z0-9_-]+)?$/.test(path));
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
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetch(url, {
        method, headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401 && attempt === 0) { this.token = null; continue; }
      if (!res.ok) throw new Error(`Gmail operation failed (HTTP ${res.status}).`);
      return res.json();
    }
  }
  async search({ query, limit = 50, pageToken, includeSpamTrash = false }) {
    const messages = []; let next = pageToken;
    do {
      const page = await this.request('/messages', { query: { q: query, maxResults: Math.min(500, limit - messages.length), pageToken: next, includeSpamTrash } });
      messages.push(...(page.messages || [])); next = page.nextPageToken;
    } while (next && messages.length < limit);
    return { messages, nextPageToken: next || null, count: messages.length };
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
