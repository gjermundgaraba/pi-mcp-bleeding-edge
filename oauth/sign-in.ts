import { randomBytes } from "node:crypto";

import {
  auth,
  computeScopeUnion,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  isStrictScopeSuperset,
} from "@modelcontextprotocol/client";
import type {
  AuthorizationServerMetadata,
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import type { McpOAuthConfig } from "../config/schema.ts";
import { SignInCancelledError } from "./errors.ts";
import type { OAuthChallenge } from "./errors.ts";
import { planClient } from "./identity.ts";
import type { ClientPlan } from "./identity.ts";
import { listenOnLoopback } from "./loopback.ts";
import type { LoopbackListener } from "./loopback.ts";
import { storedTokens } from "./store.ts";
import type { ServerCredentials, StoredServerAuth } from "./store.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REDIRECT = "http://127.0.0.1/callback";

/** How a sign-in talks to the user. */
export interface SignInPrompt {
  /** Show the authorization URL and open it in a browser. */
  readonly showAuthorizationUrl: (url: URL) => void;
  /**
   * Ask for the URL the browser was redirected to, for browsers that cannot reach this machine.
   * Aborted once the loopback callback arrives. `undefined` or an empty string cancels.
   */
  readonly promptForRedirectUrl: (
    signal: AbortSignal
  ) => Promise<string | undefined>;
}

/** One sign-in to an MCP server. */
export interface SignInOptions {
  readonly serverUrl: string;
  readonly settings: McpOAuthConfig | undefined;
  /** `oauth.clientSecret`, resolved. */
  readonly clientSecret: string | undefined;
  readonly credentials: ServerCredentials;
  /** The challenge that asked for the sign-in, with the resource metadata and scope it named. */
  readonly challenge?: OAuthChallenge | undefined;
  readonly prompt: SignInPrompt;
  readonly signal: AbortSignal;
}

const boundedFetch =
  (signal: AbortSignal): FetchLike =>
  async (input, init) =>
    await fetch(input, {
      ...init,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });

const metadataFields = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
});

/** Whether a configured document has the fields of authorization server metadata (RFC 8414). */
const isAuthorizationServerMetadata = (
  value: unknown
): value is AuthorizationServerMetadata =>
  metadataFields.safeParse(value).success;

const fetchMetadataDocument = async (
  url: string,
  fetchFn: FetchLike
): Promise<AuthorizationServerMetadata> => {
  const response = await fetchFn(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`${url} answered with HTTP ${response.status}`);
  }

  const metadata: unknown = await response.json();

  if (!isAuthorizationServerMetadata(metadata)) {
    throw new TypeError(`${url} is not authorization server metadata`);
  }

  return metadata;
};

/** The authorization server of `serverUrl`: configured, or found through its resource metadata. */
const discover = async (
  options: SignInOptions,
  fetchFn: FetchLike
): Promise<OAuthDiscoveryState> => {
  const challenged = options.challenge?.resourceMetadataUrl;

  const resourceMetadataUrl =
    challenged === undefined ? undefined : new URL(challenged);

  const fromChallenge =
    challenged === undefined ? {} : { resourceMetadataUrl: challenged };

  const configured = options.settings?.authServerMetadataUrl;

  if (configured === undefined) {
    const info = await discoverOAuthServerInfo(options.serverUrl, {
      fetchFn,
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    });

    return { ...info, ...fromChallenge };
  }

  const metadata = await fetchMetadataDocument(configured, fetchFn);

  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
    options.serverUrl,
    resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl },
    fetchFn
  ).catch(() => undefined);

  return {
    authorizationServerUrl: metadata.issuer,
    authorizationServerMetadata: metadata,
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
    ...fromChallenge,
  };
};

const registeredRedirects = (
  client: StoredOAuthClientInformation | undefined
): readonly string[] =>
  client !== undefined && "redirect_uris" in client ? client.redirect_uris : [];

