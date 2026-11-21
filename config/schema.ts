import { z } from "zod";

import { MCP_EXPOSURE_ALIASES, MCP_EXPOSURES } from "./exposure.ts";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

const isLoopback = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname);

/**
 * Whether pi's Client ID Metadata Documents list the loopback `callbackUrl`: they list `/callback`
 * on localhost and 127.0.0.1, on any port.
 */
export const listsMetadataDocumentCallback = (
  callbackUrl: string | undefined
): boolean => {
  if (callbackUrl === undefined) {
    return true;
  }

  const url = new URL(callbackUrl);

  return url.hostname !== "[::1]" && url.pathname === "/callback";
};

const httpUrl = z.url({
  protocol: /^https?$/u,
  error: "must be an http or https URL",
});

const exposure = z.preprocess(
  (value) =>
    z.string().safeParse(value).success
      ? (MCP_EXPOSURE_ALIASES.get(String(value)) ?? value)
      : value,
  z.enum(MCP_EXPOSURES, {
    error: `must be one of ${MCP_EXPOSURES.map((name) => `"${name}"`).join(", ")}`,
  })
);

const stringMap = z.record(z.string(), z.string(), {
  error: "must map names to strings",
});

const overrideFields = {
  enabled: z.boolean().optional(),
  exposure: exposure.optional(),
  toolExposure: z.record(z.string(), exposure).optional(),
};

const baseFields = {
  ...overrideFields,
  description: z.string().optional(),
  timeout: z
    .number()
    .positive({ error: "must be a positive number of seconds" })
    .optional(),
  protocol: z
    .enum(["auto", "modern", "legacy"], {
      error: 'must be "auto", "modern", or "legacy"',
    })
    .optional(),
};

const loopbackCallback = z.string().refine((value) => {
  if (!URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);

  return (
    url.protocol === "http:" &&
    isLoopback(url) &&
    url.search === "" &&
    url.hash === ""
  );
}, "must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment");

const metadataUrl = z.string().refine((value) => {
  if (!URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);

  return (
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url))
  );
}, "must be an https URL, or http on localhost, 127.0.0.1, or [::1]");

const oauthSchema = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    callbackPort: z
      .int()
      .min(1)
      .max(65_535, { error: "must be a port number" })
      .optional(),
    callbackUrl: loopbackCallback.optional(),
    scope: z.string().optional(),
    clientName: z
      .string()
      .trim()
      .min(1, { error: "must be a non-empty string" })
      .optional(),
    clientRegistration: z.enum(["auto", "dcr", "cimd"]).optional(),
    authServerMetadataUrl: metadataUrl.optional(),
  })
  .superRefine((oauth, ctx) => {
    const urlPort =
      oauth.callbackUrl === undefined ? "" : new URL(oauth.callbackUrl).port;

    if (
      urlPort !== "" &&
      oauth.callbackPort !== undefined &&
      Number(urlPort) !== oauth.callbackPort
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["callbackPort"],
        message: "names a different port than oauth.callbackUrl",
      });
    }

    if (oauth.clientRegistration !== "cimd") {
      return;
    }

    if (oauth.clientId !== undefined || oauth.clientName !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["clientRegistration"],
        message:
          '"cimd" cannot be combined with oauth.clientId or oauth.clientName',
      });
    }

    if (!listsMetadataDocumentCallback(oauth.callbackUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["clientRegistration"],
        message:
          '"cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback',
      });
    }
  });

const stdioSchema = z.object({
  ...baseFields,
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z
    .array(z.string(), { error: "must be an array of strings" })
    .optional(),
  env: stringMap.optional(),
  cwd: z.string().optional(),
});

