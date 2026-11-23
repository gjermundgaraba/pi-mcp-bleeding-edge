/**
 * The extension's MCP client without pi's session: one server's connection, with protocol era
 * negotiation, reconnects, and sign-in detection, and the conversion of its results to model
 * content. For hosts that manage their own servers and credentials, such as a pi-durable app.
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

export { SignInRequiredError } from "./oauth/errors.ts";

export type { OAuthChallenge } from "./oauth/errors.ts";

export {
  limitContent,
  toModelContent,
  toolResultContent,
} from "./tools/content.ts";

export type {
  ContentOptions,
  LimitedMcpContent,
  McpOutputSaver,
  ModelContent,
} from "./tools/content.ts";