/**
 * The redirect URI to listen on, port `0` for any: the configured one, else the URI a registered
 * client was registered with, so it stays in use.
 */
const preferredRedirect = (
  settings: McpOAuthConfig | undefined,
  plan: ClientPlan,
  stored: StoredServerAuth | undefined
): URL => {
  const url = new URL(settings?.callbackUrl ?? DEFAULT_REDIRECT);
  url.pathname = plan.callbackPath;

  if (url.port === "" && settings?.callbackPort !== undefined) {
    url.port = String(settings.callbackPort);
  }

  if (url.port !== "" || plan.identity.kind !== "registered") {
    return url;
  }

  const registered = registeredRedirects(stored?.client).find((uri) => {
    const candidate = new URL(uri);

    return (
      candidate.hostname === url.hostname &&
      candidate.pathname === url.pathname &&
      candidate.port !== ""
    );
  });

  return registered === undefined ? url : new URL(registered);
};

const listenPreferring = async (url: URL): Promise<LoopbackListener> => {
  try {
    return await listenOnLoopback(url);
  } catch (error) {
    const inUse =
      error instanceof Error && "code" in error && error.code === "EADDRINUSE";

    if (url.port === "" || !inUse) {
      throw error;
    }

    const anyPort = new URL(url);
    anyPort.port = "";

    return await listenOnLoopback(anyPort);
  }
};

/** The OAuth client the SDK's `auth()` drives during one sign-in. */
class SignInProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  authorizationUrl: URL | undefined;
  private readonly expectedState = randomBytes(16).toString("base64url");
  private verifier: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private readonly options: {
    readonly redirectUrl: string;
    readonly plan: ClientPlan;
    readonly credentials: ServerCredentials;
    readonly clientSecret: string | undefined;
  };

  constructor(
    options: SignInProvider["options"],
    discovery: OAuthDiscoveryState
  ) {
    this.options = options;
    this.discovery = discovery;

    if (options.plan.identity.kind === "document") {
      this.clientMetadataUrl = options.plan.identity.url;
    }
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const { identity } = this.options.plan;

    return {
      client_name: identity.kind === "registered" ? identity.clientName : "pi",
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.expectedState;
  }

  clientInformation(
    _ctx?: OAuthClientInformationContext
  ): StoredOAuthClientInformation | undefined {
    const { identity } = this.options.plan;

    if (identity.kind === "configured") {
      return {
        client_id: identity.clientId,
        ...(this.options.clientSecret === undefined
          ? {}
          : { client_secret: this.options.clientSecret }),
      };
    }

    const stored = this.options.credentials.read()?.client;

    if (!stored) {
      return undefined;
    }

    if (identity.kind === "document") {
      return stored.client_id === identity.url ? stored : undefined;
    }

    return registeredRedirects(stored).includes(this.options.redirectUrl)
      ? stored
      : undefined;
  }

  async saveClientInformation(
    client: StoredOAuthClientInformation
  ): Promise<void> {
    const { client_secret: _secret, ...withoutSecret } = client;

    const saved =
      this.options.plan.identity.kind === "configured" ? withoutSecret : client;

    await this.options.credentials.update((current) => ({
      ...current,
      client: saved,
    }));
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.options.credentials.read()?.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const { discovery } = this;

    await this.options.credentials.update((current) => ({
      ...current,
      tokens: storedTokens(tokens),
      ...(discovery === undefined ? {} : { discovery }),
    }));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.verifier === undefined) {
      throw new Error("The sign-in has no PKCE code verifier");
    }

    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    if (scope === "verifier" || scope === "all") {
      this.verifier = undefined;
    }

    if (scope === "discovery") {
      this.discovery = undefined;

      return;
    }

    if (scope === "verifier") {
      return;
    }

    await this.options.credentials.update((current) => {
      if (scope === "all") {
        return undefined;
      }

      return scope === "client"
        ? { ...current, client: undefined }
        : { ...current, tokens: undefined };
    });
  }
}

