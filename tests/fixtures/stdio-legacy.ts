import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildLegacyServer } from "./legacy-server.ts";

await buildLegacyServer().connect(new StdioServerTransport());
