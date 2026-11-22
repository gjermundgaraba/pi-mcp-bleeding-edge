import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PAGE_SIZE = 2;

const resources = ["a", "b", "c", "d", "e"].map((name) => ({
  uri: `paged://${name}`,
  name,
}));

const server = new Server(
  { name: "paged", version: "1.0.0" },
  { capabilities: { resources: {} } }
);

server.setRequestHandler(ListResourcesRequestSchema, (request) => {
  const start = Number(request.params?.cursor ?? 0);
  const end = start + PAGE_SIZE;

  return {
    resources: resources.slice(start, end),
    ...(end < resources.length ? { nextCursor: String(end) } : {}),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
  contents: [
    { uri: request.params.uri, text: `content of ${request.params.uri}` },
  ],
}));

await server.connect(new StdioServerTransport());
