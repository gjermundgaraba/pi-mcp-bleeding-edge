import path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Files this extension reads and writes. */
export interface McpPaths {
  /** The user-level `mcp.json`, shared with pi's built-in MCP support. */
  readonly globalConfig: string;
  /** One credentials file per OAuth server. */
  readonly credentials: string;
  readonly protocolVerdicts: string;
  readonly log: string;
  /** The project `mcp.json` of `cwd`, read only for trusted projects. */
  readonly projectConfig: (cwd: string) => string;
}

export const mcpPaths = (agentDir: string = getAgentDir()): McpPaths => {
  const data = path.join(agentDir, "data", "mcp-bleeding-edge");

  return {
    globalConfig: path.join(agentDir, "mcp.json"),
    credentials: path.join(data, "auth"),
    protocolVerdicts: path.join(data, "protocol.json"),
    log: path.join(data, "mcp.log"),
    projectConfig: (cwd) => path.join(cwd, CONFIG_DIR_NAME, "mcp.json"),
  };
};
