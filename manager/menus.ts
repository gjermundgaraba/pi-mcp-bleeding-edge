import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

import { serverExposure, toolExposure } from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import { openUrl } from "../open-url.ts";
import { reconnectServer } from "../session/controller.ts";
import type { McpSession, ServerSlot } from "../session/controller.ts";
import {
  attentionRank,
  describeState,
  describeTransport,
  isEnabled,
} from "../session/status.ts";
import type { McpMenu, McpUi } from "./view.ts";

type ReachableExposure = Exclude<McpExposure, "hidden">;

const REACHABLE_EXPOSURES: readonly ReachableExposure[] = [
  "codemode",
  "deferred",
  "direct",
];

const EXPOSURE_DESCRIPTIONS: Readonly<Record<ReachableExposure, string>> = {
  codemode: "called from codemode scripts, which find them with searchTools()",
  deferred:
    "not declared until tool_search loads them, then called directly; no codemode needed",
  direct: "declared to the model like built-in tools",
};

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

const protocolLabel = (slot: ServerSlot): string | undefined => {
  const version = slot.connection?.protocolVersion;

  if (version === undefined || version === "") {
    return undefined;
  }

  return slot.connection?.era === "modern" ? `${version} (stateless)` : version;
};

const savedWhere = (slot: ServerSlot): string => {
  if (slot.entry.scope === "extension") {
    return "for this session";
  }

  return slot.entry.override === undefined
    ? `saved to the ${slot.entry.scope} mcp.json`
    : "saved to the project mcp.json";
};

const serversMenu = (session: McpSession): McpMenu => ({
  title: "MCP servers",
  error: session.notices().join("\n") || undefined,
  items: session.servers
    .toSorted(
      (a, b) =>
        attentionRank(a) - attentionRank(b) ||
        a.entry.name.localeCompare(b.entry.name)
    )
    .map((slot) => ({
      value: slot.entry.name,
      label: slot.entry.name,
      description: `${describeState(slot)} · ${serverExposure(slot.entry.config)} · ${slot.entry.override === undefined ? slot.entry.scope : "global, project override"}`,
    })),
  empty: `No MCP servers configured. Add them to ${session.paths.globalConfig} or .pi/mcp.json.`,
  confirmLabel: "manage",
  cancelLabel: "close",
});

