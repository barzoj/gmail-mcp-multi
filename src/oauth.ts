import * as http from "http";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { google } from "googleapis";
import * as fs from "fs";
import { AddressInfo } from "net";
import { AccountManager, Account } from "./accounts.js";

type AccessLevel = "readonly" | "modify" | "full";

interface OAuthKeys {
  installed?: {
    client_id: string;
    client_secret: string;
  };
  web?: {
    client_id: string;
    client_secret: string;
  };
}

interface AuthenticateOptions {
  alias: string;
  email?: string;
  access?: AccessLevel;
  openBrowser?: boolean;
}

const SCOPES: Record<AccessLevel, string[]> = {
  readonly: ["https://www.googleapis.com/auth/gmail.readonly"],
  modify: ["https://www.googleapis.com/auth/gmail.modify"],
  full: ["https://mail.google.com/"],
};

export async function authenticateAccount(
  accountManager: AccountManager,
  options: AuthenticateOptions
): Promise<Account> {
  accountManager.validateAlias(options.alias);

  const existing = accountManager.getAccount(options.alias);
  const email = options.email || existing?.email;
  if (!email) {
    throw new Error("Email is required for first-time authentication");
  }

  const oauthKeys = loadOAuthKeys(accountManager.getOAuthKeysPath());
  const oauthConfig = oauthKeys.installed || oauthKeys.web;
  if (!oauthConfig) {
    throw new Error("OAuth keys must contain an installed or web client");
  }

  const server = http.createServer();
  const { redirectUri, state, codePromise } = await listenForOAuthCode(server);
  const oauth2Client = new google.auth.OAuth2(
    oauthConfig.client_id,
    oauthConfig.client_secret,
    redirectUri
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    login_hint: email,
    scope: SCOPES[options.access || "readonly"],
    state,
  });

  if (options.openBrowser !== false) {
    openUrl(authUrl);
  }

  console.error(`Open this URL to authorize ${email}:`);
  console.error(authUrl);

  try {
    const code = await codePromise;
    const { tokens } = await oauth2Client.getToken(code);
    accountManager.addAccount(options.alias, email);
    accountManager.saveCredentials(options.alias, tokens);

    return {
      alias: options.alias,
      email,
      authenticated: true,
    };
  } finally {
    server.close();
  }
}

function loadOAuthKeys(oauthKeysPath: string): OAuthKeys {
  if (!fs.existsSync(oauthKeysPath)) {
    throw new Error(`OAuth keys not found at ${oauthKeysPath}`);
  }

  const oauthKeys = JSON.parse(fs.readFileSync(oauthKeysPath, "utf-8"));
  fs.chmodSync(oauthKeysPath, 0o600);
  return oauthKeys;
}

async function listenForOAuthCode(
  server: http.Server
): Promise<{ redirectUri: string; state: string; codePromise: Promise<string> }> {
  const state = randomBytes(24).toString("hex");

  const codePromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for OAuth callback"));
    }, 5 * 60 * 1000);

    server.on("request", (req, res) => {
      const host = req.headers.host || "127.0.0.1";
      const callbackUrl = new URL(req.url || "/", `http://${host}`);

      if (callbackUrl.pathname !== "/oauth2callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = callbackUrl.searchParams.get("code");
      const error = callbackUrl.searchParams.get("error");
      const returnedState = callbackUrl.searchParams.get("state");

      if (error) {
        clearTimeout(timeout);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Authorization failed. You can close this tab.");
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        clearTimeout(timeout);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Authorization state mismatch. You can close this tab.");
        reject(new Error("OAuth state mismatch"));
        return;
      }

      if (!code) {
        clearTimeout(timeout);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing authorization code. You can close this tab.");
        reject(new Error("Missing OAuth authorization code"));
        return;
      }

      clearTimeout(timeout);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Gmail account authorized. You can close this tab.");
      resolve(code);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
    state,
    codePromise,
  };
}

function openUrl(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "cmd"
      : "xdg-open";

  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(opener, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.on("error", () => {
    // The authorization URL is also printed for manual use.
  });
  child.unref();
}
