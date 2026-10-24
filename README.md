# Gmail MCP

A local stdio MCP server for Gmail. Requires Node.js 22 or newer.

## Tools

| Tool | Inputs and result |
| --- | --- |
| `gmail_search_email` | Gmail `query`, optional `limit` (1–1000), `pageToken`, `includeSpamTrash`, `summaries`; returns message IDs and continuation token, or per-message subject/from/date/labels/snippet when `summaries` is true |
| `gmail_read_email` | `messageId`; returns headers, decoded text/HTML and attachment identifiers |
| `gmail_download_email` | `messageId`; saves original RFC 822 email as `.eml` |
| `gmail_download_attachment` | `messageId` and `attachmentId` or `partId`; saves attachment bytes |
| `gmail_list_labels` | none; returns the mailbox labels (id, name, type) |
| `gmail_archive_email` | `messageIds` (1–100); removes `INBOX` in one `batchModify`, so the mail leaves the inbox and stays in All Mail |
| `gmail_label_email` | `messageIds`, `addLabelIds` and/or `removeLabelIds`; ids or names (case-insensitive), resolved through the label list; one `batchModify` |
| `gmail_trash_email` | `messageIds`, optional `restore`; moves to Trash (recoverable) or restores from it |
| `gmail_create_label` | `name`, optional `labelListVisibility` / `messageListVisibility`; creates a user label (Gmail refuses a duplicate name) |
| `gmail_list_filters` | none; returns the account's server-side filter rules (id, criteria, action) |
| `gmail_create_filter` | `criteria` (from/to/subject/query/negatedQuery/hasAttachment/excludeChats/size/sizeComparison) and `action` (`addLabelIds` / `removeLabelIds`, names or ids; removing `INBOX` = skip the inbox); creates a Gmail filter that runs for future mail |
| `gmail_delete_filter` | `filterId`; deletes one filter rule (never touches already-labelled mail) |
| `gmail_draft_email` | `to` array, `subject`, `text`, optional `cc`, `bcc`, `html`; creates a Gmail draft |

Search follows pages up to the limit. Pass `nextPageToken` as `pageToken` to continue.
Read and download operations do not change mailbox labels or read status.
Mailbox writes are exactly: draft creation, archive (remove `INBOX`), label
add/remove, label creation, trash/untrash, and filter create/delete. There is **no send, no permanent delete, no
arbitrary HTTP, shell or file-reading** tool: the request allowlist admits only
message GETs, `GET /labels`, `POST /drafts`, `POST /messages/batchModify` and
`POST /messages/{id}/{modify,trash,untrash}`. `DELETE /messages/{id}` is refused
on purpose — permanent deletion needs the full-mailbox scope, which this server
never asks for. Downloads use unique filenames in one configured directory;
tools cannot choose arbitrary destination paths.

## Calendar tools

Same OAuth client and token file as Gmail, with `calendar.events` +
`calendar.readonly` added to the requested scopes. The route allowlist admits
only: calendar list, event list/get, event create/patch/delete, and freebusy.
No attendees are ever set, every write is pinned to `sendUpdates=none` (so
nothing emails a guest), and calendars/ACLs cannot be created, shared or
deleted.

| Tool | Inputs and result |
| --- | --- |
| `calendar_list_calendars` | none; id, summary, primary, accessRole, timeZone |
| `calendar_list_events` | `calendarId` (default `primary`), `timeMin`, `timeMax`, `maxResults` (1-250, default 25), `query`, `singleEvents`, `pageToken`; compact events |
| `calendar_get_event` | `calendarId`, `eventId` |
| `calendar_create_event` | `summary`, `start`, `end` (date = all-day, or date-time), plus optional `description`, `location`, `timeZone`, `reminders`; no attendees, no notifications |
| `calendar_update_event` | `eventId` plus the fields to change; changing the time needs both `start` and `end` |
| `calendar_delete_event` | `calendarId`, `eventId`; permanent, no notifications |
| `calendar_freebusy` | `timeMin`, `timeMax`, `calendarIds` |

