import { Tool, CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { AccountManager } from "../accounts.js";
import {
  findAttachmentPart,
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
          description: "The attachment ID from the message payload",
        },
        filename: {
          type: "string",
          description: "Optional basename-only override for the saved file",
        },
      },
      required: ["account", "messageId", "attachmentId"],
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
          attachmentId: string;
          filename?: string;
        };
        const accountConfig = accountManager.getAccount(account);
        if (!accountConfig) {
          throw new Error(`Account not found: ${account}`);
        }

        const client = await gmailClient.getClient(account);
        const message = await client.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });
        const attachmentPart = findAttachmentPart(
          message.data.payload,
          attachmentId
        );
        if (!attachmentPart) {
          throw new Error(
            `Attachment ID not found in message payload: ${attachmentId}`
          );
        }

        const attachment = await client.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: attachmentId,
        });
        if (attachment.data.data == null) {
          throw new Error(
            `Gmail returned no data for attachment ID: ${attachmentId}`
          );
        }

        const data = Buffer.from(attachment.data.data, "base64url");
        const resolvedFilename = resolveAttachmentFilename({
          attachmentId,
          messagePartFilename: attachmentPart.filename,
          overrideFilename: filename,
        });
        const saved = saveAttachmentData({
          accountAlias: accountConfig.alias,
          messageId,
          filename: resolvedFilename,
          data,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  account: accountConfig.alias,
                  messageId,
                  attachmentId,
                  filename: saved.filename,
                  mimeType:
                    attachmentPart.mimeType || "application/octet-stream",
                  size: data.length,
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