const serverMenu = (session: McpSession, name: string): McpMenu => {
  const slot = session.find(name);

  if (!slot) {
    return {
      title: name,
      items: [],
      empty: "This server is no longer configured.",
      confirmLabel: "",
      cancelLabel: "back",
    };
  }

  const { entry, connection } = slot;

  const saved = savedWhere(slot);

  const inProject =
    entry.scope === "global" &&
    entry.override === undefined &&
    session.projectConfig !== undefined;

  const inProjectSaved = "saved to the project mcp.json";
  const items: SelectItem[] = [];

  if (isEnabled(entry)) {
    const state = connection?.state;

    if (state === "needs-auth") {
      items.push({
        value: "signin",
        label: "Sign in",
        description: "opens the browser",
      });
    }

    if (state === "connected" && connection) {
      items.push({
        value: "tools",
        label: "Tools",
        description: `${connection.tools.length} offered`,
      });
    }

    if (
      state === "failed" ||
      state === "disconnected" ||
      state === "connected" ||
      state === "needs-auth"
    ) {
      items.push({ value: "reconnect", label: "Reconnect" });
    }

    if (state === "connected" && connection?.oauthUrl !== undefined) {
      items.push({
        value: "signout",
        label: "Sign out",
        description: "deletes the stored credentials",
      });
    }

    items.push(
      {
        value: "exposure",
        label: "Exposure",
        description: serverExposure(entry.config),
      },
      { value: "disable", label: "Disable", description: saved }
    );

    if (inProject) {
      items.push({
        value: "disable-project",
        label: "Disable in this project",
        description: inProjectSaved,
      });
    }
  } else {
    items.push({ value: "enable", label: "Enable", description: saved });

    if (inProject) {
      items.push({
        value: "enable-project",
        label: "Enable in this project",
        description: inProjectSaved,
      });
    }
  }

  const protocol = protocolLabel(slot);

  const details = [
    describeTransport(entry),
    `${entry.scope}: ${entry.source}`,
    ...(entry.override === undefined
      ? []
      : [`project override: ${entry.override}`]),
    `State: ${describeState(slot, false)}`,
    ...(protocol === undefined ? [] : [`Protocol: ${protocol}`]),
  ];

  const error = [
    slot.message,
    connection?.state === "connected" ? undefined : connection?.error,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return {
    title: `MCP server ${name}`,
    details: details.join("\n"),
    error: error || undefined,
    items,
    selected: items[0]?.value,
    confirmLabel: "select",
    cancelLabel: "back",
  };
};

const showTools = async (ui: McpUi, slot: ServerSlot): Promise<void> => {
  const exposure = serverExposure(slot.entry.config);

  const overridden =
    Object.keys(slot.entry.config.toolExposure ?? {}).length > 0;

  const reach =
    exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure];

  await ui.menu(() => ({
    title: `Tools of ${slot.entry.name}`,
    details: `Exposure ${exposure}: ${reach}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
    items: (slot.connection?.tools ?? []).map((tool) => {
      const own = toolExposure(slot.entry.config, tool.name);
      const description = firstLine(tool.description ?? "");

      return {
        value: tool.name,
        label: tool.name,
        description: own === exposure ? description : `[${own}] ${description}`,
      };
    }),
    empty: "The server offers no tools.",
    confirmLabel: "back",
    cancelLabel: "back",
  }));
};

const chooseExposure = async (
  ui: McpUi,
  session: McpSession,
  slot: ServerSlot
): Promise<string | undefined> => {
  const current = serverExposure(slot.entry.config);
  const exposures = REACHABLE_EXPOSURES;

  const choice = await ui.menu(() => ({
    title: `Exposure of ${slot.entry.name}`,
    details:
      slot.entry.scope === "extension"
        ? `Applies to this session; the server is registered by ${slot.entry.source}.`
        : `Saved to ${slot.entry.override ?? slot.entry.source}.`,
    items: exposures.map((exposure) => ({
      value: exposure,
      label: `${exposure === current ? "✓ " : "  "}${exposure}`,
      description: EXPOSURE_DESCRIPTIONS[exposure],
    })),
    selected: current,
    confirmLabel: "save",
    cancelLabel: "back",
  }));

  const exposure = exposures.find((candidate) => candidate === choice);

  if (!exposure || exposure === current) {
    return undefined;
  }

  return await session.setExposure(slot, exposure);
};

/** Sign in on the manager's sign-in screen, which shows the URL with a copy key and cancels with Esc. */
export const signInWithUi = async (
  ui: McpUi,
  session: McpSession,
  slot: ServerSlot
): Promise<string | undefined> => {
  const title = `Sign in to ${slot.entry.name}`;
  const cancel = new AbortController();

  const status = (message: string) => {
    ui.status(title, message, () => {
      cancel.abort();
    });
  };

  let authorizationUrl = "";
  status("Contacting the authorization server…");

  return await session.signIn(
    slot,
    {
      showAuthorizationUrl: (url) => {
        authorizationUrl = url.href;
        openUrl(url.href);
      },
      promptForRedirectUrl: async (signal) => {
        const value = await ui.redirectUrl(title, authorizationUrl, signal);
        status("Connecting…");

        return value;
      },
    },
    cancel.signal
  );
};

const runAction = async (
  ui: McpUi,
  ctx: ExtensionContext,
  session: McpSession,
  slot: ServerSlot,
  action: string
): Promise<void> => {
  let message: string | undefined;

  switch (action) {
    case "signin": {
      message = await signInWithUi(ui, session, slot);
      break;
    }

    case "reconnect": {
      session.runInBackground(ctx, slot, async () => {
        await reconnectServer(slot);

        return undefined;
      });
      break;
    }

    case "signout": {
      await session.signOut(slot);
      break;
    }

    case "tools": {
      await showTools(ui, slot);
      break;
    }

    case "exposure": {
      message = await chooseExposure(ui, session, slot);
      break;
    }

    case "enable":
    case "disable":
    case "enable-project":
    case "disable-project": {
      const enable = action.startsWith("enable");
      session.runInBackground(
        ctx,
        slot,
        async () =>
          await session.setEnabled(slot, enable, action.endsWith("-project"))
      );
      break;
    }

    default: {
      return;
    }
  }

  session.settleAction(ctx, slot, message);
};

/** The manager's flow: the server list, then one server's actions, until closed. */
export const manageServers = async (
  ui: McpUi,
  ctx: ExtensionContext,
  session: McpSession
): Promise<void> => {
  const subscribe = (listener: () => void) => session.subscribe(listener);

  for (;;) {
    const name = await ui.menu(() => serversMenu(session), subscribe);

    if (name === undefined || name === "") {
      return;
    }

    for (;;) {
      const action = await ui.menu(() => serverMenu(session, name), subscribe);
      const slot = session.find(name);

      if (action === undefined || action === "" || slot === undefined) {
        break;
      }

      await runAction(ui, ctx, session, slot, action);
    }
  }
};
