import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import { buildLegacyServer } from "./legacy-server.ts";
import { buildModernServer, fixtureState } from "./modern-server.ts";

/** A test server listening on a loopback port. */
export interface RunningServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const portOf = z.object({ port: z.number() });

const listen = async (server: Server): Promise<string> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return `http://127.0.0.1:${portOf.parse(server.address()).port}/mcp`;
};

const closer = (server: Server) => async (): Promise<void> => {
  const closed = once(server, "close");

  server.close();
  server.closeAllConnections();
  await closed;
};

/** The v2 handler, which serves 2026-07-28 clients and, per request, 2025-era ones. */
export const startModernHttpServer = async (): Promise<RunningServer> => {
  const state = fixtureState();

  const handler = createMcpHandler(() =>
    buildModernServer(state, () => {
      handler.notify.toolsChanged();
    })
  );

  const node = toNodeHandler(handler);

  const server = createServer((request, response) => {
    void node(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response
    );
  });

  return { url: await listen(server), close: closer(server) };
};

/** A sessionful 2025-era server on the v1 SDK. */
export const startLegacyHttpServer = async (): Promise<
  RunningServer & {
    /** Forget every session, as a restarted server would. */
    readonly forgetSessions: () => void;
  }
> => {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer((request, response) => {
    void (async () => {
      const header = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;

      let transport =
        sessionId === undefined ? undefined : transports.get(sessionId);

      if (transport === undefined) {
        if (sessionId !== undefined) {
          response.writeHead(404).end();

          return;
        }

        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, created);
          },
        });

        transport = created;
        await buildLegacyServer().connect(created);
      }

      await transport.handleRequest(request, response);
    })();
  });

  return {
    url: await listen(server),
    forgetSessions: () => {
      transports.clear();
    },
    close: async () => {
      await Promise.all(
        [...transports.values()].map(async (transport) => {
          await transport.close();
        })
      );
      await closer(server)();
    },
  };
};
