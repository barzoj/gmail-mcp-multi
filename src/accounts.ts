import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Account {
  alias: string;
  email: string;
  authenticated: boolean;
}

export interface AccountConfig {
  alias: string;
  email: string;
}

interface Config {
  accounts: AccountConfig[];
}

const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const ACCOUNTS_DIR = path.join(CONFIG_DIR, "accounts");
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class AccountManager {
  private config: Config = { accounts: [] };

  constructor() {
    this.ensureDirectories();
    this.loadConfig();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
    }
    fs.chmodSync(CONFIG_DIR, PRIVATE_DIR_MODE);

    if (!fs.existsSync(ACCOUNTS_DIR)) {
      fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
    }
    fs.chmodSync(ACCOUNTS_DIR, PRIVATE_DIR_MODE);
  }

  private loadConfig(): void {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, "utf-8");
      this.config = JSON.parse(content);
    }
  }

  private saveConfig(): void {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), {
      mode: PRIVATE_FILE_MODE,
    });
    fs.chmodSync(CONFIG_FILE, PRIVATE_FILE_MODE);
  }

  getAccountDir(alias: string): string {
    this.validateAlias(alias);
    return path.join(ACCOUNTS_DIR, alias);
  }

  getCredentialsPath(alias: string): string {
    return path.join(this.getAccountDir(alias), "credentials.json");
  }

  isAuthenticated(alias: string): boolean {
    return fs.existsSync(this.getCredentialsPath(alias));
  }

  listAccounts(): Account[] {
    return this.config.accounts.map((acc) => ({
      ...acc,
      authenticated: this.isAuthenticated(acc.alias),
    }));
  }

  getAccount(aliasOrEmail: string): AccountConfig | undefined {
    return this.config.accounts.find(
      (acc) => acc.alias === aliasOrEmail || acc.email === aliasOrEmail
    );
  }

  addAccount(alias: string, email: string): void {
    this.validateAlias(alias);
    if (!email || !email.includes("@")) {
      throw new Error("A valid email address is required");
    }

    const existing = this.config.accounts.findIndex(
      (acc) => acc.alias === alias
    );
    if (existing >= 0) {
      this.config.accounts[existing] = { alias, email };
    } else {
      this.config.accounts.push({ alias, email });
    }

    // Create account directory
    const accountDir = this.getAccountDir(alias);
    if (!fs.existsSync(accountDir)) {
      fs.mkdirSync(accountDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    }
    fs.chmodSync(accountDir, PRIVATE_DIR_MODE);

    this.saveConfig();
  }

  removeAccount(alias: string): boolean {
    const index = this.config.accounts.findIndex((acc) => acc.alias === alias);
    if (index >= 0) {
      this.config.accounts.splice(index, 1);
      this.saveConfig();

      // Remove credentials
      const accountDir = this.getAccountDir(alias);
      if (fs.existsSync(accountDir)) {
        fs.rmSync(accountDir, { recursive: true });
      }
      return true;
    }
    return false;
  }

  getOAuthKeysPath(): string {
    return path.join(CONFIG_DIR, "oauth-keys.json");
  }

  saveCredentials(alias: string, credentials: unknown): void {
    const accountDir = this.getAccountDir(alias);
    if (!fs.existsSync(accountDir)) {
      fs.mkdirSync(accountDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    }
    fs.chmodSync(accountDir, PRIVATE_DIR_MODE);

    const credentialsPath = this.getCredentialsPath(alias);
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), {
      mode: PRIVATE_FILE_MODE,
    });
    fs.chmodSync(credentialsPath, PRIVATE_FILE_MODE);
  }

  validateAlias(alias: string): void {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new Error(
        "Account alias must be 1-64 characters using only letters, numbers, underscores, or hyphens"
      );
    }
  }
}
