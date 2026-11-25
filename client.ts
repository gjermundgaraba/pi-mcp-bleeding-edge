/**
 * The extension's MCP client without pi's session: one server's connection, with protocol era
 * negotiation, reconnects, sign-in detection, and verified skill reads, and the conversion of its
 * results to model content. For hosts that manage their own servers and credentials, such as a
 * pi-durable app.
 */
export { ServerConnection } from "./connection/connection.ts";

export type {
  CallOptions,
  ConnectionAuth,
  ConnectionOptions,
  ConnectionState,
  ServerTarget,
  ToolArguments,
} from "./connection/connection.ts";

export { MODERN_PROTOCOL_VERSION, ProtocolVerdicts } from "./connection/era.ts";

export { SkillVerificationError } from "@modelcontextprotocol/client/ext/skills";

export type { Skill, SkillFile } from "@modelcontextprotocol/client/ext/skills";

export { SignInRequiredError } from "./oauth/errors.ts";

export type { OAuthChallenge } from "./oauth/errors.ts";

export { toModelContent, toolResultContent } from "./tools/content.ts";

export type { ContentOptions, ModelContent } from "./tools/content.ts";

export type { LimitedMcpContent, McpOutputSaver } from "@earendil-works/pi-mcp";
