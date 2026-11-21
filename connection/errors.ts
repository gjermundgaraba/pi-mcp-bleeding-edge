import {
  InsufficientScopeError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

import { SignInRequiredError } from "../oauth/errors.ts";
import type { OAuthChallenge } from "../oauth/errors.ts";

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const causes = (error: unknown): unknown[] => {
  const chain: unknown[] = [];

  for (let current = error; current !== undefined && chain.length < 5;) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }

  return chain;
};

/** Network failures and overloaded or restarting servers, worth another attempt. */
export const isTransientError = (error: unknown): boolean =>
  causes(error).some(
    (cause) =>
      cause instanceof TypeError ||
      (cause instanceof SdkHttpError &&
        (cause.status === 408 ||
          cause.status === 429 ||
          (cause.status >= 500 && cause.status !== 501)))
  );

/** A 2025-era Streamable HTTP server no longer knows the session, so it did not run the request. */
export const isSessionExpired = (error: unknown): boolean =>
  error instanceof SdkHttpError && error.status === 404;

/**
 * The challenge of an error that means the user has to sign in, or `undefined` for other errors.
 * Only meaningful for servers that authenticate through an auth provider.
 */
export const signInChallenge = (error: unknown): OAuthChallenge | undefined => {
  for (const cause of causes(error)) {
    if (cause instanceof SignInRequiredError) {
      return cause.challenge ?? {};
    }

    if (cause instanceof InsufficientScopeError) {
      return {
        scope: cause.requiredScope,
        resourceMetadataUrl: cause.resourceMetadataUrl?.href,
      };
    }

    if (cause instanceof UnauthorizedError) {
      return {};
    }

    if (
      cause instanceof SdkError &&
      cause.code === SdkErrorCode.ClientHttpAuthentication
    ) {
      return {};
    }
  }

  return undefined;
};
