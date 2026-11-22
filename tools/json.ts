import type { JsonValue } from "@earendil-works/pi-ai";

/**
 * A value from an MCP message as JSON for codemode scripts. The SDK parsed it from JSON-RPC, so it
 * is JSON already; only its static type does not say so.
 */
export const asJsonValue = (value: unknown): JsonValue => value as JsonValue;
