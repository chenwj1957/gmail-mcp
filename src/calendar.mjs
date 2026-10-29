// Google Calendar v3 client for this MCP server.
//
// Safety posture mirrors the Gmail side: a fixed route allowlist (no arbitrary
// HTTP), no attendees (so this server can never email a third party), no
// calendar-level or ACL mutations, and every write pinned to sendUpdates=none.
// Only events on calendars the user can edit are touched.

const API = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_ID = /^[A-Za-z0-9._@+-]{1,256}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/;
const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_REMINDER_MINUTES = 40320;

export const DEFAULT_TIME_ZONE = 'Australia/Sydney';

export function validCalendarId(value) {
  if (typeof value !== 'string' || !CALENDAR_ID.test(value) || value.includes('..')) throw new Error('Invalid calendar identifier.');
  return value;
}
export function validEventId(value) {
  if (typeof value !== 'string' || !EVENT_ID.test(value)) throw new Error('Invalid event identifier.');
  return value;
}

// No arbitrary HTTP: reads (calendar list, event list, single event), plus
// event create/patch/delete and freebusy. Deliberately absent: calendar
// creation/deletion, ACLs, attendees, and any Google API outside Calendar v3.
export function allowedRoute(method, path) {
  const events = /^\/calendars\/[A-Za-z0-9._@+-]+\/events$/;
  const event = /^\/calendars\/[A-Za-z0-9._@+-]+\/events\/[A-Za-z0-9_-]+$/;
  if (method === 'GET') return path === '/users/me/calendarList' || events.test(path) || event.test(path);
  if (method === 'POST') return events.test(path) || path === '/freeBusy';
  if (method === 'PATCH') return event.test(path);
  if (method === 'DELETE') return event.test(path);
  return false;
}

function cleanText(value, max) {
  if (typeof value !== 'string') throw new Error('Event text fields must be strings.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Event text must not contain control characters.');
  return value.replace(/\r\n/g, '\n').slice(0, max);
}

function zonedParts(instant, timeZone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
}

/** "2026-10-24" or "2026-10-24T09:00" in `timeZone` -> RFC3339 UTC instant. */
export function toInstant(value, timeZone = DEFAULT_TIME_ZONE) {
  if (typeof value !== 'string' || !(DATE.test(value) || DATE_TIME.test(value))) throw new Error('Time must be YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS)(±HH:MM|Z).');
  if (DATE_TIME.test(value) && OFFSET_SUFFIX.test(value)) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) throw new Error('Time is not a valid calendar date-time.');
    return instant.toISOString();
  }
  const local = value.length === 10 ? value + 'T00:00' : value;
  const [datePart, timePart] = local.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour = 0, minute = 0, second = 0] = timePart.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const shown = zonedParts(new Date(naive), timeZone);
  const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
  return new Date(naive - (shownAsUtc - naive)).toISOString();
}

function eventTime(value, timeZone, name) {
  if (typeof value !== 'string' || !(DATE.test(value) || DATE_TIME.test(value))) throw new Error(`Event ${name} must be YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:MM(:SS)(±HH:MM|Z).`);
  if (DATE.test(value)) return { date: value };
  // Google rejects a dateTime without seconds ("2026-10-24T09:00" -> generic
  // 400 Bad Request), so normalize to full seconds before sending.
  const withSeconds = value.replace(/T(\d{2}:\d{2})(?=(?:Z|[+-]\d{2}:\d{2})?$)/, 'T$1:00');
  return OFFSET_SUFFIX.test(withSeconds) ? { dateTime: withSeconds } : { dateTime: withSeconds, timeZone };
}

function remindersBody(reminders) {
  if (!Array.isArray(reminders) || reminders.length === 0) return undefined;
  return {
    useDefault: false,
    overrides: reminders.slice(0, 5).map(reminder => ({
      method: reminder?.method === 'email' ? 'email' : 'popup',
      minutes: Math.max(0, Math.min(MAX_REMINDER_MINUTES, Math.trunc(Number(reminder?.minutes) || 0))),
    })),
  };
}

function summarizeEvent(event) {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary || '',
    start: event.start,
    end: event.end,
    location: event.location,
    description: typeof event.description === 'string' ? event.description.slice(0, 2000) : undefined,
    htmlLink: event.htmlLink,
    recurringEventId: event.recurringEventId,
  };
}

