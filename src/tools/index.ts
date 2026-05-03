import { Tool, CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { gmail_v1 } from "googleapis";
import { AccountManager } from "../accounts.js";
import {
  AttachmentPartInfo,
  describeAvailableAttachments,
  findAttachmentPartByAnyId,
  findAttachmentPartByFilename,
  findAttachmentPartByUniqueSize,
  resolveAttachmentFilename,
  saveAttachmentData,
} from "../attachments.js";
import { GmailClient } from "../gmail.js";
import { authenticateAccount } from "../oauth.js";

export const tools: Tool[] = [
  {
    name: "list_accounts",
    description: "List all configured Gmail accounts and their authentication status",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "authenticate",
    description: "Add or re-authenticate a Gmail account. Opens browser for OAuth flow.",
    inputSchema: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description: "Friendly name for this account (e.g., 'work', 'personal')",
        },
        email: {
          type: "string",
          description: "Email address for this account (used as login hint)",
        },
        access: {
          type: "string",
          enum: ["readonly", "modify", "full"],
          description: "Gmail access level to request (default: readonly)",
        },
      },
      required: ["alias"],
    },
  },
  {
    name: "search_emails",
    description: "Search for emails using Gmail query syntax",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account alias or email to use",
        },
        query: {
          type: "string",
          description: "Gmail search query (e.g., 'in:inbox is:unread')",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
      },
      required: ["account", "query"],
    },
  },
  {
    name: "read_email",
    description: "Get the full content of an email by ID",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account alias or email to use",
        },
        messageId: {
          type: "string",
          description: "The ID of the email message",
        },
      },
      required: ["account", "messageId"],
    },
  },
  {
    name: "download_attachment",
    description: "Download a Gmail attachment to a private local directory",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account alias or email to use",
        },
        messageId: {
          type: "string",
          description: "The ID of the email message",
        },
        attachmentId: {
          type: "string",
          description: "The attachment ID, part ID, X-Attachment-Id, or Content-ID from the message payload",
        },
        filename: {
          type: "string",
          description: "Exact Gmail attachment filename to download",
        },
      },
      required: ["account", "messageId"],
    },
  },
  {
    name: "send_email",
    description: "Send a new email",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account alias or email to use",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Email body (plain text)",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC recipients",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "BCC recipients",
        },
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  {
    name: "list_labels",
    description: "Get all labels for an account",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account alias or email to use",
        },
      },
      required: ["account"],
    },
  },
  {
    name: "modify_email",
    description: "Modify email labels (add/remove labels, mark read/unread)",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account alias or email to use",
        },
        messageId: {
          type: "string",
          description: "The ID of the email message",
        },
        addLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to add",
        },
        removeLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to remove",
        },
      },
      required: ["account", "messageId"],
    },
  },
];

