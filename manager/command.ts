import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { openUrl } from "../open-url.ts";
import { usesOAuth } from "../session/controller.ts";
import type { McpSession, ServerSlot } from "../session/controller.ts";
import { describeState, statusLine } from "../session/status.ts";
import { manageServers, signInWithUi } from "./menus.ts";
import { showMcpManager } from "./view.ts";

/** Description of the `/mcp` command. */
export const MCP_COMMAND_DESCRIPTION =
  "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure";

const USAGE =
  "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

/** A subcommand acting on one server. */
interface Subcommand {
  /** Servers it applies to. */
  readonly eligible: (slot: ServerSlot) => boolean;
  /** Among eligible servers, the one to pick when it is the only such one. */
  readonly preferred: (slot: ServerSlot) => boolean;
  /** What to say when no server is eligible. */
  readonly none: string;
  readonly run: (
    session: McpSession,
    slot: ServerSlot,
    ctx: ExtensionCommandContext
  ) => Promise<void>;
}

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

const OAUTH = {
  eligible: usesOAuth,
  preferred: (slot: ServerSlot) => slot.connection?.state === "needs-auth",
  none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
};

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  login: { ...OAUTH, run: login },
  logout: {
    ...OAUTH,
    run: async (session, slot, ctx) => {
      const removed = await session.signOut(slot);

      ctx.ui.notify(
        removed
          ? `Signed out of MCP server "${slot.entry.name}".`
          : `No stored credentials for MCP server "${slot.entry.name}".`,
        "info"
      );
    },
  },
  reconnect: {
    eligible: (slot) => slot.connection !== undefined,
    preferred: (slot) =>
      slot.connection?.state === "failed" ||
      slot.connection?.state === "disconnected",
    none: "No enabled MCP server to reconnect.",
    run: async (session, slot, ctx) => {
      const failure = await session.registry.reconnect(slot);

      if (failure !== undefined) {
        ctx.ui.notify(failure, "error");

        return;
      }

      session.ensureDiscoveryActive(ctx);
      ctx.ui.notify(
        `Reconnected to MCP server "${slot.entry.name}" (${describeState(slot)}).`,
        "info"
      );
    },
  },
};

/** Server status as plain text, for modes without the TUI. */
const formatStatus = (session: McpSession): string => {
  const { registry } = session;
  const notices = registry.notices();

  if (registry.servers.length === 0 && notices.length === 0) {
    return `No MCP servers configured. Add them to ${registry.paths.globalConfig} or .pi/mcp.json.`;
  }

  return [...registry.servers.map(statusLine), ...notices].join("\n");
};

/** The server a subcommand names, asking when the name is omitted and several qualify. */
const pickServer = async (
  session: McpSession,
  name: string | undefined,
  ctx: ExtensionCommandContext,
  subcommand: Subcommand
): Promise<ServerSlot | undefined> => {
  if (name !== undefined) {
    const slot = session.registry.find(name);

    if (slot === undefined) {
      ctx.ui.notify(`No MCP server named "${name}".`, "error");
    } else if (!subcommand.eligible(slot)) {
      ctx.ui.notify(subcommand.none, "error");
    }

    return slot !== undefined && subcommand.eligible(slot) ? slot : undefined;
  }

  const candidates = session.registry.servers.filter(subcommand.eligible);
  const preferred = candidates.filter(subcommand.preferred);

  if (candidates.length === 0) {
    ctx.ui.notify(subcommand.none, "info");

    return undefined;
  }

  if (candidates.length === 1 || preferred.length === 1) {
    return candidates.length === 1 ? candidates[0] : preferred[0];
  }

  const choice = await ctx.ui.select(
    "MCP server",
    candidates.map((slot) => slot.entry.name)
  );

  return candidates.find((slot) => slot.entry.name === choice);
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

  const subcommand = SUBCOMMANDS[action];

  if (subcommand === undefined || extra.length > 0) {
    ctx.ui.notify(USAGE, "warning");

    return;
  }

  await session.whenStarted();

  const slot = await pickServer(session, name, ctx, subcommand);

  if (slot !== undefined) {
    await subcommand.run(session, slot, ctx);
  }
};

/** Completions of the subcommands and of the servers they apply to. */
export const completeMcpCommand = (
  session: McpSession,
  prefix: string
): AutocompleteItem[] | null => {
  const [action = "", server, ...rest] = prefix.trimStart().split(/\s+/u);

  if (rest.length > 0) {
    return null;
  }

  if (server === undefined) {
    return Object.keys(SUBCOMMANDS).flatMap((item) =>
      item.startsWith(action) ? [{ value: `${item} `, label: item }] : []
    );
  }

  const subcommand = SUBCOMMANDS[action];

  const items = session.registry.servers.flatMap((slot) =>
    subcommand?.eligible(slot) === true && slot.entry.name.startsWith(server)
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
