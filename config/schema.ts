import {
  isMcpServerOverride,
  validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import type {
  McpHttpServerConfig as HttpFields,
  McpStdioServerConfig as StdioFields,
} from "@earendil-works/pi-mcp";
import { z } from "zod";

import { listsMetadataDocumentCallback } from "../oauth/identity.ts";
import { MCP_EXPOSURE_ALIASES, MCP_EXPOSURES } from "./exposure.ts";

export type { McpOAuthConfig } from "@earendil-works/pi-mcp";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

const exposureError = `must be one of ${MCP_EXPOSURES.map((name) => `"${name}"`).join(", ")}`;

const exposure = z
  .string({ error: exposureError })
  .transform((value) => MCP_EXPOSURE_ALIASES.get(value) ?? value)
  .pipe(z.enum(MCP_EXPOSURES, { error: exposureError }));

const overrideFields = {
  enabled: z.boolean().optional(),
  exposure: exposure.optional(),
  toolExposure: z.record(z.string(), exposure).optional(),
};

/** The fields this extension adds to the shared `mcpServers` shape, which pi-mcp validates. */
const ownFields = z.object({
  exposure: overrideFields.exposure,
  toolExposure: overrideFields.toolExposure,
  protocol: z
    .enum(["auto", "modern", "legacy"], {
      error: 'must be "auto", "modern", or "legacy"',
    })
    .optional(),
  auth: z
    .object({
      provider: z.string().min(1, { error: "must be a provider name" }),
    })
    .optional(),
});

type OwnFields = z.infer<typeof ownFields>;

const overrideSchema = z.strictObject(overrideFields, {
  error: "an override can only set enabled, exposure, toolExposure",
});

const entryObject = z.record(z.string(), z.unknown());

/** The shape of an `mcp.json`; each server entry is validated on its own. */
export const configFileSchema = z.looseObject({
  mcpServers: entryObject.optional(),
  autoEnableCodemode: z.unknown().optional(),
});

/** A server started as a local program speaking MCP over stdin and stdout. */
export type McpStdioServerConfig = StdioFields & OwnFields;

/** A server reached over Streamable HTTP. */
export type McpHttpServerConfig = HttpFields & OwnFields;

/** One validated `mcpServers` entry. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** The fields a project `mcp.json` may override of a global server. */
export type McpServerOverride = z.infer<typeof overrideSchema>;

/** Which protocol era a server is connected with: negotiated, 2026-07-28 only, or 2025-era only. */
export type ProtocolPreference = NonNullable<OwnFields["protocol"]>;

/** A validated value, or why it is invalid. */
export type Parsed<T> =
  | { readonly value: T; readonly error?: undefined }
  | { readonly error: string; readonly value?: undefined };

export const isHttpConfig = (
  config: McpServerConfig
): config is McpHttpServerConfig => "url" in config;

const firstIssue = (error: z.ZodError): string => {
  const [issue] = error.issues;
  const message = issue?.message ?? "is invalid";
  const field = issue?.path.join(".") ?? "";

  return field === "" ? message : `${field}: ${message}`;
};

/** An entry without `command`, `url`, or `type` overrides a few fields of a server defined elsewhere. */
export const isServerOverride = (raw: unknown): boolean => {
  const entry = entryObject.safeParse(raw);

  return entry.success && isMcpServerOverride(entry.data);
};

/** Validate the fields a project override sets. */
export const parseServerOverride = (
  name: string,
  raw: unknown
): Parsed<McpServerOverride> => {
  const parsed = overrideSchema.safeParse(raw);

  return parsed.success
    ? { value: parsed.data }
    : { error: `server "${name}": ${firstIssue(parsed.error)}` };
};

const checkMetadataDocumentCallback = (
  callbackUrl: string | undefined
): string | undefined =>
  listsMetadataDocumentCallback(callbackUrl)
    ? undefined
    : 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';

/**
 * Validate one `mcpServers` entry: the shared fields with pi-mcp, as pi does, and this extension's
 * own (`exposure`, `toolExposure`, `protocol`, `auth`) here. A provider's token is only sent over
 * https or to a loopback host.
 */
export const parseServerConfig = (
  name: string,
  raw: unknown
): Parsed<McpServerConfig> => {
  const shared = validateMcpServerConfig(name, raw, {
    checkMetadataDocumentCallback,
  });

  if (shared.kind === "invalid") {
    return { error: shared.error };
  }

  const own = ownFields.safeParse(shared.config);

  if (!own.success) {
    return { error: `server "${name}": ${firstIssue(own.error)}` };
  }

  if (shared.kind === "stdio") {
    return { value: { ...shared.config, ...own.data } };
  }

  const url = new URL(shared.config.url);

  if (
    own.data.auth !== undefined &&
    url.protocol !== "https:" &&
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    return {
      error: `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`,
    };
  }

  return { value: { ...shared.config, ...own.data } };
};
