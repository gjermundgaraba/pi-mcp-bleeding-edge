import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ServerEntry } from "../config/load.ts";
import { isHttpConfig } from "../config/schema.ts";
import type { McpHttpServerConfig } from "../config/schema.ts";
import { resolveConfigValue } from "../config/values.ts";
import type { ConnectionAuth } from "../connection/connection.ts";
import { createOAuthConnectionAuth } from "../oauth/connection-auth.ts";
import type { OAuthChallenge } from "../oauth/errors.ts";
import { signIn } from "../oauth/sign-in.ts";
import type { SignInPrompt } from "../oauth/sign-in.ts";
import { CredentialStore } from "../oauth/store.ts";

/** HTTP servers sign in with OAuth unless they send an `Authorization` header or a provider's token. */
const oauthConfig = (entry: ServerEntry): McpHttpServerConfig | undefined => {
  const { config } = entry;

  if (!isHttpConfig(config) || config.auth) {
    return undefined;
  }

  const hasHeader = Object.keys(config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization"
  );

  return hasHeader ? undefined : config;
};

const clientSecret = (
  entry: ServerEntry,
  config: McpHttpServerConfig
): string | undefined => {
  const secret = config.oauth?.clientSecret;

  return secret === undefined
    ? undefined
    : resolveConfigValue(
        secret,
        `MCP server "${entry.name}" oauth.clientSecret`
      );
};

/** Credentials of the session's servers: OAuth sign-ins, and tokens of pi's `/login` providers. */
export class SessionAuth {
  private readonly store: CredentialStore;
  private modelRegistry: ModelRegistry | undefined;

  constructor(credentialsPath: string) {
    this.store = new CredentialStore(credentialsPath);
  }

  /** The session's model registry, which holds the tokens of `auth.provider` servers. */
  useModelRegistry(registry: ModelRegistry | undefined): void {
    this.modelRegistry = registry;
  }

  /** How a new connection to the server authenticates. */
  connectionAuth(entry: ServerEntry): ConnectionAuth | undefined {
    const { config } = entry;

    if (isHttpConfig(config) && config.auth) {
      const { provider } = config.auth;

      return {
        provider: {
          token: async () =>
            await this.modelRegistry?.getApiKeyForProvider(provider),
        },
        signInCommand: `/login ${provider}`,
      };
    }

    const oauth = oauthConfig(entry);

    if (!oauth) {
      return undefined;
    }

    const clientId = oauth.oauth?.clientId;

    const provider = createOAuthConnectionAuth({
      credentials: this.store.forServer(entry.name, oauth.url),
      configuredClient: () => {
        if (clientId === undefined || clientId === "") {
          return undefined;
        }

        const secret = clientSecret(entry, oauth);

        return {
          client_id: clientId,
          ...(secret === undefined ? {} : { client_secret: secret }),
        };
      },
    });

    return { provider, oauth: provider, signInCommand: "/mcp" };
  }

  /** Run a sign-in to the server, saving the tokens for its connections. */
  async signIn(
    entry: ServerEntry,
    challenge: OAuthChallenge | undefined,
    prompt: SignInPrompt,
    signal: AbortSignal
  ): Promise<void> {
    const oauth = oauthConfig(entry);

    if (!oauth) {
      throw new Error(`MCP server "${entry.name}" does not use OAuth.`);
    }

    await signIn({
      serverUrl: oauth.url,
      settings: oauth.oauth,
      clientSecret: clientSecret(entry, oauth),
      credentials: this.store.forServer(entry.name, oauth.url),
      challenge,
      prompt,
      signal,
    });
  }

  /** Delete the server's stored credentials. Resolves to whether there were any. */
  async signOut(entry: ServerEntry): Promise<boolean> {
    const url = oauthConfig(entry)?.url;

    return url === undefined ? false : await this.store.remove(entry.name, url);
  }

  /** The stored tokens as text, to notice sign-ins made by other pi processes. */
  storedTokens(entry: ServerEntry): string {
    const url = oauthConfig(entry)?.url;

    if (url === undefined) {
      return "null";
    }

    try {
      return JSON.stringify(
        this.store.forServer(entry.name, url).read()?.tokens ?? null
      );
    } catch {
      return "null";
    }
  }
}
