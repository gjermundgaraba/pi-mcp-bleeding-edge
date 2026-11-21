import { once } from "node:events";
import { createServer } from "node:http";

import {
  oauthErrorHtml,
  oauthSuccessHtml,
} from "@earendil-works/pi-ai/utils/oauth-page";
import { z } from "zod";

import { SignInCancelledError } from "./errors.ts";

/** A local HTTP server waiting for the authorization server's redirect. */
export interface LoopbackListener {
  /** The redirect URI it serves, with the port it listens on. */
  readonly redirectUrl: string;
  /** The query of the first redirect, or a rejection when `signal` aborts. */
  readonly next: (signal: AbortSignal) => Promise<URLSearchParams>;
  readonly close: () => Promise<void>;
}

const listeningPort = z.object({ port: z.number() });

const page = (params: URLSearchParams): string => {
  const error = params.get("error");

  if (error === null) {
    return oauthSuccessHtml(
      "Signed in to the MCP server. You may now close this page."
    );
  }

  return oauthErrorHtml("Sign-in to the MCP server failed.", error);
};

const isRedirect = (url: URL, expectedPath: string): boolean =>
  url.pathname === expectedPath &&
  (url.searchParams.has("code") || url.searchParams.has("error"));

/**
 * Serve `redirectUrl` on its loopback host. Port `0` (or none) picks a free port, which the
 * returned redirect URI then names, as RFC 8252 allows for loopback redirects.
 */
export const listenOnLoopback = async (
  redirectUrl: URL
): Promise<LoopbackListener> => {
  let received: URLSearchParams | undefined;
  const waiting = new Set<(params: URLSearchParams) => void>();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (!isRedirect(url, redirectUrl.pathname)) {
      response.writeHead(404).end();

      return;
    }

    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(page(url.searchParams));
    received ??= url.searchParams;

    for (const resolve of waiting) {
      resolve(received);
    }

    waiting.clear();
  });

  const host = redirectUrl.hostname.replace(/^\[(?<host>.*)\]$/u, "$<host>");

  server.listen(Number(redirectUrl.port || "0"), host);
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]: unknown[]) => {
      throw error;
    }),
  ]);

  const address = listeningPort.safeParse(server.address());
  const served = new URL(redirectUrl);

  served.port = address.success ? String(address.data.port) : served.port;

  const next = async (signal: AbortSignal): Promise<URLSearchParams> => {
    if (received !== undefined) {
      return received;
    }

    const { promise, resolve, reject } =
      Promise.withResolvers<URLSearchParams>();

    const onAbort = (): void => {
      waiting.delete(resolve);
      reject(new SignInCancelledError());
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      waiting.add(resolve);
    }

    try {
      return await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  const close = async (): Promise<void> => {
    const closed = once(server, "close");

    server.close();
    server.closeAllConnections();
    await closed;
  };

  return { redirectUrl: served.href, next, close };
};
