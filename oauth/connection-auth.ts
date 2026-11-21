import {
  extractWWWAuthenticateParams,
  OAuthError,
  refreshAuthorization,
} from "@modelcontextprotocol/client";
import type {
  AuthProvider,
  FetchLike,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/client";

import { SignInRequiredError } from "./errors.ts";
import type { OAuthChallenge } from "./errors.ts";
import { RefreshLockBusyError } from "./store.ts";
import type { ServerCredentials, StoredTokens } from "./store.ts";

const EXPIRY_SKEW_MS = 30_000;

/**
 * Credentials of a connection to a server that signs in with OAuth. Connections never start a
 * browser flow: they send the stored access token, refresh it when it expired or the server rejects
 * it, and otherwise fail with {@link SignInRequiredError}.
 */
export interface OAuthConnectionAuth extends AuthProvider {
  /** The last challenge the server sent, for the next sign-in. */
  readonly challenge: OAuthChallenge | undefined;
  /** Remember the challenge of a rejection the transport reported, or forget it after a sign-in. */
  readonly setChallenge: (challenge: OAuthChallenge | undefined) => void;
  /** Resolves once no refresh is in flight, so rotated refresh tokens are saved before exit. */
  readonly settled: () => Promise<void>;
}

const isExpired = (tokens: StoredTokens): boolean =>
  tokens.expiresAt !== undefined &&
  Date.now() > tokens.expiresAt - EXPIRY_SKEW_MS;

/** The challenge of a 401 or 403 response. */
export const challengeOf = (response: Response): OAuthChallenge => {
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);

  return { resourceMetadataUrl: resourceMetadataUrl?.href, scope };
};

export const createOAuthConnectionAuth = (options: {
  readonly credentials: ServerCredentials;
  /** A configured client, with its secret resolved; undefined for registered and document clients. */
  readonly configuredClient: () => OAuthClientInformationMixed | undefined;
  readonly fetch?: FetchLike | undefined;
}): OAuthConnectionAuth => {
  const { credentials } = options;
  let challenge: OAuthChallenge | undefined;
  let refreshing: Promise<void> | undefined;
  let lastToken: string | undefined;

  const refreshOnce = async (
    failedToken: string | undefined
  ): Promise<void> => {
    const current = credentials.read();
    const tokens = current?.tokens;

    if (tokens !== undefined && tokens.access_token !== failedToken) {
      return;
    }

    const client = options.configuredClient() ?? current?.client;
    const discovery = current?.discovery;

    const refreshToken = tokens?.refresh_token ?? "";

    if (
      tokens === undefined ||
      refreshToken === "" ||
      client === undefined ||
      discovery === undefined
    ) {
      throw new SignInRequiredError(challenge);
    }

    let refreshed;

    try {
      refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
        clientInformation: client,
        refreshToken,
        ...(discovery.authorizationServerMetadata === undefined
          ? {}
          : { metadata: discovery.authorizationServerMetadata }),
        ...(discovery.resourceMetadata === undefined
          ? {}
          : { resource: discovery.resourceMetadata.resource }),
        ...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
      });
    } catch (error) {
      if (error instanceof OAuthError) {
        throw new SignInRequiredError(challenge, { cause: error });
      }

      throw error;
    }

    const expiresAt =
      refreshed.expires_in === undefined
        ? undefined
        : Date.now() + refreshed.expires_in * 1000;

    await credentials.update((state) => ({
      ...state,
      tokens: {
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? refreshToken,
        issuer: tokens.issuer,
        expiresAt,
      },
    }));
  };

  const refresh = async (failedToken: string | undefined): Promise<void> => {
    refreshing ??= credentials
      .withRefreshLock(async () => {
        await refreshOnce(failedToken);
      })
      .catch((error: unknown) => {
        if (!(error instanceof RefreshLockBusyError)) {
          throw error;
        }
      })
      .finally(() => {
        refreshing = undefined;
      });

    await refreshing;
  };

  return {
    get challenge() {
      return challenge;
    },
    setChallenge(next) {
      challenge = next;
    },
    async token() {
      const tokens = credentials.read()?.tokens;

      if (
        tokens !== undefined &&
        isExpired(tokens) &&
        (tokens.refresh_token ?? "") !== ""
      ) {
        await refresh(tokens.access_token).catch(() => undefined);
      }

      lastToken = credentials.read()?.tokens?.access_token;

      return lastToken;
    },
    async onUnauthorized({ response }: { readonly response: Response }) {
      challenge = challengeOf(response);
      await refresh(lastToken);

      if (credentials.read()?.tokens?.access_token === lastToken) {
        throw new SignInRequiredError(challenge);
      }
    },
    async settled() {
      await refreshing?.catch(() => undefined);
    },
  };
};
