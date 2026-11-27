import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import { buildModernServer, fixtureState } from "./modern-server.ts";

/** An MCP server behind a minimal OAuth 2.1 authorization server with dynamic client registration. */
export interface OAuthFixture {
  readonly base: string;
  readonly url: string;
  /** Reject every access token issued so far, as if they expired. */
  readonly expireAccessTokens: () => void;
  readonly tokenRequests: () => readonly string[];
  /** Answer calls of the tool `name` with 403 insufficient_scope for `scope`. */
  readonly requireScope: (name: string, scope: string) => void;
  /** Hold calls of the tool `name` until `release`; `arrived` resolves when the first one does. */
  readonly holdCalls: (name: string) => {
    readonly arrived: Promise<undefined>;
    readonly release: () => void;
  };
  readonly close: () => Promise<void>;
}

const portOf = z.object({ port: z.number() });

const readBytes = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(z.instanceof(Uint8Array).parse(chunk)));
  }

  return Buffer.concat(chunks);
};

const toolCall = z.object({
  method: z.literal("tools/call"),
  params: z.object({ name: z.string() }),
});

/** The tool a JSON-RPC request body calls, if it is a tool call. */
const calledTool = (body: Buffer): string | undefined => {
  try {
    return toolCall.safeParse(JSON.parse(body.toString("utf8"))).data?.params
      .name;
  } catch {
    return undefined;
  }
};

const json = (
  response: ServerResponse,
  status: number,
  body: unknown
): void => {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
};

const challengeOf = (base: string): string =>
  `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;

const registration = z.object({ redirect_uris: z.array(z.string()) });

export const startOAuthServer = async (): Promise<OAuthFixture> => {
  const handler = createMcpHandler(() =>
    buildModernServer(fixtureState(), () => undefined)
  );

  const mcp = toNodeHandler(handler);
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const valid = new Set<string>();
  const refreshTokens = new Set<string>();
  const tokenRequests: string[] = [];
  const requiredScopes = new Map<string, string>();

  const holds = new Map<
    string,
    { arrive: () => void; held: Promise<undefined> }
  >();

  let base = "";

  const issue = () => {
    const access = randomUUID();
    const refresh = randomUUID();

    valid.add(access);
    refreshTokens.add(refresh);

    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
    };
  };

  const routes = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", base);

    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp": {
        json(response, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
        });

        return;
      }

      case "/.well-known/oauth-authorization-server": {
        json(response, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });

        return;
      }

      case "/register": {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
          chunks.push(Buffer.from(z.instanceof(Uint8Array).parse(chunk)));
        }

        const body = registration.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8"))
        );

        json(response, 201, {
          client_id: randomUUID(),
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: "none",
        });

        return;
      }

      case "/authorize": {
        const code = randomUUID();
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const redirect = new URL(redirectUri);

        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirectUri,
        });
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        redirect.searchParams.set("iss", base);
        response.writeHead(302, { location: redirect.href }).end();

        return;
      }

      case "/token": {
        const bytes = await readBytes(request);
        const body = new URLSearchParams(bytes.toString("utf8"));
        const grant = body.get("grant_type") ?? "";

        tokenRequests.push(grant);

        if (
          grant === "refresh_token" &&
          refreshTokens.delete(body.get("refresh_token") ?? "")
        ) {
          json(response, 200, issue());

          return;
        }

        const pending = codes.get(body.get("code") ?? "");
        const verifier = body.get("code_verifier") ?? "";

        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");

        if (
          grant === "authorization_code" &&
          pending?.challenge === challenge
        ) {
          codes.delete(body.get("code") ?? "");
          json(response, 200, issue());

          return;
        }

        json(response, 400, { error: "invalid_grant" });

        return;
      }

      case "/mcp": {
        const token = (request.headers.authorization ?? "").replace(
          /^Bearer /u,
          ""
        );

        if (!valid.has(token)) {
          response
            .writeHead(401, { "www-authenticate": challengeOf(base) })
            .end();

          return;
        }

        const body = await readBytes(request);
        const tool = calledTool(body);
        const scope = requiredScopes.get(tool ?? "");

        if (scope !== undefined) {
          response
            .writeHead(403, {
              "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            })
            .end();

          return;
        }

        const hold = holds.get(tool ?? "");

        if (hold !== undefined) {
          hold.arrive();
          await hold.held;
        }

        await mcp(
          {
            method: request.method ?? "GET",
            url: request.url ?? "/",
            headers: request.headers,
            // The body was read to find the called tool, so hand the handler the bytes read.
            async *[Symbol.asyncIterator]() {
              yield body;
            },
          },
          response
        );

        return;
      }

      default: {
        response.writeHead(404).end();
      }
    }
  };

  const server = createServer((request, response) => {
    void routes(request, response);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${portOf.parse(server.address()).port}`;

  return {
    base,
    url: `${base}/mcp`,
    expireAccessTokens: () => {
      valid.clear();
    },
    tokenRequests: () => [...tokenRequests],
    requireScope: (name, scope) => {
      requiredScopes.set(name, scope);
    },
    holdCalls: (name) => {
      const arrived = Promise.withResolvers<undefined>();
      const held = Promise.withResolvers<undefined>();

      holds.set(name, {
        arrive: () => {
          arrived.resolve(undefined);
        },
        held: held.promise,
      });

      return {
        arrived: arrived.promise,
        release: () => {
          held.resolve(undefined);
        },
      };
    },
    close: async () => {
      const closed = once(server, "close");

      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
};
