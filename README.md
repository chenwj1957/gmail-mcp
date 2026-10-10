# Gmail draft MCP

A local stdio MCP server for Gmail. Requires Node.js 22 or newer.

## Tools

| Tool | Inputs and result |
| --- | --- |
| `gmail_search_email` | Gmail `query`, optional `limit` (1–1000), `pageToken`, `includeSpamTrash`; returns message IDs and continuation token |
| `gmail_read_email` | `messageId`; returns headers, decoded text/HTML and attachment identifiers |
| `gmail_download_email` | `messageId`; saves original RFC 822 email as `.eml` |
| `gmail_download_attachment` | `messageId` and `attachmentId` or `partId`; saves attachment bytes |
| `gmail_draft_email` | `to` array, `subject`, `text`, optional `cc`, `bcc`, `html`; creates a Gmail draft |

Search follows pages up to the limit. Pass `nextPageToken` as `pageToken` to continue.
Read and download operations do not change mailbox labels or read status.
Draft creation is the only mailbox write. There is no send, delete, archive,
arbitrary HTTP, shell, or file-reading tool. Downloads use unique filenames in
one configured directory; tools cannot choose arbitrary destination paths.

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

The Google scopes are `gmail.readonly` and `gmail.compose`. Google has no
draft-only OAuth scope: **compose also authorizes sending**. This server
enforces draft-only behavior with a request allowlist that permits only message
GETs and POST `/drafts`. Protect the token: other software holding it could send.
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
