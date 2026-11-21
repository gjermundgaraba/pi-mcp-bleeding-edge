import path from "node:path";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthProvider, Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { ServerEntry } from "../config/load.ts";
import { isHttpConfig } from "../config/schema.ts";
import { expandHome, resolveConfigValues } from "../config/values.ts";

/** Opens the transport of a server. Tests replace it to reach servers in memory. */
export type TransportFactory = (
  entry: ServerEntry,
  cwd: string,
  auth: AuthProvider | undefined
) => Transport;

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]]
    )
  );

/**
 * Streamable HTTP for `url` servers, with resolved headers and the connection's auth provider;
 * a 403 asking for more scope is reported instead of re-authorizing, since sign-in is the user's.
 * Stdio for `command` servers, in pi's environment plus the resolved `env`, with `~` expanded
 * and a relative `cwd` resolved against the session's directory.
 */
export const createTransport: TransportFactory = (entry, cwd, auth) => {
  const { config, name } = entry;

  if (isHttpConfig(config)) {
    const headers = resolveConfigValues(
      config.headers,
      (key) => `MCP server "${name}" header "${key}"`
    );

    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
      onInsufficientScope: "throw",
      ...(auth ? { authProvider: auth } : {}),
    });
  }

  const env = resolveConfigValues(
    config.env,
    (key) => `MCP server "${name}" env "${key}"`
  );

  return new StdioClientTransport({
    command: expandHome(config.command),
    args: (config.args ?? []).map(expandHome),
    cwd: path.resolve(cwd, expandHome(config.cwd ?? ".")),
    env: { ...inheritedEnvironment(), ...env },
    stderr: "pipe",
  });
};
