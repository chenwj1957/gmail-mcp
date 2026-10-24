import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Calendar, allowedRoute, toInstant, validCalendarId, validEventId } from '../src/calendar.mjs';
import { SCOPES, beginPasteAuth, finishPasteAuth } from '../src/oauth.mjs';
import { tools } from '../src/tools.mjs';

const creds = { client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh' };

function mock(handler) {
  const calls = [];
  const calendar = new Calendar(creds, { timeZone: 'Australia/Sydney' }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
    return handler(new URL(url), options);
  });
  return { calendar, calls };
}

test('calendar route allowlist admits only event reads/writes and freebusy', () => {
  assert.equal(allowedRoute('GET', '/users/me/calendarList'), true);
  assert.equal(allowedRoute('GET', '/calendars/primary/events'), true);
  assert.equal(allowedRoute('POST', '/calendars/primary/events'), true);
  assert.equal(allowedRoute('PATCH', '/calendars/primary/events/evt1'), true);
  assert.equal(allowedRoute('DELETE', '/calendars/primary/events/evt1'), true);
  assert.equal(allowedRoute('POST', '/freeBusy'), true);
  for (const [method, path] of [
    ['POST', '/calendars'], ['DELETE', '/calendars/primary'], ['POST', '/calendars/primary/acl'],
    ['GET', '/calendars/primary/events/evt1/attendees'], ['PATCH', '/users/me/calendarList'],
    ['GET', '/calendars/primary/events/../acl'], ['POST', '/channels/watch'], ['GET', '/calendars/primary'],
  ]) assert.equal(allowedRoute(method, path), false, `${method} ${path}`);
});

test('calendar ids and event ids reject traversal and separators', () => {
  assert.throws(() => validCalendarId('../secret'), /Invalid calendar/);
  assert.throws(() => validCalendarId('a/b'), /Invalid calendar/);
  assert.equal(validCalendarId('primary'), 'primary');
  assert.equal(validCalendarId('team@group.calendar.google.com'), 'team@group.calendar.google.com');
  assert.throws(() => validEventId('a/b'), /Invalid event/);
  assert.equal(validEventId('evt_20261028T060000Z'), 'evt_20261028T060000Z');
});

test('bare local times are resolved in the configured zone', () => {
  assert.equal(toInstant('2026-10-28', 'Australia/Sydney'), '2026-10-27T13:00:00.000Z');
  assert.equal(toInstant('2026-10-28T17:00', 'Australia/Sydney'), '2026-10-28T06:00:00.000Z');
  assert.equal(toInstant('2026-10-28T17:00:00+11:00', 'Australia/Sydney'), '2026-10-28T06:00:00.000Z');
  assert.throws(() => toInstant('28/10/2026', 'Australia/Sydney'), /Time must be/);
});

test('create posts an event with sendUpdates=none and no attendees', async () => {
  let payload;
  const { calendar, calls } = mock((url, options) => {
    assert.equal(url.pathname, '/calendar/v3/calendars/primary/events');
    assert.equal(options.method, 'POST');
    assert.equal(url.searchParams.get('sendUpdates'), 'none');
    payload = JSON.parse(options.body);
    return Response.json({ id: 'evt1', summary: payload.summary, start: payload.start, end: payload.end, status: 'confirmed' });
  });
  const result = await calendar.createEvent({ summary: 'RSVP deadline', start: '2026-10-24T09:00', end: '2026-10-24T09:15', location: 'Hilton Level 1', reminders: [{ method: 'popup', minutes: 0 }] });
  assert.equal(payload.summary, 'RSVP deadline');
  assert.deepEqual(payload.start, { dateTime: '2026-10-24T09:00:00', timeZone: 'Australia/Sydney' });
  assert.deepEqual(payload.end, { dateTime: '2026-10-24T09:15:00', timeZone: 'Australia/Sydney' });
  assert.deepEqual(payload.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] });
  assert.equal('attendees' in payload, false);
  assert.equal(result.attendees, 0);
  assert.ok(calls.every(call => !String(call.options.body || '').includes('attendees')));
  await calendar.createEvent({ summary: 'offset form', start: '2026-10-24T09:00+11:00', end: '2026-10-24T09:15+11:00' });
  assert.deepEqual(payload.start, { dateTime: '2026-10-24T09:00:00+11:00' });
  await assert.rejects(calendar.createEvent({ start: '2026-10-24', end: '2026-10-25' }), /summary is required/);
  await assert.rejects(calendar.createEvent({ summary: 'x', start: '24/10/2026', end: '2026-10-25' }), /Event start/);
});

test('all-day events use date objects and list forwards a UTC window', async () => {
  let payload;
  const { calendar, calls } = mock((url, options) => {
    if (options.method === 'POST') { payload = JSON.parse(options.body); return Response.json({ id: 'e1', ...payload }); }
    return Response.json({ items: [{ id: 'e1', summary: 'Evening', start: { dateTime: '2026-10-28T17:00:00+11:00' }, end: { dateTime: '2026-10-28T19:00:00+11:00' } }], timeZone: 'Australia/Sydney' });
  });
  await calendar.createEvent({ summary: 'RSVP', start: '2026-10-24', end: '2026-10-25' });
  assert.deepEqual(payload.start, { date: '2026-10-24' });
  const listed = await calendar.listEvents({ timeMin: '2026-10-28', timeMax: '2026-10-29' });
  const query = new URL(calls.at(-1).url).searchParams;
  assert.equal(query.get('timeMin'), '2026-10-27T13:00:00.000Z');
  assert.equal(query.get('timeMax'), '2026-10-28T13:00:00.000Z');
  assert.equal(query.get('orderBy'), 'startTime');
  assert.equal(listed.events[0].id, 'e1');
});

