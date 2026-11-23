import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { isHttpConfig } from "../config/schema.ts";
import type { McpHttpServerConfig } from "../config/schema.ts";
import { resolveConfigValue } from "../config/values.ts";
import type { ConnectionAuth, ServerTarget } from "../connection/connection.ts";
import { createOAuthConnectionAuth } from "../oauth/connection-auth.ts";
import type { OAuthChallenge } from "../oauth/errors.ts";
import { signIn } from "../oauth/sign-in.ts";
import type { SignInPrompt } from "../oauth/sign-in.ts";
import { ServerCredentials } from "../oauth/store.ts";

/** HTTP servers sign in with OAuth unless they send an `Authorization` header or a provider's token. */
const oauthConfig = (entry: ServerTarget): McpHttpServerConfig | undefined => {
  const { config } = entry;

  if (!isHttpConfig(config) || config.auth !== undefined) {
    return undefined;
  }

  const hasHeader = Object.keys(config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization"
  );

  return hasHeader ? undefined : config;
};

const clientSecret = (
  entry: ServerTarget,
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
  private readonly directory: string;
  private modelRegistry: ModelRegistry | undefined;

  constructor(directory: string) {
    this.directory = directory;
  }

  /** The session's model registry, which holds the tokens of `auth.provider` servers. */
  useModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /** How a new connection to the server authenticates. */
  connectionAuth(entry: ServerTarget): ConnectionAuth | undefined {
    const { config } = entry;

    if (isHttpConfig(config) && config.auth !== undefined) {
      const { provider } = config.auth;

      return {
        provider: {
          token: async () =>
            await this.modelRegistry?.getApiKeyForProvider(provider),
        },
        signInHint: `Run /login ${provider} to sign in.`,
      };
    }

    const oauth = oauthConfig(entry);

    if (oauth === undefined) {
      return undefined;
    }

    const clientId = oauth.oauth?.clientId;

    const provider = createOAuthConnectionAuth({
      credentials: this.credentials(entry, oauth),
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

    return { provider, oauth: provider, signInHint: "Run /mcp to sign in." };
  }

  /** Run a sign-in to the server, saving the tokens for its connections. */
  async signIn(
    entry: ServerTarget,
    challenge: OAuthChallenge | undefined,
    prompt: SignInPrompt,
    signal: AbortSignal
  ): Promise<void> {
    const oauth = oauthConfig(entry);

    if (oauth === undefined) {
      throw new Error(`MCP server "${entry.name}" does not use OAuth.`);
    }

    await signIn({
      serverUrl: oauth.url,
      settings: oauth.oauth,
      clientSecret: clientSecret(entry, oauth),
      credentials: this.credentials(entry, oauth),
      challenge,
      prompt,
      signal,
    });
  }

  /** Delete the server's stored credentials. Resolves to whether there were any. */
  async signOut(entry: ServerTarget): Promise<boolean> {
    const oauth = oauthConfig(entry);

    return oauth === undefined
      ? false
      : await this.credentials(entry, oauth).remove();
  }

  /** The stored tokens as text, to notice sign-ins made by other pi processes. */
  storedTokens(entry: ServerTarget): string {
    const oauth = oauthConfig(entry);

    return JSON.stringify(
      (oauth === undefined
        ? undefined
        : this.credentials(entry, oauth).read()?.tokens) ?? null
    );
  }

  private credentials(
    entry: ServerTarget,
    config: McpHttpServerConfig
  ): ServerCredentials {
    return new ServerCredentials(this.directory, entry.name, config.url);
  }
}
