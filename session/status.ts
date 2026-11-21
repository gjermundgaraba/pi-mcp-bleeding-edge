import type { ServerEntry } from "../config/load.ts";
import { isHttpConfig } from "../config/schema.ts";
import type { ConnectionState } from "../connection/connection.ts";

/** What status lines need of a server. */
export interface ServerStatus {
  readonly entry: ServerEntry;
  readonly connection?:
    | {
        readonly state: ConnectionState;
        readonly error: string | undefined;
        readonly tools: readonly unknown[];
        readonly hasResources: boolean;
        readonly protocolVersion: string | undefined;
      }
    | undefined;
}

export const isEnabled = (entry: ServerEntry): boolean =>
  entry.config.enabled !== false;

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

/** Short state for lists and reports. `withError` appends the first line of a failure. */
export const describeState = (
  server: ServerStatus,
  withError = true
): string => {
  if (!isEnabled(server.entry)) {
    return "disabled";
  }

  const { connection } = server;

  if (!connection) {
    return "starting";
  }

  switch (connection.state) {
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
      const resources = connection.hasResources ? " · resources" : "";

      return `connected · ${count} tool${count === 1 ? "" : "s"}${resources}`;
    }

    case "connecting": {
      return "connecting…";
    }

    case "disconnected":
    case "closed": {
      return connection.state;
    }
  }
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
