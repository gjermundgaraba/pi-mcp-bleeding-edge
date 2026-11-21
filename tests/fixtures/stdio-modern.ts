import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildModernServer } from "./modern-server.ts";
import type { FixtureState } from "./modern-server.ts";

const state: FixtureState = { addedTools: [] };

console.error("fixture server started");

serveStdio(() =>
  buildModernServer(state, (server) => {
    for (const name of state.addedTools) {
      server.registerTool(name, { description: "Added at runtime" }, () => ({
        content: [{ type: "text", text: name }],
      }));
    }
  })
);
