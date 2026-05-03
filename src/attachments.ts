import { gmail_v1 } from "googleapis";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const DOWNLOADS_DIR = path.join(CONFIG_DIR, "downloads");
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_FILENAME_LENGTH = 255;

export interface SavedAttachmentFile {
  filename: string;
  path: string;
}

export interface AttachmentPartInfo {
  part: gmail_v1.Schema$MessagePart;
  filename?: string | null;
  mimeType?: string | null;
  partId?: string | null;
  attachmentId?: string | null;
  xAttachmentId?: string;
  contentId?: string;
}

export function findAttachmentPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  attachmentId: string
): gmail_v1.Schema$MessagePart | undefined {
  if (!part) {
    return undefined;
  }

  if (part.body?.attachmentId === attachmentId) {
    return part;
  }

  for (const child of part.parts || []) {
    const found = findAttachmentPart(child, attachmentId);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function collectAttachmentParts(
  part: gmail_v1.Schema$MessagePart | undefined
): AttachmentPartInfo[] {
  if (!part) {
    return [];
  }

  const current = getAttachmentPartInfo(part);
  const children = (part.parts || []).flatMap((child) =>
    collectAttachmentParts(child)
  );

  return current ? [current, ...children] : children;
}

export function findAttachmentPartByFilename(
  part: gmail_v1.Schema$MessagePart | undefined,
  filename: string
): AttachmentPartInfo | undefined {
  return collectAttachmentParts(part).find((info) => info.filename === filename);
}

export function findAttachmentPartByAnyId(
  part: gmail_v1.Schema$MessagePart | undefined,
  id: string
): AttachmentPartInfo | undefined {
  return collectAttachmentParts(part).find((info) =>
    getAttachmentPartIds(info).includes(id)
  );
}

export function findAttachmentPartByUniqueSize(
  part: gmail_v1.Schema$MessagePart | undefined,
  size: number
): AttachmentPartInfo | undefined {
  const matches = collectAttachmentParts(part).filter(
    (info) => info.part.body?.size === size
  );

  return matches.length === 1 ? matches[0] : undefined;
}

export function describeAvailableAttachments(
  part: gmail_v1.Schema$MessagePart | undefined
): string {
  const attachments = collectAttachmentParts(part);
  if (attachments.length === 0) {
    return "No attachments found in message payload.";
  }

  return `Available attachments: ${attachments
    .map((info) => {
      const details = [
        `filename=${JSON.stringify(info.filename || "")}`,
        `partId=${JSON.stringify(info.partId || "")}`,
      ];

      if (info.attachmentId) {
        details.push(`attachmentId=${JSON.stringify(info.attachmentId)}`);
      }
      if (info.xAttachmentId) {
        details.push(`xAttachmentId=${JSON.stringify(info.xAttachmentId)}`);
      }
      if (info.contentId) {
        details.push(`contentId=${JSON.stringify(info.contentId)}`);
      }

      return details.join(", ");
    })
    .join("; ")}`;
}

export function sanitizeAttachmentFilename(
  filename?: string | null
): string | undefined {
  if (!filename) {
    return undefined;
  }

  const basename = path.posix.basename(filename.replace(/\\/g, "/"));
  const sanitized = basename
    .normalize("NFKC")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!sanitized || sanitized === "." || sanitized === "..") {
    return undefined;
  }

  return truncateFilename(sanitized, MAX_FILENAME_LENGTH);
}

export function resolveAttachmentFilename(options: {
  attachmentId: string;
  messagePartFilename?: string | null;
  overrideFilename?: string | null;
}): string {
  const filename =
    sanitizeAttachmentFilename(options.overrideFilename) ||
    sanitizeAttachmentFilename(options.messagePartFilename);

  if (filename) {
    return filename;
  }

  const safeAttachmentId =
    sanitizeAttachmentFilename(options.attachmentId) || "unknown";
  return truncateFilename(`attachment-${safeAttachmentId}`, MAX_FILENAME_LENGTH);
}

export function saveAttachmentData(options: {
  accountAlias: string;
  messageId: string;
  filename: string;
  data: Buffer;
}): SavedAttachmentFile {
  const directory = getAttachmentDownloadDirectory(
    options.accountAlias,
    options.messageId
  );
  ensurePrivateDirectory(CONFIG_DIR);
  ensurePrivateDirectory(DOWNLOADS_DIR);
  ensurePrivateDirectory(path.dirname(directory));
  ensurePrivateDirectory(directory);

  return writePrivateFileWithoutOverwrite(
    directory,
    options.filename,
    options.data
  );
}

export function getAttachmentDownloadDirectory(
  accountAlias: string,
  messageId: string
): string {
  return path.join(
    DOWNLOADS_DIR,
    sanitizePathSegment(accountAlias, "account"),
    sanitizePathSegment(messageId, "message")
  );
}

function sanitizePathSegment(value: string, fallback: string): string {
  return sanitizeAttachmentFilename(value) || fallback;
}

function getAttachmentPartInfo(
  part: gmail_v1.Schema$MessagePart
): AttachmentPartInfo | undefined {
  const xAttachmentId = getHeaderValue(part, "X-Attachment-Id");
  const contentId = getHeaderValue(part, "Content-ID");

  if (!part.filename && !part.body?.attachmentId && !xAttachmentId && !contentId) {
    return undefined;
  }

  return {
    part,
    filename: part.filename,
    mimeType: part.mimeType,
    partId: part.partId,
    attachmentId: part.body?.attachmentId,
    xAttachmentId,
    contentId,
  };
}

function getHeaderValue(
  part: gmail_v1.Schema$MessagePart,
  headerName: string
): string | undefined {
  return part.headers?.find(
    (header) => header.name?.toLowerCase() === headerName.toLowerCase()
  )?.value || undefined;
}

function getAttachmentPartIds(info: AttachmentPartInfo): string[] {
  return [
    info.attachmentId,
    info.partId,
    info.xAttachmentId,
    info.contentId,
    stripAngleBrackets(info.contentId),
  ].filter((value): value is string => Boolean(value));
}

function stripAngleBrackets(value?: string): string | undefined {
  if (!value?.startsWith("<") || !value.endsWith(">")) {
    return undefined;
  }

  return value.slice(1, -1);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.chmodSync(directory, PRIVATE_DIR_MODE);
}

function writePrivateFileWithoutOverwrite(
  directory: string,
  filename: string,
  data: Buffer
): SavedAttachmentFile {
  const safeFilename = sanitizeAttachmentFilename(filename);
  if (!safeFilename) {
    throw new Error("Attachment filename could not be safely resolved");
  }

  const parsed = path.parse(safeFilename);
  const resolvedDirectory = path.resolve(directory);

  for (let index = 0; ; index++) {
    const candidate =
      index === 0
        ? safeFilename
        : `${parsed.name}-${index}${parsed.ext}`;
    const filePath = path.resolve(resolvedDirectory, candidate);

    if (!filePath.startsWith(`${resolvedDirectory}${path.sep}`)) {
      throw new Error("Attachment filename resolved outside download directory");
    }

    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "wx", PRIVATE_FILE_MODE);
      fs.writeFileSync(fd, data);
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);

      return {
        filename: candidate,
        path: filePath,
      };
    } catch (error) {
      if (fd !== undefined) {
        fs.closeSync(fd);
        fd = undefined;
      }

      if (isFileExistsError(error)) {
        continue;
      }

      throw error;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }
}

function truncateFilename(filename: string, maxLength: number): string {
  if (filename.length <= maxLength) {
    return filename;
  }

  const parsed = path.parse(filename);
  const extension = parsed.ext.length < maxLength ? parsed.ext : "";
  const maxNameLength = Math.max(1, maxLength - extension.length);
  const name = parsed.name || "attachment";
  return `${name.slice(0, maxNameLength)}${extension}`.slice(0, maxLength);
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
