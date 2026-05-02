#!/usr/bin/env node

import { AccountManager } from "./accounts.js";
import { authenticateAccount } from "./oauth.js";

interface CliOptions {
  alias?: string;
  email?: string;
  access?: "readonly" | "modify" | "full";
  noBrowser?: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.alias) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const accountManager = new AccountManager();
  const account = await authenticateAccount(accountManager, {
    alias: options.alias,
    email: options.email,
    access: options.access,
    openBrowser: !options.noBrowser,
  });

  console.log(
    `Authenticated ${account.alias} <${account.email}> with ${options.access || "readonly"} access`
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--alias":
      case "-a":
        options.alias = next;
        i++;
        break;
      case "--email":
      case "-e":
        options.email = next;
        i++;
        break;
      case "--access":
        if (next !== "readonly" && next !== "modify" && next !== "full") {
          throw new Error("--access must be one of: readonly, modify, full");
        }
        options.access = next;
        i++;
        break;
      case "--no-browser":
        options.noBrowser = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage:
  gmail-mcp-multi-auth --alias personal --email you@gmail.com

Options:
  --alias, -a       Local account alias. Letters, numbers, underscores, hyphens.
  --email, -e       Gmail address to authorize.
  --access          readonly | modify | full. Defaults to readonly.
  --no-browser      Print the URL without opening a browser.
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
