import { serverExposure } from "../config/exposure.ts";
import type { ServerEntry } from "../config/load.ts";
import { isHttpConfig } from "../config/schema.ts";
import type { ServerConnection } from "../connection/connection.ts";

/** What status text needs of a server. */
export interface ServerStatus {
  readonly entry: ServerEntry;
  readonly connection?: ServerConnection | undefined;
}

export const isEnabled = (entry: ServerEntry): boolean =>
  entry.config.enabled !== false;

export const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

/** Short state for lists and reports. `withError` appends the first line of a failure. */
export const describeState = (
  server: ServerStatus,
  withError = true
): string => {
  const { connection } = server;

  if (!isEnabled(server.entry)) {
    return "disabled";
  }

  switch (connection?.state) {
    case undefined: {
      return "starting";
    }

    case "needs-auth": {
      return "needs sign-in";
    }

    case "failed": {
      return withError
        ? `failed: ${firstLine(connection.error ?? "unknown error")}`
        : "failed";
    }

    case "connected": {
      const count = connection.tools.length;

      return `connected · ${count} tool${count === 1 ? "" : "s"}${connection.hasResources ? " · resources" : ""}`;
    }

    case "connecting": {
      return "connecting…";
    }

    case "disconnected": {
      return "disconnected, reconnects on next call";
    }

    case "closed": {
      return "closed";
    }
  }
};

/** The negotiated protocol version, marked when it is the stateless 2026-07-28 era. */
export const describeProtocol = (server: ServerStatus): string | undefined => {
  const version = server.connection?.protocolVersion;

  if (version === undefined || version === "") {
    return undefined;
  }

  return server.connection?.era === "modern"
    ? `${version} (stateless)`
    : version;
};

/** A server's status as one line of plain text, with its full error indented below. */
export const statusLine = (server: ServerStatus): string => {
  const { name } = server.entry;
  const exposure = serverExposure(server.entry.config);
  const { connection } = server;

  if (connection?.state === "needs-auth") {
    return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
  }

  const protocol = describeProtocol(server);

  const failure =
    connection?.state === "connected" ? undefined : connection?.error;

  const error =
    failure === undefined || failure === ""
      ? ""
      : `\n    ${failure.split("\n").join("\n    ")}`;

  return `${name}: ${describeState(server, false)}${protocol === undefined ? "" : `, protocol ${protocol}`} (${exposure})${error}`;
};

/** Servers that need the user sort first. */
export const attentionRank = (server: ServerStatus): number => {
  if (!isEnabled(server.entry)) {
    return 5;
  }

  switch (server.connection?.state) {
    case "needs-auth": {
      return 0;
    }

    case "failed": {
      return 1;
    }

    case "disconnected": {
      return 2;
    }

    case "connected": {
      return 4;
    }

    case "connecting":
    case "closed":
    case undefined: {
      return 3;
    }
  }
};

/** The URL or command line of a server. */
export const describeTransport = (entry: ServerEntry): string => {
  const { config } = entry;

  return isHttpConfig(config)
    ? config.url
    : [config.command, ...(config.args ?? [])].join(" ");
};
