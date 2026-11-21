import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import lockfile from "proper-lockfile";
import { z } from "zod";

import { mcpNamespace } from "../tools/naming.ts";

const FILE_LOCK_RETRIES = {
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

/** Whether a stored value has the fields the SDK relies on; the file is written by this store. */
const isStoredServerAuth = (value: unknown): value is StoredServerAuth =>
  storedServerAuth.safeParse(value).success;

const storedStates = z.record(
  z.string(),
  z.custom<StoredServerAuth>(isStoredServerAuth)
);

type StoredStates = z.infer<typeof storedStates>;

/** Another process holds the refresh lock of a server for the whole wait. */
export class RefreshLockBusyError extends Error {
  constructor() {
    super("Another process is refreshing the MCP server's tokens");
    this.name = "RefreshLockBusyError";
  }
}

/** The OAuth state of one server in a {@link CredentialStore}. */
export interface ServerCredentials {
  readonly read: () => StoredServerAuth | undefined;
  /** Replace the state with what `change` returns, under the store's file lock. `undefined` removes it. */
  readonly update: (
    change: (current: StoredServerAuth) => StoredServerAuth | undefined
  ) => Promise<void>;
  /** Run `fn` while no other process refreshes this server's tokens. */
  readonly withRefreshLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** Credentials belong to a server name and URL, so servers sharing a URL keep separate accounts. */
const storeKey = (name: string, serverUrl: string): string =>
  `${mcpNamespace(name)}|${new URL(serverUrl).href}`;

const isLockedError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ELOCKED";

const without = (states: StoredStates, key: string): StoredStates =>
  Object.fromEntries(
    Object.entries(states).filter(([stored]) => stored !== key)
  );

/** OAuth state of every server, in one JSON file only the user can read, shared by pi processes. */
export class CredentialStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  forServer(name: string, serverUrl: string): ServerCredentials {
    const key = storeKey(name, serverUrl);

    return {
      read: () => this.readAll()[key],
      update: async (change) => {
        await this.write((states) => {
          const next = change(states[key] ?? {});

          return next === undefined
            ? without(states, key)
            : { ...states, [key]: next };
        });
      },
      withRefreshLock: async (fn) => await this.withRefreshLock(key, fn),
    };
  }

  /** Delete a server's state. Resolves to whether there was any. */
  async remove(name: string, serverUrl: string): Promise<boolean> {
    const key = storeKey(name, serverUrl);
    let removed = false;

    await this.write((states) => {
      removed = key in states;

      return without(states, key);
    });

    return removed;
  }

  private readAll(): StoredStates {
    if (!existsSync(this.file)) {
      return {};
    }

    const text = readFileSync(this.file, "utf8");

    if (text.trim() === "") {
      return {};
    }

    const parsed = storedStates.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : {};
  }

  private async write(
    update: (states: StoredStates) => StoredStates
  ): Promise<void> {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });

    const release = await lockfile.lock(this.file, {
      realpath: false,
      retries: FILE_LOCK_RETRIES,
      stale: 10_000,
    });

    try {
      const next = update(this.readAll());
      const temporary = `${this.file}.${process.pid}.tmp`;

      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } finally {
      await release();
    }
  }

  private async withRefreshLock<T>(
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });

    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    let release: () => Promise<void>;

    try {
      release = await lockfile.lock(`${this.file}.refresh-${hash}`, {
        realpath: false,
        stale: REFRESH_LOCK_STALE_MS,
        retries: REFRESH_LOCK_RETRIES,
        onCompromised: () => undefined,
      });
    } catch (error) {
      if (isLockedError(error)) {
        throw new RefreshLockBusyError();
      }

      throw error;
    }

    try {
      return await fn();
    } finally {
      await release().catch(() => undefined);
    }
  }
}
