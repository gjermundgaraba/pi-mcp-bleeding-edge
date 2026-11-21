import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { serverExposure } from "../config/exposure.ts";
import { openUrl } from "../open-url.ts";
import { reconnectServer, usesOAuth } from "../session/controller.ts";
import type { McpSession, ServerSlot } from "../session/controller.ts";
import { describeState, isEnabled } from "../session/status.ts";
import { manageServers, signInWithUi } from "./menus.ts";
import { showMcpManager } from "./view.ts";

/** Description of the `/mcp` command. */
export const MCP_COMMAND_DESCRIPTION =
  "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure";

const USAGE =
  "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

const SUBCOMMANDS = ["login", "logout", "reconnect"] as const;

interface Pick {
  readonly eligible: (slot: ServerSlot) => boolean;
  readonly preferred: (slot: ServerSlot) => boolean;
  readonly none: string;
}

const OAUTH_PICK: Pick = {
  eligible: (slot) => usesOAuth(slot),
  preferred: (slot) => slot.connection?.state === "needs-auth",
  none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
};

const stateLine = (slot: ServerSlot): string => {
  if (!isEnabled(slot.entry)) {
    return "disabled";
  }

  const state = slot.connection?.state;

  if (state === "disconnected") {
    return "disconnected, reconnects on next call";
  }

  return state ?? "starting";
};

const reconnectPick: Pick = {
  eligible: (slot) => slot.connection !== undefined,
  preferred: (slot) =>
    slot.connection?.state === "failed" ||
    slot.connection?.state === "disconnected",
  none: "No enabled MCP server to reconnect.",
};

/** Server status as plain text, for modes without the TUI. */
const formatStatus = (session: McpSession): string => {
  const notices = session.notices();

  if (session.servers.length === 0 && notices.length === 0) {
    return `No MCP servers configured. Add them to ${session.paths.globalConfig} or .pi/mcp.json.`;
  }

  const lines = session.servers.map((slot) => {
    const { name } = slot.entry;
    const exposure = serverExposure(slot.entry.config);
    const { connection } = slot;

    if (connection?.state === "needs-auth") {
      return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
    }

    const tools =
      connection?.state === "connected"
        ? `, ${connection.tools.length} tools`
        : "";

    const protocol =
      connection?.protocolVersion === undefined
        ? ""
        : `, protocol ${connection.protocolVersion}`;

    const failure =
      connection?.state === "connected" ? undefined : connection?.error;

    const error =
      failure === undefined || failure === ""
        ? ""
        : `\n    ${failure.split("\n").join("\n    ")}`;

    return `${name}: ${stateLine(slot)}${tools}${protocol} (${exposure})${error}`;
  });

  return [...lines, ...notices].join("\n");
};

/** The server a subcommand names, asking when the name is omitted and several qualify. */
const pickServer = async (
  session: McpSession,
  name: string | undefined,
  ctx: ExtensionCommandContext,
  pick: Pick
): Promise<ServerSlot | undefined> => {
  if (name !== undefined && name !== "") {
    const slot = session.find(name);

    if (slot === undefined) {
      ctx.ui.notify(`No MCP server named "${name}".`, "error");
    } else if (!pick.eligible(slot)) {
      ctx.ui.notify(pick.none, "error");
    }

    return slot !== undefined && pick.eligible(slot) ? slot : undefined;
  }

  const candidates = session.servers.filter((slot) => pick.eligible(slot));

  if (candidates.length === 0) {
    ctx.ui.notify(pick.none, "info");

    return undefined;
  }

  const preferred = candidates.filter((slot) => pick.preferred(slot));

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (preferred.length === 1) {
    return preferred[0];
  }

  const choice = await ctx.ui.select(
    "MCP server",
    candidates.map((slot) => slot.entry.name)
  );

  return candidates.find((slot) => slot.entry.name === choice);
};