export async function handleToolCall(
  request: CallToolRequest,
  accountManager: AccountManager,
  gmailClient: GmailClient
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_accounts": {
        const accounts = accountManager.listAccounts();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ accounts }, null, 2),
            },
          ],
        };
      }

      case "authenticate": {
        const { alias, email, access } = args as {
          alias: string;
          email?: string;
          access?: "readonly" | "modify" | "full";
        };
        const account = await authenticateAccount(accountManager, {
          alias,
          email,
          access,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(account, null, 2),
            },
          ],
        };
      }

      case "search_emails": {
        const { account, query, maxResults = 10 } = args as {
          account: string;
          query: string;
          maxResults?: number;
        };
        const client = await gmailClient.getClient(account);
        const response = await client.users.messages.list({
          userId: "me",
          q: query,
          maxResults,
        });

        const messages = response.data.messages || [];
        const results = await Promise.all(
          messages.map(async (msg) => {
            const full = await client.users.messages.get({
              userId: "me",
              id: msg.id!,
              format: "metadata",
              metadataHeaders: ["From", "To", "Subject", "Date"],
            });
            const headers = full.data.payload?.headers || [];
            return {
              id: msg.id,
              subject: headers.find((h) => h.name === "Subject")?.value,
              from: headers.find((h) => h.name === "From")?.value,
              date: headers.find((h) => h.name === "Date")?.value,
            };
          })
        );

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }

      case "read_email": {
        const { account, messageId } = args as {
          account: string;
          messageId: string;
        };
        const client = await gmailClient.getClient(account);
        const response = await client.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });

        return {
          content: [
            { type: "text", text: JSON.stringify(response.data, null, 2) },
          ],
        };
      }

      case "download_attachment": {
        const { account, messageId, attachmentId, filename } = args as {
          account: string;
          messageId: string;
          attachmentId?: string;
          filename?: string;
        };
        if (!attachmentId && !filename) {
          throw new Error(
            "download_attachment requires either attachmentId or filename"
          );
        }

        const accountConfig = accountManager.getAccount(account);
        if (!accountConfig) {
          throw new Error(`Account not found: ${account}`);
        }

        const client = await gmailClient.getClient(account);
        const download = filename
          ? await downloadAttachmentByFilename(client, messageId, filename)
          : await downloadAttachmentById(client, messageId, attachmentId!);

        const resolvedFilename = resolveAttachmentFilename({
          attachmentId: download.attachmentId,
          messagePartFilename: download.attachmentPart?.filename,
        });
        const saved = saveAttachmentData({
          accountAlias: accountConfig.alias,
          messageId,
          filename: resolvedFilename,
          data: download.data,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  account: accountConfig.alias,
                  messageId,
                  attachmentId: download.attachmentId,
                  filename: saved.filename,
                  mimeType:
                    download.attachmentPart?.mimeType ||
                    "application/octet-stream",
                  size: download.data.length,
                  path: saved.path,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_labels": {
        const { account } = args as { account: string };
        const client = await gmailClient.getClient(account);
        const response = await client.users.labels.list({ userId: "me" });

        return {
          content: [
            { type: "text", text: JSON.stringify(response.data.labels, null, 2) },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
}

interface AttachmentDownload {
  attachmentId: string;
  attachmentPart?: AttachmentPartInfo;
  data: Buffer;
}

async function downloadAttachmentByFilename(
  client: gmail_v1.Gmail,
  messageId: string,
  filename: string
): Promise<AttachmentDownload> {
  const payload = await getMessagePayload(client, messageId);
  const attachmentPart = findAttachmentPartByFilename(payload, filename);
  if (!attachmentPart) {
    throw new Error(
      `Attachment filename not found in message payload: ${filename}. ${describeAvailableAttachments(payload)}`
    );
  }
  if (!attachmentPart.attachmentId) {
    throw new Error(
      `Attachment filename matched but has no downloadable body.attachmentId: ${filename}. ${describeAvailableAttachments(payload)}`
    );
  }

  return {
    attachmentId: attachmentPart.attachmentId,
    attachmentPart,
    data: await getAttachmentData(client, messageId, attachmentPart.attachmentId),
  };
}

async function downloadAttachmentById(
  client: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string
): Promise<AttachmentDownload> {
  try {
    const data = await getAttachmentData(client, messageId, attachmentId);
    let attachmentPart: AttachmentPartInfo | undefined;
    try {
      const payload = await getMessagePayload(client, messageId);
      attachmentPart =
        findAttachmentPartByAnyId(payload, attachmentId) ||
        findAttachmentPartByUniqueSize(payload, data.length);
    } catch {
      attachmentPart = undefined;
    }

    return {
      attachmentId,
      attachmentPart,
      data,
    };
  } catch (directError) {
    const payload = await getMessagePayload(client, messageId);
    const attachmentPart = findAttachmentPartByAnyId(payload, attachmentId);
    if (!attachmentPart) {
      throw new Error(
        `Attachment not found for ID, part ID, X-Attachment-Id, or Content-ID: ${attachmentId}. Direct attachment download failed: ${getErrorMessage(directError)}. ${describeAvailableAttachments(payload)}`
      );
    }
    if (!attachmentPart.attachmentId) {
      throw new Error(
        `Attachment identifier matched but has no downloadable body.attachmentId: ${attachmentId}. ${describeAvailableAttachments(payload)}`
      );
    }

    return {
      attachmentId: attachmentPart.attachmentId,
      attachmentPart,
      data: await getAttachmentData(client, messageId, attachmentPart.attachmentId),
    };
  }
}

async function getMessagePayload(
  client: gmail_v1.Gmail,
  messageId: string
): Promise<gmail_v1.Schema$MessagePart | undefined> {
  const message = await client.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return message.data.payload;
}

async function getAttachmentData(
  client: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const attachment = await client.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  if (attachment.data.data == null) {
    throw new Error(`Gmail returned no data for attachment ID: ${attachmentId}`);
  }

  return Buffer.from(attachment.data.data, "base64url");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