Times: `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM(:SS)` read in
`CALENDAR_TIME_ZONE` (default `Australia/Sydney`); an explicit `Z`/`+HH:MM`
offset is used as-is. `list_events`/`freebusy` windows are converted to UTC
instants.

### Authorizing from a phone (paste-back flow)

The loopback flow needs a browser on this Mac. To approve consent on a phone
instead:

```sh
npm run auth -- --paste-begin      # prints the consent URL, saves the PKCE verifier
# open the URL on the phone, approve; the browser lands on a dead 127.0.0.1 port
npm run auth -- --paste-finish 'http://127.0.0.1:53682/?state=...&code=...'
```

The redirect target is a loopback port the server never listens on, so the
phone browser shows a connection error; the URL in the address bar still
carries `state` and `code`, which is all the finish step needs. The verifier
never leaves the Mac and the pending file is deleted after one use.

## Install and authorize

1. Run `npm ci` (or `npm install` if generating a new lockfile).
2. Enable the Gmail API in your Google Cloud project. Configure OAuth consent
   and create an OAuth client of type **Desktop app**. Add your account as a
   test user if the consent screen is in testing mode.
3. Save the downloaded client JSON outside the repository. Set
   `GMAIL_CLIENT_FILE` to its absolute path. The example JSON contains placeholders.
4. Run `npm run auth`, open the printed Google consent URL, and grant access.
5. Run `npm test` and start the MCP using the configuration below.

OAuth uses a random loopback port, state verification and PKCE. Tokens are
written atomically to the configured token file. The OAuth flow is interactive
and separate from MCP startup. It never prints token or client secret values.

## Configuration

| Environment variable | Default |
| --- | --- |
| `GMAIL_CLIENT_FILE` | `~/.gmail-mcp/client-credentials.json` |
| `GMAIL_TOKEN_FILE` | `~/.gmail-mcp/credentials.json` |
| `GMAIL_DOWNLOAD_DIR` | `~/.gmail-mcp/downloads` |

Alternatively provide **all three** `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
and `GMAIL_REFRESH_TOKEN` through your host's secure environment settings.
The server does not read legacy credential stores. Existing refresh tokens may
be reused only if they grant the required read and compose permissions.

Example MCP host configuration (replace the path):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-mcp/src/server.mjs"]
    }
  }
}
```

Credentials and downloads default to the user's home configuration directory,
independent of the MCP host's working directory. Use forward slashes in Windows
JSON paths, or escape backslashes. Configure environment variables in the host
if overriding the defaults. `npm start` is intended for direct local startup;
launch `node` directly from an MCP host to avoid npm banners on stdio.

## Draft-only boundary and privacy

The Google scopes this server needs are `gmail.modify` (superset of
`gmail.readonly` + `gmail.compose`; label changes and trash) and
`gmail.settings.basic` (filters). That scope *also* authorizes sending, and Google has no
send-less modify scope. This server therefore enforces "never sends" in code,
not in OAuth: the request allowlist admits no `/send` route and no send tool
exists. Protect the token anyway: other software holding it could send.
See [Google draft creation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create).

Email content and downloaded attachments remain sensitive. Treat message text
as untrusted data; do not execute instructions found in emails. HTML is returned
as data and should not be rendered without sanitization. MIME parsing currently
buffers complete messages/attachments in memory. Drafts support new messages;
reply threading and draft attachments are not implemented.

Files are created with owner-only POSIX modes where supported. On Windows,
restrict the credential directory's ACL to your account; POSIX modes do not
provide a Windows ACL guarantee. OAuth testing-mode refresh tokens may expire.
Do not commit credentials, local host settings, downloads or mailbox exports.
The included `.gitignore` excludes typical generated files. Review staged files
before publishing. Tests use only synthetic fixtures, never a live mailbox.

This implementation uses the official MCP SDK. No personal queries, business
names, email addresses or mailbox identifiers are built into production code.