const httpSchema = z
  .object({
    ...baseFields,
    type: z.enum(["http", "streamable-http"]).optional(),
    url: httpUrl,
    headers: stringMap.optional(),
    oauth: oauthSchema.optional(),
    auth: z
      .object({
        provider: z.string().min(1, { error: "must be a provider name" }),
      })
      .optional(),
  })
  .superRefine((config, ctx) => {
    const url = new URL(config.url);

    if (
      config.auth !== undefined &&
      url.protocol !== "https:" &&
      !isLoopback(url)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["auth"],
        message:
          "requires an https URL, or http on localhost, 127.0.0.1, or [::1]",
      });
    }
  });

const transportFields = z.looseObject({
  type: z.unknown().optional(),
  url: z.unknown().optional(),
  command: z.unknown().optional(),
});

const overrideSchema = z.strictObject(overrideFields, {
  error: "an override can only set enabled, exposure, toolExposure",
});

/** The fields of an `mcp.json`; each server entry is validated on its own. */
export const configFileSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  autoEnableCodemode: z.unknown().optional(),
});

/** OAuth client settings of an HTTP server. */
export type McpOAuthConfig = z.infer<typeof oauthSchema>;

/** A server started as a local program speaking MCP over stdin and stdout. */
export type McpStdioServerConfig = z.infer<typeof stdioSchema>;

/** A server reached over Streamable HTTP. */
export type McpHttpServerConfig = z.infer<typeof httpSchema>;

/** One validated `mcpServers` entry. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** The fields a project `mcp.json` may override of a global server. */
export type McpServerOverride = z.infer<typeof overrideSchema>;

/** Which protocol era a server is connected with: negotiated, 2026-07-28 only, or 2025-era only. */
export type ProtocolPreference = NonNullable<McpServerConfig["protocol"]>;

/** The result of validating one `mcpServers` entry. */
export type Parsed<T> =
  | { readonly value: T; readonly error?: undefined }
  | { readonly error: string; readonly value?: undefined };

export const isHttpConfig = (
  config: McpServerConfig
): config is McpHttpServerConfig => "url" in config;

const firstIssue = (error: z.ZodError): string => {
  const [issue] = error.issues;
  const message = issue?.message ?? "is invalid";
  const path = issue?.path.join(".") ?? "";

  return path === "" ? message : `${path}: ${message}`;
};

/** An entry without `command`, `url`, or `type` overrides a few fields of a server defined elsewhere. */
export const isServerOverride = (raw: unknown): boolean => {
  const fields = transportFields.safeParse(raw);

  return (
    fields.success &&
    fields.data.command === undefined &&
    fields.data.url === undefined &&
    fields.data.type === undefined
  );
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

const schemaFor = (
  fields: z.infer<typeof transportFields>
): typeof httpSchema | typeof stdioSchema | undefined => {
  const { type } = fields;

  if (
    z.string().safeParse(fields.url).success &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    return httpSchema;
  }

  if (
    z.string().safeParse(fields.command).success &&
    (type === undefined || type === "stdio")
  ) {
    return stdioSchema;
  }

  return undefined;
};

/** Validate one `mcpServers` entry. Names are letters, digits, `_`, and `-`, which tool names are built from. */
export const parseServerConfig = (
  name: string,
  raw: unknown
): Parsed<McpServerConfig> => {
  const fail = (message: string): Parsed<McpServerConfig> => ({
    error: `server "${name}": ${message}`,
  });

  if (!SERVER_NAME.test(name)) {
    return {
      error: `invalid server name "${name}" (use letters, digits, "_" and "-")`,
    };
  }

  const fields = transportFields.safeParse(raw);

  if (!fields.success) {
    return fail("must be an object");
  }

  if (fields.data.type === "sse") {
    return fail(
      "the legacy SSE transport is not supported; use the streamable HTTP URL"
    );
  }

  const schema = schemaFor(fields.data);

  if (schema === undefined) {
    return fail('needs either "command" (stdio) or "url" (streamable HTTP)');
  }

  const parsed = schema.safeParse(raw);

  return parsed.success
    ? { value: parsed.data }
    : fail(firstIssue(parsed.error));
};
