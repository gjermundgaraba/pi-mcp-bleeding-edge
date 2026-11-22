import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import type {
  OAuthDiscoveryState,
  OAuthTokens,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import lockfile from "proper-lockfile";
import { z } from "zod";

import { readJsonFile, writePrivateJsonFile } from "../json-file.ts";

const WRITE_LOCK_RETRIES = {
  retries: 50,
  factor: 1,
  minTimeout: 20,
  maxTimeout: 20,
};

const REFRESH_LOCK_STALE_MS = 20_000;

const REFRESH_LOCK_RETRIES = {
  retries: 250,
  factor: 1,
  minTimeout: 100,
  maxTimeout: 100,
};

/** Tokens as stored, with the time they expire in milliseconds since the epoch. */
export type StoredTokens = StoredOAuthTokens & {
  readonly expiresAt?: number | undefined;
};

/** One server's OAuth state. */
export interface StoredServerAuth {
  /** The registered client, its Client ID Metadata Document, or a stamp of a configured client. */
  readonly client?: StoredOAuthClientInformation | undefined;
  readonly tokens?: StoredTokens | undefined;
  /** Where the tokens came from, for refreshing them without discovery. */
  readonly discovery?: OAuthDiscoveryState | undefined;
}

const storedServerAuth = z.looseObject({
  client: z.looseObject({ client_id: z.string() }).optional(),
  tokens: z
    .looseObject({ access_token: z.string(), token_type: z.string() })
    .optional(),
  discovery: z.looseObject({ authorizationServerUrl: z.string() }).optional(),
});

/** Whether a stored value has the fields the SDK relies on. */
const isStoredServerAuth = (value: unknown): value is StoredServerAuth =>
  storedServerAuth.safeParse(value).success;

/** Tokens to store from a token response: when they expire, and the refresh token and issuer they keep. */
export const storedTokens = (
  response: StoredOAuthTokens | OAuthTokens,
  previous?: StoredTokens
): StoredTokens => ({
  ...response,
  refresh_token: response.refresh_token ?? previous?.refresh_token,
  issuer:
    ("issuer" in response ? response.issuer : undefined) ?? previous?.issuer,
  expiresAt:
    response.expires_in === undefined
      ? undefined
      : Date.now() + response.expires_in * 1000,
});

/** Another process holds the refresh lock of a server for the whole wait. */
export class RefreshLockBusyError extends Error {
  constructor() {
    super("Another process is refreshing the MCP server's tokens");
    this.name = "RefreshLockBusyError";
  }
}

const isLockedError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ELOCKED";

/**
 * One server's OAuth state, in its own file only the user can read, shared by pi processes.
 * Credentials belong to a server name and URL, so servers sharing a URL keep separate accounts. A
 * file that does not parse reads as signed out, and the next sign-in replaces it.
 */
export class ServerCredentials {
  private readonly file: string;

  constructor(directory: string, name: string, serverUrl: string) {
    const key = `${name.replaceAll("-", "_")}|${new URL(serverUrl).href}`;

    this.file = path.join(
      directory,
      `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`
    );
  }

  read(): StoredServerAuth | undefined {
    try {
      const stored = readJsonFile(this.file);

      return isStoredServerAuth(stored) ? stored : undefined;
    } catch {
      return undefined;
    }
  }

  /** Replace the state with what `change` returns, under a write lock. `undefined` deletes it. */
  async update(
    change: (current: StoredServerAuth) => StoredServerAuth | undefined
  ): Promise<void> {
    await this.locked(
      this.file,
      { retries: WRITE_LOCK_RETRIES, stale: 10_000 },
      () => {
        const next = change(this.read() ?? {});

        if (next === undefined) {
          rmSync(this.file, { force: true });
        } else {
          writePrivateJsonFile(this.file, next);
        }
      }
    );
  }

  /** Delete the state. Resolves to whether there was any. */
  async remove(): Promise<boolean> {
    const existed = existsSync(this.file);

    await this.update(() => undefined);

    return existed;
  }

  /** Run `fn` while no other process refreshes this server's tokens. */
  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.locked(
        `${this.file}.refresh`,
        {
          retries: REFRESH_LOCK_RETRIES,
          stale: REFRESH_LOCK_STALE_MS,
          onCompromised: () => undefined,
        },
        fn
      );
    } catch (error) {
      if (isLockedError(error)) {
        throw new RefreshLockBusyError();
      }

      throw error;
    }
  }

  private async locked<T>(
    target: string,
    options: lockfile.LockOptions,
    fn: () => T | Promise<T>
  ): Promise<T> {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });

    const release = await lockfile.lock(target, {
      ...options,
      realpath: false,
    });

    try {
      return await fn();
    } finally {
      await release().catch(() => undefined);
    }
  }
}
