# gmail-mcp-multi

A Gmail MCP server with native multi-account support. It lets an MCP client use one server process for multiple Gmail accounts by passing an `account` alias or email address on each Gmail tool call.

## Current Status

This project currently supports Gmail account authentication, mailbox search, full message reads, label listing, draft creation, threaded reply draft creation, and private local attachment downloads.

Some mutating capabilities are intentionally not exposed. See [Not Yet Working](#not-yet-working) before relying on unsupported email operations.

## What Works

- Multi-account configuration using local aliases such as `work` or `personal`.
- OAuth authentication through the `authenticate` MCP tool or the `gmail-mcp-multi-auth` CLI.
- Gmail token refresh for authenticated accounts.
- Searching and listing messages with Gmail query syntax.
- Listing conversation thread IDs with Gmail query syntax.
- Reading full Gmail messages, including payload parts and attachment metadata.
- Listing labels for an account.
- Creating standalone plain-text Gmail drafts.
- Creating threaded plain-text reply drafts with reply-all recipient defaults.
- Downloading attachments to a private local directory.
- Attachment downloads by exact filename, current Gmail attachment ID, part ID, `X-Attachment-Id`, or `Content-ID`.
- Recursive traversal of nested MIME parts.
- Collision-safe attachment saves, for example `report.pdf`, `report-1.pdf`, `report-2.pdf`.

## Not Yet Working

This tool schema is currently advertised, but the server handler does not implement it yet. Calling it returns `Unknown tool: <name>`.

| Tool | Current behavior |
|------|------------------|
| `modify_email` | Schema exists, handler is missing |

These capabilities are not currently exposed by the tool list:

- Send email. This server creates drafts only and does not expose or call Gmail send APIs.
- Delete or trash email
- Batch modify email
- Batch delete email
- Create label
- Delete label

## Installation

This package is not published to the npm registry yet. Install it from a local checkout.

Build first, then install globally from the repository root. The global CLI commands point at files in `dist/`, so `npm install -g .` must be run after `npm run build`:

```bash
npm install
npm run build
npm install -g .
```

This creates global commands that can be reused by any MCP client:

```bash
gmail-mcp-multi
gmail-mcp-multi-auth
```

After that, any MCP client can reuse the same globally installed server by running `gmail-mcp-multi` directly:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "gmail-mcp-multi"
    }
  }
}
```

If you change the source later, rebuild and reinstall so the global command uses the updated `dist/` files:

```bash
npm run build
npm install -g .
```

Restart any already-running MCP client or server process after rebuilding or reinstalling.

## OAuth Setup

Create OAuth credentials in Google Cloud:

1. Open Google Cloud Console.
2. Create or choose a project.
3. Enable the Gmail API.
4. Create OAuth 2.0 credentials for a Desktop app.
5. Save the credentials JSON as `~/.gmail-mcp/oauth-keys.json`.

Current runtime behavior expects an `installed` OAuth client in `oauth-keys.json`.

## MCP Client Configuration

Example Claude Code configuration after installing globally from this checkout:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "gmail-mcp-multi"
    }
  }
}
```

## Authentication

Authenticate from an MCP client:

```js
authenticate({ alias: "work", email: "you@company.com" })
authenticate({ alias: "personal", email: "you@example.com" })
```

Or authenticate with the CLI:

```bash
gmail-mcp-multi-auth --alias personal --email you@example.com
```

The `access` option accepts `readonly`, `compose`, `modify`, or `full`; it defaults to `compose`. The default requests the scopes needed by the currently working tools: read/search/download plus draft creation. Existing accounts can be re-authenticated with the same alias and no `access` parameter to get the default scopes.

`compose` requests Google's `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.compose` scopes. Google treats the compose scope as draft-management and send-capable, but this server enforces draft-only behavior by exposing only draft tools and never implementing Gmail send calls. Use `readonly` explicitly only if you want an account token that cannot create drafts.

## Working Tools

All Gmail tools require an `account` value unless noted otherwise. The value can be an account alias or configured email address.

### `list_accounts`

Lists configured accounts and whether local credentials exist.

```js
list_accounts()
```

### `authenticate`

Adds or re-authenticates an account. Opens a browser when available and also prints the OAuth URL.

```js
authenticate({
  alias: "personal",
  email: "you@example.com",
  access: "compose"
})
```

### `search_emails`, `search_messages`, and `list_messages`

Searches or lists Gmail messages using Gmail query syntax. These are the mailbox message listing tools: use broad queries such as `in:inbox` or `in:anywhere` when you want recent messages, then call `read_email` with a returned `id` when you need full message content.

`search_emails` and `search_messages` are equivalent and require `query`. `list_messages` defaults to `query: "in:inbox"` when no query is provided.

```js
search_emails({
  account: "personal",
  query: "in:inbox has:attachment",
  maxResults: 10
})
```

Equivalent message-listing calls:

```js
search_messages({
  account: "personal",
  query: "in:anywhere newer_than:7d",
  maxResults: 25
})

list_messages({
  account: "personal",
  maxResults: 25
})
```

Useful query examples:

- `in:inbox` lists inbox messages.
- `in:anywhere newer_than:7d` searches all mail from the last seven days.
- `is:unread`, `from:alice@example.com`, `to:bob@example.com`, `subject:invoice`, `has:attachment`, `after:2026/01/01`, and `before:2026/02/01` use Gmail's native search filters.

Pagination:

```js
search_emails({
  account: "personal",
  query: "in:anywhere",
  maxResults: 25,
  pageToken: "..."
})
```

Returns lightweight metadata:

```json
{
  "query": "in:inbox has:attachment",
  "count": 1,
  "resultSizeEstimate": 12,
  "nextPageToken": "...",
  "messages": [
    {
      "id": "18f...",
      "threadId": "18e...",
      "labelIds": ["INBOX", "IMPORTANT"],
      "snippet": "The preview text from Gmail...",
      "internalDate": "1760000000000",
      "subject": "Quarterly report",
      "from": "Alice <alice@example.com>",
      "to": "you@example.com",
      "cc": "team@example.com",
      "date": "Fri, 1 May 2026 09:00:00 +0000",
      "rfcMessageId": "<message-id@example.com>"
    }
  ]
}
```

### `list_threads`

Lists Gmail conversation threads directly and returns thread IDs. It defaults to `query: "in:inbox"` when no query is provided. Use this when you need to discover the latest conversation/thread ID before deciding which message to read.

```js
list_threads({
  account: "personal",
  query: "in:anywhere newer_than:7d",
  maxResults: 10
})
```

Returns lightweight thread metadata:

```json
{
  "tool": "list_threads",
  "query": "in:anywhere newer_than:7d",
  "count": 1,
  "resultSizeEstimate": 3,
  "nextPageToken": "...",
  "threads": [
    {
      "id": "18e...",
      "threadId": "18e...",
      "snippet": "The preview text from Gmail...",
      "historyId": "123456"
    }
  ]
}
```

### `read_email`

Fetches the full Gmail message with `format: "full"`. The returned payload includes nested MIME parts, headers, filenames, MIME types, part IDs, and `body.attachmentId` values when Gmail provides them.

```js
read_email({
  account: "personal",
  messageId: "18f..."
})
```

### `download_attachment`

Downloads one attachment to disk and returns JSON metadata:

```json
{
  "account": "personal",
  "messageId": "18f...",
  "attachmentId": "...",
  "filename": "report.pdf",
  "mimeType": "application/pdf",
  "size": 12345,
  "path": "/Users/you/.gmail-mcp/downloads/personal/18f.../report.pdf"
}
```

Recommended filename-based usage:

```js
download_attachment({
  account: "personal",
  messageId: "18f...",
  filename: "report.pdf"
})
```

ID-based usage:

```js
download_attachment({
  account: "personal",
  messageId: "18f...",
  attachmentId: "ANGjdJ..."
})
```

Attachment resolution behavior:

- If `filename` is provided, the server re-fetches the message, finds the exact filename in nested MIME parts, and immediately downloads using the current `body.attachmentId` from that same payload.
- If only `attachmentId` is provided, the server first tries `users.messages.attachments.get` directly with that ID.
- If direct ID download fails, the server re-fetches the payload and matches the supplied value against current `body.attachmentId`, `partId`, `X-Attachment-Id`, or `Content-ID`.
- If direct ID download succeeds but Gmail's fresh payload no longer contains that same ID, the server tries to recover the filename by matching the unique downloaded byte size against current attachment parts.
- If no attachment matches, the error includes available attachment filenames and part IDs.

Saved files:

- Are written under `~/.gmail-mcp/downloads/<account>/<messageId>/`.
- Use private directories with mode `0700`.
- Use private files with mode `0600`.
- Never accept an arbitrary output directory.
- Sanitize filenames to prevent path traversal.
- Auto-rename on collision.

### `create_draft`

Creates a standalone plain-text Gmail draft and returns minimal draft metadata. It does not send email.

```js
create_draft({
  account: "personal",
  to: ["friend@example.com"],
  cc: ["team@example.com"],
  subject: "Coffee next week",
  body: "Are you free Tuesday morning?"
})
```

Returns:

```json
{
  "account": "personal",
  "draftId": "r...",
  "messageId": "18f...",
  "threadId": "18f...",
  "to": ["friend@example.com"],
  "cc": ["team@example.com"],
  "bcc": [],
  "subject": "Coffee next week"
}
```

### `create_reply_draft`

Creates a plain-text draft reply attached to the source Gmail thread. By default, recipients are reply-all style: `To` is the source `Reply-To` or `From`, and `Cc` includes the original `To` and `Cc` recipients while excluding the authenticated account and duplicates. Passing `to`, `cc`, or `bcc` overrides that field.

```js
create_reply_draft({
  account: "personal",
  messageId: "18f...",
  body: "Thanks, I will take a look."
})
```

Override recipients or subject when needed:

```js
create_reply_draft({
  account: "personal",
  messageId: "18f...",
  to: ["sender@example.com"],
  cc: [],
  subject: "Re: Updated proposal",
  body: "Thanks, I will take a look."
})
```

Returns:

```json
{
  "account": "personal",
  "draftId": "r...",
  "messageId": "18f...",
  "threadId": "18e...",
  "replyToMessageId": "<source-message-id@example.com>",
  "to": ["sender@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Re: Updated proposal"
}
```

### `list_labels`

Lists Gmail labels for an account.

```js
list_labels({
  account: "personal"
})
```

## Local Files

Credentials and downloads are stored under `~/.gmail-mcp/`:

```text
~/.gmail-mcp/
├── config.json
├── oauth-keys.json
├── downloads/
│   └── personal/
│       └── <messageId>/
│           └── report.pdf
└── accounts/
    ├── work/
    │   └── credentials.json
    └── personal/
        └── credentials.json
```

The repository `.gitignore` excludes credentials and build output. Do not commit real OAuth keys, account credentials, downloaded attachments, or mailbox data.

## Development

```bash
git clone https://github.com/dmorrill/gmail-mcp-multi.git
cd gmail-mcp-multi
npm install
npm run build
npm run dev
```

There is currently no `npm test` script. Use `npm run build` as the baseline verification.

## License

MIT