/** The query of a pasted redirect URL, or of a pasted query string. */
const responseFromRedirectUrl = (value: string): URLSearchParams => {
  const trimmed = value.trim();

  const params = URL.canParse(trimmed)
    ? new URL(trimmed).searchParams
    : new URLSearchParams(trimmed.replace(/^\?/u, ""));

  if (!(params.has("code") || params.has("error"))) {
    throw new Error(
      "That is not the URL the browser was redirected to: it has no code."
    );
  }

  return params;
};

const waitForResponse = async (
  listener: LoopbackListener,
  prompt: SignInPrompt,
  signal: AbortSignal
): Promise<URLSearchParams> => {
  const answered = new AbortController();
  const waiting = AbortSignal.any([signal, answered.signal]);

  const callback = listener.next(waiting);

  void callback.catch(() => undefined);

  const pasted = prompt
    .promptForRedirectUrl(waiting)
    .then((value): URLSearchParams | undefined => {
      if (waiting.aborted) {
        return undefined;
      }

      const url = value?.trim() ?? "";

      if (url === "") {
        throw new SignInCancelledError();
      }

      return responseFromRedirectUrl(url);
    });

  try {
    return (await Promise.race([callback, pasted])) ?? (await callback);
  } finally {
    answered.abort();
  }
};

const throwIfCancelled = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new SignInCancelledError();
  }
};

/**
 * Sign in to an MCP server with the authorization code flow and PKCE, through the SDK's `auth()`:
 * refresh the stored tokens when that is enough, otherwise send the user to the authorization
 * server and wait for its redirect to a loopback callback or a pasted redirect URL. Tokens are saved
 * to `credentials`. Aborting `signal` cancels with {@link SignInCancelledError}.
 */
export const signIn = async (options: SignInOptions): Promise<void> => {
  const { signal } = options;
  const fetchFn = boundedFetch(signal);
  const discovery = await discover(options, fetchFn);
  throwIfCancelled(signal);

  const plan = planClient(
    options.settings,
    discovery.authorizationServerMetadata,
    options.serverUrl
  );

  const stored = options.credentials.read();

  const listener = await listenPreferring(
    preferredRedirect(options.settings, plan, stored)
  );

  try {
    const provider = new SignInProvider(
      {
        redirectUrl: listener.redirectUrl,
        plan,
        credentials: options.credentials,
        clientSecret: options.clientSecret,
      },
      discovery
    );

    const scope = computeScopeUnion(
      options.settings?.scope,
      options.challenge?.scope
    );

    const common = {
      serverUrl: options.serverUrl,
      fetchFn,
      ...(scope === undefined || scope === "" ? {} : { scope }),
      ...(discovery.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: new URL(discovery.resourceMetadataUrl) }),
    };

    const first = await auth(provider, {
      ...common,
      forceReauthorization:
        options.challenge?.scope !== undefined &&
        isStrictScopeSuperset(scope, stored?.tokens?.scope),
    });

    throwIfCancelled(signal);

    if (first === "AUTHORIZED") {
      return;
    }

    if (provider.authorizationUrl === undefined) {
      throw new Error("The authorization server gave no authorization URL");
    }

    options.prompt.showAuthorizationUrl(provider.authorizationUrl);
    const response = await waitForResponse(listener, options.prompt, signal);
    const error = response.get("error");

    if (error !== null) {
      throw new Error(`The authorization server refused the sign-in: ${error}`);
    }

    if (response.get("state") !== provider.state()) {
      throw new Error(
        "The redirect does not belong to this sign-in (state mismatch)."
      );
    }

    const code = response.get("code");

    if (code === null || code === "") {
      throw new Error("The redirect has no authorization code.");
    }

    const iss = response.get("iss");
    await auth(provider, {
      ...common,
      authorizationCode: code,
      ...(iss === null ? {} : { iss }),
    });
  } finally {
    await listener.close();
  }
};
