import { Tool, CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { gmail_v1 } from "googleapis";
import addressparser from "nodemailer/lib/addressparser/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import Mail from "nodemailer/lib/mailer/index.js";
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
          enum: ["readonly", "compose", "modify", "full"],
          description: "Gmail access level to request (default: compose)",
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
    name: "create_draft",
    description: "Create a new Gmail draft. This tool never sends email.",
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
    name: "create_reply_draft",
    description:
      "Create a Gmail draft reply in the source message thread. This tool never sends email.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account alias or email to use",
        },
        messageId: {
          type: "string",
          description: "The ID of the email message to reply to",
        },
        body: {
          type: "string",
          description: "Reply body (plain text)",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description:
            "Override reply recipients. Defaults to Reply-To or From on the source message.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description:
            "Override CC recipients. Defaults to original To and Cc, excluding the authenticated account and duplicates.",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "BCC recipients",
        },
        subject: {
          type: "string",
          description:
            "Override reply subject. Defaults to the source subject with Re: prefix when needed.",
        },
      },
      required: ["account", "messageId", "body"],
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
          access?: "readonly" | "compose" | "modify" | "full";
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

      case "create_draft": {
        const { account, to, subject, body, cc, bcc } = args as {
          account: string;
          to: string[];
          subject: string;
          body: string;
          cc?: string[];
          bcc?: string[];
        };
        const accountConfig = getAccountConfig(accountManager, account);
        const parsedTo = parseAddressList(to, "to");
        const parsedCc = parseAddressList(cc, "cc");
        const parsedBcc = parseAddressList(bcc, "bcc");
        validateNonEmptyRecipients(parsedTo, parsedCc, parsedBcc);
        const cleanSubject = validateRequiredHeaderValue(subject, "subject");
        const cleanBody = validateRequiredBody(body);

        const raw = await buildMimeMessage({
          from: accountConfig.email,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject: cleanSubject,
          body: cleanBody,
        });

        const client = await gmailClient.getClient(account);
        const draft = await client.users.drafts.create({
          userId: "me",
          requestBody: {
            message: {
              raw,
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  account: accountConfig.alias,
                  draftId: draft.data.id,
                  messageId: draft.data.message?.id,
                  threadId: draft.data.message?.threadId,
                  to: formatAddressList(parsedTo),
                  cc: formatAddressList(parsedCc),
                  bcc: formatAddressList(parsedBcc),
                  subject: cleanSubject,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "create_reply_draft": {
        const { account, messageId, body, to, cc, bcc, subject } = args as {
          account: string;
          messageId: string;
          body: string;
          to?: string[];
          cc?: string[];
          bcc?: string[];
          subject?: string;
        };
        const accountConfig = getAccountConfig(accountManager, account);
        const cleanBody = validateRequiredBody(body);
        const overrideTo =
          to === undefined ? undefined : parseAddressList(to, "to");
        const overrideCc =
          cc === undefined ? undefined : parseAddressList(cc, "cc");
        const parsedBcc = parseAddressList(bcc, "bcc");
        const subjectOverride =
          subject === undefined
            ? undefined
            : validateRequiredHeaderValue(subject, "subject");

        const client = await gmailClient.getClient(account);
        const source = await client.users.messages.get({
          userId: "me",
          id: messageId,
          format: "metadata",
          metadataHeaders: [
            "Message-ID",
            "References",
            "Reply-To",
            "From",
            "To",
            "Cc",
            "Subject",
          ],
        });
        if (!source.data.threadId) {
          throw new Error(
            `Source message ${messageId} has no threadId; refusing to create an unthreaded reply draft`
          );
        }

        const headers = source.data.payload?.headers || [];
        const sourceMessageId = validateMessageIdHeader(
          getHeaderValue(headers, "Message-ID"),
          messageId
        );
        const references = buildReferencesHeader(
          getHeaderValue(headers, "References"),
          sourceMessageId
        );
        const computedSubject = getReplySubject(getHeaderValue(headers, "Subject"));
        const cleanSubject = subjectOverride ?? computedSubject;

        const computedTo = removeDuplicateAddresses(
          parseAddressHeader(
            getHeaderValue(headers, "Reply-To") || getHeaderValue(headers, "From"),
            "source Reply-To/From"
          ),
          accountConfig.email
        );
        const computedCc = removeDuplicateAddresses(
          [
            ...parseAddressHeader(getHeaderValue(headers, "To"), "source To"),
            ...parseAddressHeader(getHeaderValue(headers, "Cc"), "source Cc"),
          ],
          accountConfig.email,
          computedTo
        );

        const parsedTo = overrideTo ?? computedTo;
        const parsedCc = removeDuplicateAddresses(
          overrideCc ?? computedCc,
          undefined,
          parsedTo
        );
        validateNonEmptyRecipients(parsedTo, parsedCc, parsedBcc);

        const raw = await buildMimeMessage({
          from: accountConfig.email,
          to: parsedTo,
          cc: parsedCc,
          bcc: parsedBcc,
          subject: cleanSubject,
          body: cleanBody,
          inReplyTo: sourceMessageId,
          references,
        });

        const draft = await client.users.drafts.create({
          userId: "me",
          requestBody: {
            message: {
              raw,
              threadId: source.data.threadId,
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  account: accountConfig.alias,
                  draftId: draft.data.id,
                  messageId: draft.data.message?.id,
                  threadId: draft.data.message?.threadId,
                  replyToMessageId: sourceMessageId,
                  to: formatAddressList(parsedTo),
                  cc: formatAddressList(parsedCc),
                  bcc: formatAddressList(parsedBcc),
                  subject: cleanSubject,
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

function getHeaderValue(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string
): string | undefined {
  return (
    headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())
      ?.value || undefined
  );
}

interface ParsedAddress {
  name: string;
  address: string;
}

interface MimeDraftOptions {
  from: string;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

function getAccountConfig(accountManager: AccountManager, account: string) {
  const accountConfig = accountManager.getAccount(account);
  if (!accountConfig) {
    throw new Error(`Account not found: ${account}`);
  }
  return accountConfig;
}

function parseAddressList(values: string[] | undefined, field: string): ParsedAddress[] {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array of email addresses`);
  }

  return removeDuplicateAddresses(
    values.flatMap((value, index) =>
      parseAddressHeader(value, `${field}[${index}]`)
    )
  );
}

function parseAddressHeader(
  value: string | undefined,
  field: string
): ParsedAddress[] {
  if (!value) {
    return [];
  }
  validateNoHeaderInjection(value, field);

  const parsed = addressparser(value, { flatten: true }).map((address) => ({
    name: address.name || "",
    address: address.address || "",
  }));
  if (parsed.length === 0) {
    throw new Error(`${field} must contain at least one valid email address`);
  }

  for (const address of parsed) {
    validateNoHeaderInjection(address.name, `${field} display name`);
    validateNoHeaderInjection(address.address, `${field} address`);
    if (!isValidEmailAddress(address.address)) {
      throw new Error(`Malformed email address in ${field}: ${address.address}`);
    }
  }

  return parsed;
}

function isValidEmailAddress(address: string): boolean {
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(address);
}

function removeDuplicateAddresses(
  addresses: ParsedAddress[],
  excludeAddress?: string,
  existingAddresses: ParsedAddress[] = []
): ParsedAddress[] {
  const seen = new Set(
    existingAddresses.map((address) => address.address.toLowerCase())
  );
  if (excludeAddress) {
    seen.add(excludeAddress.toLowerCase());
  }

  const unique: ParsedAddress[] = [];
  for (const address of addresses) {
    const key = address.address.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(address);
  }
  return unique;
}

function validateNonEmptyRecipients(
  to: ParsedAddress[],
  cc: ParsedAddress[],
  bcc: ParsedAddress[]
): void {
  if (to.length + cc.length + bcc.length === 0) {
    throw new Error("At least one recipient is required");
  }
}

function validateRequiredHeaderValue(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  validateNoHeaderInjection(value, field);
  return value.trim();
}

function validateRequiredBody(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("body is required");
  }
  return value;
}

function validateNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Header injection characters are not allowed in ${field}`);
  }
}

function validateMessageIdHeader(
  value: string | undefined,
  gmailMessageId: string
): string {
  if (!value) {
    throw new Error(
      `Source message ${gmailMessageId} is missing Message-ID; refusing to create an orphan reply draft`
    );
  }
  validateNoHeaderInjection(value, "source Message-ID");
  return value.trim();
}

function buildReferencesHeader(
  existingReferences: string | undefined,
  sourceMessageId: string
): string {
  if (existingReferences) {
    validateNoHeaderInjection(existingReferences, "source References");
  }
  const references = existingReferences?.trim();
  if (!references) {
    return sourceMessageId;
  }
  return `${references} ${sourceMessageId}`;
}

function getReplySubject(subject: string | undefined): string {
  const cleanSubject = subject?.trim() || "";
  validateNoHeaderInjection(cleanSubject, "source Subject");
  if (/^re:/i.test(cleanSubject)) {
    return cleanSubject;
  }
  return `Re: ${cleanSubject}`;
}

function formatAddressList(addresses: ParsedAddress[]): string[] {
  return addresses.map((address) =>
    address.name ? `${address.name} <${address.address}>` : address.address
  );
}

async function buildMimeMessage(options: MimeDraftOptions): Promise<string> {
  const mailOptions: Mail.Options = {
    from: options.from,
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject: options.subject,
    text: options.body,
    textEncoding: "quoted-printable",
    xMailer: false,
  };

  if (options.inReplyTo) {
    mailOptions.inReplyTo = options.inReplyTo;
  }
  if (options.references) {
    mailOptions.references = options.references;
  }

  const message = await new MailComposer(mailOptions).compile().build();
  return message.toString("base64url");
}
