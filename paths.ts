import path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Stable id of this extension, naming its data directory. */
const EXTENSION_ID = "mcp-bleeding-edge";

/** Files this extension reads and writes. */
export interface McpPaths {
  /** The user-level `mcp.json`, shared with pi's built-in MCP support. */
  readonly globalConfig: string;
  /** Durable data: credentials, protocol verdicts, and the server log. */
  readonly dataDir: string;
  readonly credentials: string;
  readonly protocolVerdicts: string;
  readonly log: string;
  /** The project `mcp.json` of `cwd`, read only for trusted projects. */
  readonly projectConfig: (cwd: string) => string;
}

export const mcpPaths = (agentDir: string = getAgentDir()): McpPaths => {
  const dataDir = path.join(agentDir, "data", EXTENSION_ID);

  return {
    globalConfig: path.join(agentDir, "mcp.json"),
    dataDir,
    credentials: path.join(dataDir, "auth.json"),
    protocolVerdicts: path.join(dataDir, "protocol.json"),
    log: path.join(dataDir, "mcp.log"),
    projectConfig: (cwd) => path.join(cwd, CONFIG_DIR_NAME, "mcp.json"),
  };
};
