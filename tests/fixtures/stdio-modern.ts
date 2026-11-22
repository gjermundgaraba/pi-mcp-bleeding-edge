import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildModernServer, fixtureState } from "./modern-server.ts";

const state = fixtureState();

console.error("fixture server started");

serveStdio(() => buildModernServer(state, () => undefined));