test('update patches only supplied fields and requires both times', async () => {
  let payload;
  const { calendar, calls } = mock((url, options) => { payload = JSON.parse(options.body); return Response.json({ id: 'e1', ...payload }); });
  await calendar.updateEvent({ eventId: 'e1', summary: 'Renamed' });
  assert.deepEqual(payload, { summary: 'Renamed' });
  assert.equal(calls.at(-1).options.method, 'PATCH');
  assert.equal(new URL(calls.at(-1).url).searchParams.get('sendUpdates'), 'none');
  await assert.rejects(calendar.updateEvent({ eventId: 'e1', start: '2026-10-24' }), /both start and end/);
  await assert.rejects(calendar.updateEvent({ eventId: 'e1' }), /at least one field/);
});

test('delete and freebusy hit only their routes', async () => {
  const { calendar, calls } = mock((url, options) => url.pathname === '/calendar/v3/freeBusy'
    ? Response.json({ calendars: { primary: { busy: [{ start: '2026-10-28T06:00:00Z', end: '2026-10-28T08:00:00Z' }] } } })
    : Response.json({}));
  const deleted = await calendar.deleteEvent({ eventId: 'e1' });
  assert.equal(deleted.deleted, true);
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(new URL(calls.at(-1).url).searchParams.get('sendUpdates'), 'none');
  const busy = await calendar.freeBusy({ timeMin: '2026-10-28', timeMax: '2026-10-29' });
  assert.equal(busy.calendars.primary.busy.length, 1);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { timeMin: '2026-10-27T13:00:00.000Z', timeMax: '2026-10-28T13:00:00.000Z', items: [{ id: 'primary' }] });
});

test('server advertises twenty tools, seven of them calendar', () => {
  const list = tools({}, {});
  assert.equal(list.length, 20);
  const calendarTools = list.filter(tool => tool.name.startsWith('calendar_')).map(tool => tool.name);
  assert.deepEqual(calendarTools, ['calendar_list_calendars', 'calendar_list_events', 'calendar_get_event',
    'calendar_create_event', 'calendar_update_event', 'calendar_delete_event', 'calendar_freebusy']);
  assert.ok(list.every(tool => !/send|invite|attendee/.test(tool.name)));
  const write = Object.fromEntries(list.map(tool => [tool.name, tool]));
  assert.equal(write.calendar_create_event.readOnly, false);
  assert.equal(write.calendar_delete_event.destructive, true);
});

test('requested scopes include calendar reads and event writes', () => {
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/calendar.readonly'));
  assert.ok(SCOPES.every(scope => !scope.endsWith('/calendar')), 'no full-calendar scope');
});

test('paste-back OAuth writes a token only after the code is exchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gmail-mcp-oauth-'));
  try {
    const cfg = { clientFile: join(root, 'client.json'), tokenFile: join(root, 'credentials.json'), downloadDir: root, pendingFile: join(root, 'pending.json') };
    await writeFile(cfg.clientFile, JSON.stringify({ installed: { client_id: 'paste-client', client_secret: 'paste-secret' } }));
    const begun = await beginPasteAuth(cfg);
    assert.match(begun.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(begun.url, /calendar\.events/);
    const pending = JSON.parse(await readFile(cfg.pendingFile, 'utf8'));
    const callback = `http://127.0.0.1:53682/?state=${encodeURIComponent(pending.state)}&code=one-time-code`;
    const exchanged = [];
    const result = await finishPasteAuth(cfg, callback, async (url, options) => {
      exchanged.push({ url: String(url), body: String(options.body) });
      return Response.json({ refresh_token: 'fresh-refresh', scope: SCOPES.join(' ') });
    });
    assert.equal(result.saved, true);
    assert.equal(exchanged.length, 1);
    assert.ok(exchanged[0].body.includes('code_verifier='));
    const saved = JSON.parse(await readFile(cfg.tokenFile, 'utf8'));
    assert.equal(saved.refresh_token, 'fresh-refresh');
    assert.equal(saved.client_id, 'paste-client');
    await assert.rejects(readFile(cfg.pendingFile, 'utf8'), /ENOENT/);
    await assert.rejects(finishPasteAuth(cfg, callback), /No pending authorization/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('paste-back OAuth refuses a mismatched state and missing scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gmail-mcp-oauth-'));
  try {
    const cfg = { clientFile: join(root, 'client.json'), tokenFile: join(root, 'credentials.json'), downloadDir: root, pendingFile: join(root, 'pending.json') };
    await writeFile(cfg.clientFile, JSON.stringify({ client_id: 'paste-client', client_secret: 'paste-secret' }));
    await beginPasteAuth(cfg);
    const pending = JSON.parse(await readFile(cfg.pendingFile, 'utf8'));
    await assert.rejects(finishPasteAuth(cfg, 'http://127.0.0.1:53682/?state=wrong&code=x'), /state does not match/);
    await assert.rejects(finishPasteAuth(cfg, `http://127.0.0.1:53682/?state=${encodeURIComponent(pending.state)}&code=x`,
      async () => Response.json({ refresh_token: 'r', scope: 'https://www.googleapis.com/auth/gmail.modify' })), /Required scopes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