const login = async (
  session: McpSession,
  slot: ServerSlot,
  ctx: ExtensionCommandContext
): Promise<void> => {
  const { name } = slot.entry;

  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Signing in to MCP server "${name}" requires interactive mode.`,
      "error"
    );

    return;
  }

  const signal = session.sessionSignal;
  let failure: string | undefined;

  if (ctx.mode === "tui") {
    await showMcpManager(ctx, async (ui) => {
      failure = await signInWithUi(ui, session, slot);
    });
  } else {
    failure = await session.signIn(slot, {
      showAuthorizationUrl: (url) => {
        ctx.ui.notify(
          `Sign in to MCP server "${name}" in your browser:\n${url.href}`,
          "info"
        );
        openUrl(url.href);
      },
      promptForRedirectUrl: async (promptSignal) =>
        await ctx.ui.input(
          `Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
          "http://127.0.0.1:.../callback?code=...",
          { signal: promptSignal }
        ),
    });
  }

  if (signal.aborted) {
    return;
  }

  if (failure !== undefined) {
    ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");

    return;
  }

  session.ensureDiscoveryActive(ctx);
  ctx.ui.notify(
    `Signed in to MCP server "${name}" (${slot.connection?.tools.length ?? 0} tools).`,
    "info"
  );
};

const logout = async (
  session: McpSession,
  slot: ServerSlot,
  ctx: ExtensionCommandContext
): Promise<void> => {
  const removed = await session.signOut(slot);
  ctx.ui.notify(
    removed
      ? `Signed out of MCP server "${slot.entry.name}".`
      : `No stored credentials for MCP server "${slot.entry.name}".`,
    "info"
  );
};

const reconnect = async (
  session: McpSession,
  slot: ServerSlot,
  ctx: ExtensionCommandContext
): Promise<void> => {
  const failure = await reconnectServer(slot);

  if (failure !== undefined) {
    ctx.ui.notify(failure, "error");

    return;
  }

  session.ensureDiscoveryActive(ctx);
  ctx.ui.notify(
    `Reconnected to MCP server "${slot.entry.name}" (${describeState(slot)}).`,
    "info"
  );
};

/** `/mcp`: the manager in the TUI, status text elsewhere, and the `login`, `logout`, `reconnect` subcommands. */
export const runMcpCommand = async (
  session: McpSession,
  args: string,
  ctx: ExtensionCommandContext
): Promise<void> => {
  const [action, name, ...extra] = args
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");

  if (action === undefined) {
    if (ctx.mode === "tui") {
      await showMcpManager(ctx, async (ui) => {
        await manageServers(ui, ctx, session);
      });

      return;
    }

    await session.whenStarted();
    ctx.ui.notify(formatStatus(session), "info");

    return;
  }

  if (extra.length > 0) {
    ctx.ui.notify(USAGE, "warning");

    return;
  }

  await session.whenStarted();

  switch (action) {
    case "login": {
      const slot = await pickServer(session, name, ctx, OAUTH_PICK);

      if (slot !== undefined) {
        await login(session, slot, ctx);
      }

      return;
    }

    case "logout": {
      const slot = await pickServer(session, name, ctx, OAUTH_PICK);

      if (slot !== undefined) {
        await logout(session, slot, ctx);
      }

      return;
    }

    case "reconnect": {
      const slot = await pickServer(session, name, ctx, reconnectPick);

      if (slot !== undefined) {
        await reconnect(session, slot, ctx);
      }

      return;
    }

    default: {
      ctx.ui.notify(USAGE, "warning");
    }
  }
};

/** Completions of the subcommands and of the servers they apply to. */
export const completeMcpCommand = (
  session: McpSession,
  prefix: string
): AutocompleteItem[] | null => {
  const [action, server, ...rest] = prefix.trimStart().split(/\s+/u);

  if (rest.length > 0) {
    return null;
  }

  if (server === undefined) {
    return SUBCOMMANDS.flatMap((item) =>
      item.startsWith(action ?? "") ? [{ value: `${item} `, label: item }] : []
    );
  }

  if (action !== "login" && action !== "logout" && action !== "reconnect") {
    return null;
  }

  const applies = (slot: ServerSlot): boolean =>
    (action === "reconnect"
      ? slot.connection !== undefined
      : usesOAuth(slot)) && slot.entry.name.startsWith(server);

  const items = session.servers.flatMap((slot) =>
    applies(slot)
      ? [
          {
            value: `${action} ${slot.entry.name}`,
            label: slot.entry.name,
            description: describeState(slot),
          },
        ]
      : []
  );

  return items.length > 0 ? items : null;
};