export class Calendar {
  constructor(creds, options = {}, fetchImpl = fetch) {
    this.creds = creds;
    this.fetch = fetchImpl;
    this.timeZone = options.timeZone || DEFAULT_TIME_ZONE;
    this.token = null;
    this.expires = 0;
    this.pendingToken = null;
  }
  /** Swap in re-authorized credentials (SIGHUP path) and drop the cached access token. */
  reload(creds) {
    this.creds = creds;
    this.token = null;
    this.expires = 0;
    this.pendingToken = null;
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
    if (!allowedRoute(method, path)) throw new Error('Calendar operation is not permitted by this server.');
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) { for (const item of value) url.searchParams.append(key, String(item)); }
      else url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401 && attempt === 0) { this.token = null; continue; }
      const text = await res.text();
      if (!res.ok) {
        let reason = '';
        try {
          const payload = JSON.parse(text)?.error;
          reason = payload?.message || '';
          const detail = payload?.errors?.[0]?.message;
          if (detail && detail !== reason) reason += ': ' + detail;
        } catch { /* non-JSON body */ }
        throw new Error(`Calendar operation failed (HTTP ${res.status})` + (reason ? `: ${String(reason).slice(0, 200)}` : '.'));
      }
      return text === '' ? {} : JSON.parse(text);
    }
  }
  async listCalendars() {
    const data = await this.request('/users/me/calendarList', { query: { maxResults: 100 } });
    return { calendars: (data.items || []).map(calendar => ({
      id: calendar.id, summary: calendar.summary, primary: Boolean(calendar.primary),
      accessRole: calendar.accessRole, timeZone: calendar.timeZone,
    })) };
  }
  async listEvents({ calendarId = 'primary', timeMin, timeMax, maxResults = 25, query, singleEvents = true, orderBy, pageToken } = {}) {
    const id = validCalendarId(calendarId);
    const data = await this.request(`/calendars/${id}/events`, { query: {
      timeMin: timeMin === undefined ? undefined : toInstant(timeMin, this.timeZone),
      timeMax: timeMax === undefined ? undefined : toInstant(timeMax, this.timeZone),
      maxResults: Math.max(1, Math.min(250, Math.trunc(Number(maxResults) || 25))),
      q: query === undefined ? undefined : String(query).slice(0, 256),
      singleEvents, orderBy: orderBy || (singleEvents ? 'startTime' : undefined),
      pageToken, showDeleted: false,
    } });
    return { events: (data.items || []).map(summarizeEvent), nextPageToken: data.nextPageToken || null, timeZone: data.timeZone };
  }
  async getEvent({ calendarId = 'primary', eventId }) {
    const id = validCalendarId(calendarId);
    const data = await this.request(`/calendars/${id}/events/${validEventId(eventId)}`);
    return { event: summarizeEvent(data) };
  }
  async createEvent({ calendarId = 'primary', summary, description, location, start, end, reminders, timeZone } = {}) {
    const id = validCalendarId(calendarId);
    if (typeof summary !== 'string' || summary.trim() === '') throw new Error('Event summary is required.');
    const zone = timeZone || this.timeZone;
    const body = {
      summary: cleanText(summary, 1024),
      start: eventTime(start, zone, 'start'),
      end: eventTime(end, zone, 'end'),
    };
    if (description !== undefined) body.description = cleanText(description, 8000);
    if (location !== undefined) body.location = cleanText(location, 1024);
    const overrides = remindersBody(reminders);
    if (overrides) body.reminders = overrides;
    const data = await this.request(`/calendars/${id}/events`, { method: 'POST', query: { sendUpdates: 'none' }, body });
    return { event: summarizeEvent(data), attendees: 0, notifications: 'none' };
  }
  async updateEvent({ calendarId = 'primary', eventId, summary, description, location, start, end, reminders, timeZone } = {}) {
    const id = validCalendarId(calendarId);
    const event = validEventId(eventId);
    const zone = timeZone || this.timeZone;
    const body = {};
    if (summary !== undefined) { if (typeof summary !== 'string' || summary.trim() === '') throw new Error('Event summary must not be empty.'); body.summary = cleanText(summary, 1024); }
    if (description !== undefined) body.description = cleanText(description, 8000);
    if (location !== undefined) body.location = cleanText(location, 1024);
    if (start !== undefined || end !== undefined) {
      if (start === undefined || end === undefined) throw new Error('Provide both start and end when changing the event time.');
      body.start = eventTime(start, zone, 'start');
      body.end = eventTime(end, zone, 'end');
    }
    const overrides = remindersBody(reminders);
    if (overrides) body.reminders = overrides;
    if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update.');
    const data = await this.request(`/calendars/${id}/events/${event}`, { method: 'PATCH', query: { sendUpdates: 'none' }, body });
    return { event: summarizeEvent(data), attendees: 0, notifications: 'none' };
  }
  async deleteEvent({ calendarId = 'primary', eventId } = {}) {
    const id = validCalendarId(calendarId);
    const event = validEventId(eventId);
    await this.request(`/calendars/${id}/events/${event}`, { method: 'DELETE', query: { sendUpdates: 'none' } });
    return { deleted: true, calendarId: id, eventId: event, notifications: 'none' };
  }
  async freeBusy({ timeMin, timeMax, calendarIds = ['primary'] } = {}) {
    if (!Array.isArray(calendarIds) || calendarIds.length === 0) throw new Error('Provide at least one calendar id.');
    const body = {
      timeMin: toInstant(timeMin, this.timeZone),
      timeMax: toInstant(timeMax, this.timeZone),
      items: calendarIds.slice(0, 20).map(calendarId => ({ id: validCalendarId(calendarId) })),
    };
    const data = await this.request('/freeBusy', { method: 'POST', body });
    const calendars = {};
    for (const [id, value] of Object.entries(data.calendars || {})) calendars[id] = { busy: value.busy || [], errors: value.errors };
    return { timeMin: body.timeMin, timeMax: body.timeMax, calendars };
  }
}
